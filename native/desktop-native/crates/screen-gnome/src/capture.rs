use crate::{
    error::{Error, Result},
    portal::Monitor,
};
use gstreamer::{self as gst, prelude::*};
use gstreamer_app as gst_app;
use gstreamer_video as video;
use std::{
    os::fd::{AsRawFd, OwnedFd},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

const MAX_BYTES: usize = 128 * 1024 * 1024;

pub struct Pixels {
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    pub bytes: Vec<u8>,
}

impl Pixels {
    fn from_sample(sample: &gst::Sample) -> Result<Self> {
        let caps = sample
            .caps()
            .ok_or_else(|| Error::capture("Missing negotiated video caps."))?;
        let info = video::VideoInfo::from_caps(caps).map_err(Error::capture)?;
        let buffer = sample
            .buffer()
            .ok_or_else(|| Error::capture("Missing desktop frame."))?;
        if info.format() != video::VideoFormat::Bgra || info.n_planes() != 1 {
            return Err(Error::capture(
                "The desktop stream did not negotiate packed BGRA.",
            ));
        }
        let (width, height) = (info.width(), info.height());
        let (offset, stride) = match buffer.meta::<video::VideoMeta>() {
            Some(meta)
                if meta.format() == info.format()
                    && meta.width() == width
                    && meta.height() == height
                    && meta.n_planes() == 1 =>
            {
                (meta.offset()[0], meta.stride()[0])
            }
            Some(_) => {
                return Err(Error::capture(
                    "Video metadata differs from the negotiated caps.",
                ));
            }
            None => (info.offset()[0], info.stride()[0]),
        };
        let length = frame::bgra_len(width, height, stride.unsigned_abs() as usize)
            .map_err(Error::capture)?;
        if buffer.size() > MAX_BYTES || offset > buffer.size() {
            return Err(Error::capture("The desktop buffer is too large."));
        }
        let map = buffer.map_readable().map_err(Error::capture)?;
        if stride > 0
            && let Some(data) = offset
                .checked_add(length)
                .and_then(|end| map.get(offset..end))
        {
            return Ok(Self {
                width,
                height,
                stride: stride as usize,
                bytes: data.to_vec(),
            });
        }
        // Some producers omit trailing padding or store their first logical row at the end.
        let packed = width as usize * 4;
        let mut bytes = Vec::with_capacity(packed * height as usize);
        for y in 0..height {
            let start = usize::try_from(offset as i64 + i64::from(y) * i64::from(stride))
                .map_err(|_| Error::capture("Invalid desktop row offset."))?;
            let row = start
                .checked_add(packed)
                .and_then(|end| map.get(start..end))
                .ok_or_else(|| Error::capture("The desktop buffer ends inside a row."))?;
            bytes.extend_from_slice(row);
        }
        Ok(Self {
            width,
            height,
            stride: packed,
            bytes,
        })
    }
}

fn bounded_caps(bgra: bool) -> gst::Caps {
    let dimension = gst::IntRange::<i32>::new(1, 16_384);
    let mut caps = gst::Caps::builder("video/x-raw")
        .field("width", dimension)
        .field("height", dimension);
    if bgra {
        caps = caps.field("format", "BGRA");
    }
    caps.build()
}

fn fits(caps: &gst::CapsRef) -> bool {
    video::VideoInfo::from_caps(caps).is_ok_and(|v| {
        v.size() <= MAX_BYTES
            && frame::bgra_len(v.width(), v.height(), v.width() as usize * 4).is_ok()
    })
}

fn bound_converter_input(convert: &gst::Element) -> Result<Arc<AtomicBool>> {
    let rejected = Arc::new(AtomicBool::new(false));
    let oversized = rejected.clone();
    let sink = convert
        .static_pad("sink")
        .ok_or_else(|| Error::capture("Missing converter input."))?;
    // Width and height are independent GStreamer ranges. Check their product on fixed caps before conversion allocates.
    sink.add_probe(
        gst::PadProbeType::QUERY_DOWNSTREAM
            | gst::PadProbeType::EVENT_DOWNSTREAM
            | gst::PadProbeType::BUFFER,
        move |_, info| {
            if let Some(q) = info.query_mut()
                && let gst::QueryViewMut::AcceptCaps(accept) = q.view_mut()
                && !fits(accept.caps())
            {
                accept.set_result(false);
                return gst::PadProbeReturn::Handled;
            }
            if info
                .event()
                .is_some_and(|e| matches!(e.view(), gst::EventView::Caps(c) if !fits(c.caps())))
                || info.buffer().is_some_and(|b| b.size() > MAX_BYTES)
            {
                oversized.store(true, Ordering::Release);
                return gst::PadProbeReturn::Drop;
            }
            if info.buffer().is_some() && oversized.load(Ordering::Acquire) {
                return gst::PadProbeReturn::Drop;
            }
            gst::PadProbeReturn::Ok
        },
    )
    .ok_or_else(|| Error::capture("Could not bound the capture converter."))?;
    Ok(rejected)
}

struct Running(gst::Pipeline);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.set_state(gst::State::Null);
    }
}

struct Cancel(Arc<AtomicBool>);
impl Drop for Cancel {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

pub async fn capture(fd: OwnedFd, monitor: &Monitor) -> Result<Pixels> {
    let monitor = monitor.clone();
    let cancel = Cancel(Arc::default());
    let stop = cancel.0.clone();
    tokio::task::spawn_blocking(move || {
        gst::init().map_err(Error::capture)?;
        let source = gst::ElementFactory::make("pipewiresrc")
            .property("fd", fd.as_raw_fd())
            .property("num-buffers", 1_i32)
            .build()
            .map_err(Error::capture)?;
        if let Some(serial) = monitor.serial {
            if source.find_property("target-object").is_none() {
                return Err(Error::capture(
                    "PipeWire cannot target the granted stream serial.",
                ));
            }
            source.set_property("target-object", serial.to_string());
        } else {
            source.set_property("path", monitor.node.to_string());
        }
        // pipewiresrc borrows fd and duplicates it when entering PLAYING.
        pull(source, &stop)
    })
    .await
    .map_err(Error::capture)?
}

fn pull(source: gst::Element, stop: &AtomicBool) -> Result<Pixels> {
    let convert = gst::ElementFactory::make("videoconvert")
        .build()
        .map_err(Error::capture)?;
    let oversized = bound_converter_input(&convert)?;
    let sink = gst_app::AppSink::builder()
        .caps(&bounded_caps(true))
        .max_buffers(1)
        .wait_on_eos(false)
        .sync(false)
        .enable_last_sample(false)
        .build();
    let pipeline = Running(gst::Pipeline::new());
    pipeline
        .0
        .add_many([&source, &convert, sink.upcast_ref()])
        .map_err(Error::capture)?;
    source
        .link_filtered(&convert, &bounded_caps(false))
        .map_err(Error::capture)?;
    convert.link(&sink).map_err(Error::capture)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    pipeline
        .0
        .set_state(gst::State::Playing)
        .map_err(Error::capture)?;
    let bus = pipeline
        .0
        .bus()
        .ok_or_else(|| Error::capture("Missing capture pipeline bus."))?;
    while !stop.load(Ordering::Acquire) {
        if oversized.load(Ordering::Acquire) {
            return Err(Error::capture(
                "The negotiated desktop frame exceeds the capture limit.",
            ));
        }
        if let Some(sample) = sink.try_pull_sample(gst::ClockTime::from_mseconds(50)) {
            return Pixels::from_sample(&sample);
        }
        if let Some(message) = bus.pop_filtered(&[gst::MessageType::Error])
            && let gst::MessageView::Error(e) = message.view()
        {
            return Err(Error::capture(e.error()));
        }
        if sink.is_eos() {
            return Err(Error::capture("The stream ended without a frame."));
        }
        if Instant::now() >= deadline {
            return Err(Error::new(
                "timed-out",
                "The desktop stream did not produce a frame.",
            ));
        }
    }
    Err(Error::cancelled())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pipeline_converts_a_source_that_only_offers_rgbx() {
        gst::init().unwrap();
        for (width, height) in [(7680_i32, 4320_i32), (4320, 7680)] {
            let caps = gst::Caps::builder("video/x-raw")
                .field("width", width)
                .field("height", height)
                .field("format", "BGRA")
                .build();
            assert!(bounded_caps(true).can_intersect(&caps));
            assert!(fits(&caps));
        }
        let source = gst::parse::bin_from_description(
            "videotestsrc num-buffers=1 pattern=red ! capsfilter caps=video/x-raw,format=RGBx,width=8,height=4",
            true,
        )
        .unwrap();
        let pixels = pull(source.upcast(), &AtomicBool::new(false)).unwrap();
        assert_eq!((pixels.width, pixels.height), (8, 4));
        assert_eq!(&pixels.bytes[..4], &[0, 0, 255, 255]);
        let oversized = gst::Caps::builder("video/x-raw")
            .field("format", "RGBx")
            .field("width", 8192_i32)
            .field("height", 8192_i32)
            .build();
        assert!(!fits(&oversized));
        let source = gst_app::AppSrc::builder().caps(&oversized).build();
        source.push_buffer(gst::Buffer::new()).unwrap();
        source.end_of_stream().unwrap();
        assert!(pull(source.upcast(), &AtomicBool::new(false)).is_err());
    }
    #[test]
    fn sample_uses_negotiated_format_and_per_buffer_stride() {
        gst::init().unwrap();
        let caps = gst::Caps::builder("video/x-raw")
            .field("format", "BGRA")
            .field("width", 2_i32)
            .field("height", 2_i32)
            .field("framerate", gst::Fraction::new(1, 1))
            .build();
        let mut buf = gst::Buffer::from_mut_slice((0_u8..28).collect::<Vec<_>>());
        video::VideoMeta::add_full(
            buf.make_mut(),
            video::VideoFrameFlags::empty(),
            video::VideoFormat::Bgra,
            2,
            2,
            &[4],
            &[12],
        )
        .unwrap();
        let sample = gst::Sample::builder().caps(&caps).buffer(&buf).build();
        let pixels = Pixels::from_sample(&sample).unwrap();
        assert_eq!(pixels.stride, 12);
        assert_eq!(pixels.bytes, (4_u8..28).collect::<Vec<_>>());
        let rgb = gst::Caps::builder("video/x-raw")
            .field("format", "RGBx")
            .field("width", 2_i32)
            .field("height", 2_i32)
            .field("framerate", gst::Fraction::new(1, 1))
            .build();
        assert!(
            Pixels::from_sample(&gst::Sample::builder().caps(&rgb).buffer(&buf).build()).is_err()
        );
    }
}
