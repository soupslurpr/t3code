use crate::{
    bgra_len, encode,
    geometry::{self, MAX_DIMENSION, Rect},
    hash,
    model::*,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{borrow::Cow, collections::HashSet};

const BASE64_BUDGET: usize = 128 * 1024 * 1024;

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.trim() == value && value.encode_utf16().count() <= 128
}

fn validate_options(options: &ScreenshotOptions, has_display: bool) -> Result<(), FrameError> {
    if has_display && options.region.is_some() {
        return Err(FrameError(
            "omit displayId when a region selects the display",
        ));
    }
    if [options.max_width, options.max_height]
        .into_iter()
        .flatten()
        .any(|v| !(1..=MAX_DIMENSION).contains(&v))
    {
        return Err(FrameError("output dimensions must be between 1 and 4096"));
    }
    if let Encoding::Webp(WebpMode::NearLossless { quality } | WebpMode::Lossy { quality }) =
        options.encoding
        && !(1..=100).contains(&quality)
    {
        return Err(FrameError("WebP quality must be between 1 and 100"));
    }
    if options
        .unchanged_if_content_hash
        .as_deref()
        .is_some_and(|s| !hash::valid_hash(s))
    {
        return Err(FrameError("invalid unchangedIfContentHash"));
    }
    Ok(())
}

fn validate(request: &CaptureRequest) -> Result<Option<&ScreenshotOptions>, FrameError> {
    let display = &request.display;
    if ![&request.desktop_id, &request.frame_id, &display.id]
        .into_iter()
        .all(|s| valid_id(s))
    {
        return Err(FrameError("invalid desktop, display or frame id"));
    }
    const SAFE_INT: i64 = (1 << 53) - 1;
    for (origin, size) in [
        (display.bounds.x, display.bounds.width),
        (display.bounds.y, display.bounds.height),
    ] {
        if size == 0 || !(-SAFE_INT..=SAFE_INT - i64::from(size)).contains(&origin) {
            return Err(FrameError("invalid display bounds"));
        }
    }
    if !display.scale_factor.is_finite() || display.scale_factor <= 0.0 {
        return Err(FrameError("invalid display scale factor"));
    }
    if request
        .pointer
        .is_some_and(|p| !p.x.is_finite() || !p.y.is_finite())
    {
        return Err(FrameError("invalid desktop pointer"));
    }
    if request.source_frames.len() > 256 {
        return Err(FrameError("too many source frames"));
    }
    let mut frame_ids = HashSet::new();
    for frame in &request.source_frames {
        let t = frame.to_desktop_logical;
        if !valid_id(&frame.id)
            || !valid_id(&frame.display_id)
            || !frame_ids.insert(&frame.id)
            || frame.width == 0
            || frame.height == 0
            || t.scale_x <= 0.0
            || t.scale_y <= 0.0
            || ![t.offset_x, t.offset_y, t.scale_x, t.scale_y]
                .into_iter()
                .all(f64::is_finite)
        {
            return Err(FrameError("invalid or duplicate source frame"));
        }
    }
    let opts = &request.options;
    if opts.display_id.as_ref().is_some_and(|id| id != &display.id) {
        return Err(FrameError("requested display differs from the capture"));
    }
    if opts.delay_ms.is_some_and(|ms| ms > 5000) {
        return Err(FrameError("invalid observation delay"));
    }
    let primary = match &opts.screenshot {
        PrimaryScreenshot::Options(view) => {
            validate_options(view, opts.display_id.is_some())?;
            Some(view)
        }
        PrimaryScreenshot::Flag(false) => None,
        PrimaryScreenshot::Flag(true) => {
            return Err(FrameError("screenshot must be false or options"));
        }
    };
    if let Some(details) = &opts.detail_screenshots {
        if !(1..=8).contains(&details.len()) {
            return Err(FrameError("expected one through eight detail screenshots"));
        }
        let mut ids = HashSet::new();
        for detail in details {
            if !valid_id(&detail.id)
                || !ids.insert(&detail.id)
                || detail
                    .purpose
                    .as_ref()
                    .is_some_and(|p| p.encode_utf16().count() > 512)
            {
                return Err(FrameError("invalid or duplicate detail screenshot"));
            }
            validate_options(&detail.options, opts.display_id.is_some())?;
        }
    } else if primary.is_none() && opts.include_accessibility == Some(false) {
        return Err(FrameError(
            "observation must include images or accessibility",
        ));
    }
    Ok(primary)
}

struct Sample {
    low: usize,
    high: usize,
    weight: f64,
}

fn sample(origin: u32, extent: u32, scale: f64, i: u32) -> Sample {
    let last = origin + extent - 1;
    let pos = (f64::from(origin) + (f64::from(i) + 0.5) * scale - 0.5)
        .clamp(f64::from(origin), f64::from(last));
    let low = pos.floor() as usize;
    Sample {
        low,
        high: (low + 1).min(last as usize),
        weight: pos - low as f64,
    }
}

fn blend(a: f64, b: f64, weight: f64) -> f64 {
    a * (1.0 - weight) + b * weight
}

fn view_pixels<'a>(bgra: &'a [u8], stride: usize, rect: Rect, frame: &Frame) -> Cow<'a, [u8]> {
    let row_bytes = frame.width as usize * 4;
    let len = row_bytes * frame.height as usize;
    if frame.width == rect.width && frame.height == rect.height {
        let offset = rect.y as usize * stride + rect.x as usize * 4;
        if stride == row_bytes || rect.height == 1 {
            return Cow::Borrowed(&bgra[offset..offset + len]);
        }
        let mut pixels = Vec::with_capacity(len);
        for row in 0..rect.height as usize {
            let start = offset + row * stride;
            pixels.extend_from_slice(&bgra[start..start + row_bytes]);
        }
        return Cow::Owned(pixels);
    }
    let sx = f64::from(rect.width) / f64::from(frame.width);
    let sy = f64::from(rect.height) / f64::from(frame.height);
    let columns: Vec<_> = (0..frame.width)
        .map(|x| sample(rect.x, rect.width, sx, x))
        .collect();
    let mut pixels = Vec::with_capacity(len);
    for y in 0..frame.height {
        let row = sample(rect.y, rect.height, sy, y);
        let top = &bgra[row.low * stride..][..stride];
        let bottom = &bgra[row.high * stride..][..stride];
        for column in &columns {
            let (left, right) = (column.low * 4, column.high * 4);
            for c in 0..4 {
                let a = blend(top[left + c].into(), top[right + c].into(), column.weight);
                let b = blend(
                    bottom[left + c].into(),
                    bottom[right + c].into(),
                    column.weight,
                );
                pixels.push(blend(a, b, row.weight).round() as u8);
            }
        }
    }
    Cow::Owned(pixels)
}

fn mark_pointer(pixels: &mut [u8], frame: &Frame, point: Point) {
    let cx = point.x.round() as i32;
    let cy = point.y.round() as i32;
    for y in (cy - 10).max(0)..=(cy + 10).min(frame.height as i32 - 1) {
        for x in (cx - 10).max(0)..=(cx + 10).min(frame.width as i32 - 1) {
            let d = (x - cx).pow(2) + (y - cy).pow(2);
            let color = match d {
                0..=4 => [48, 48, 255, 255],
                49..=100 => [0, 230, 255, 255],
                _ => continue,
            };
            let offset = (y as usize * frame.width as usize + x as usize) * 4;
            pixels[offset..offset + 4].copy_from_slice(&color);
        }
    }
}

fn screenshot(
    desktop_id: &str,
    legacy_display_id: Option<&str>,
    frame: &Frame,
    options: &ScreenshotOptions,
    pixels: &[u8],
    remaining_base64_bytes: &mut usize,
) -> Result<Screenshot, FrameError> {
    let content_hash = hash::content_hash(
        desktop_id,
        &frame.display_id,
        frame,
        options.encoding,
        pixels,
    );
    let (width, height) = (frame.width, frame.height);
    if options.unchanged_if_content_hash.as_ref() == Some(&content_hash) {
        return Ok(Screenshot::Unchanged {
            content_hash,
            width,
            height,
        });
    }
    let matched_legacy_content_hash = legacy_display_id
        .zip(options.unchanged_if_content_hash.as_ref())
        .and_then(|(id, expected)| {
            let hash = hash::content_hash("user", id, frame, options.encoding, pixels);
            (hash == *expected).then_some(hash)
        });
    let (mime, bytes) = encode::encode(
        width,
        height,
        pixels,
        options.encoding,
        *remaining_base64_bytes / 4 * 3,
    )?;
    let data = STANDARD.encode(&bytes);
    *remaining_base64_bytes -= data.len();
    Ok(Screenshot::Image {
        matched_legacy_content_hash,
        content_hash,
        width,
        height,
        mime_type: mime.to_owned(),
        encoding: options.encoding,
        size_bytes: bytes.len(),
        data,
    })
}

pub(crate) fn render_bgra(
    width: u32,
    height: u32,
    stride: usize,
    bgra: &[u8],
    request: &CaptureRequest,
) -> Result<CaptureOutput, FrameError> {
    if bgra_len(width, height, stride)? != bgra.len() {
        return Err(FrameError("BGRA byte length differs from stride * height"));
    }
    let primary = validate(request)?;
    let prepare = |options: &ScreenshotOptions, id| {
        geometry::prepare_view(width, height, request, options, id)
    };
    let primary = primary
        .map(|opts| Ok((opts, prepare(opts, request.frame_id.clone())?)))
        .transpose()?;
    let details = request
        .options
        .detail_screenshots
        .as_deref()
        .unwrap_or_default();
    let details = details
        .iter()
        .enumerate()
        .map(|(index, detail)| {
            let id = hash::detail_frame_id(&request.frame_id, index + 1);
            Ok((detail, prepare(&detail.options, id)?))
        })
        .collect::<Result<Vec<_>, FrameError>>()?;

    let mut budget = BASE64_BUDGET;
    let mut render = |options: &ScreenshotOptions, (rect, frame): (Rect, Frame)| {
        let mut pixels = view_pixels(bgra, stride, rect, &frame);
        let position = request
            .pointer
            .and_then(|p| geometry::pointer_position(&frame, p));
        if let Some(point) = position {
            mark_pointer(pixels.to_mut(), &frame, point);
        }
        let screenshot = screenshot(
            &request.desktop_id,
            request.legacy_display_id.as_deref(),
            &frame,
            options,
            &pixels,
            &mut budget,
        )?;
        let pointer = position.map(|position| Pointer {
            frame_id: frame.id.clone(),
            position,
            source: PointerSource::LastCommanded,
        });
        Ok(View {
            frame,
            pointer,
            screenshot,
        })
    };
    let primary = primary
        .map(|(opts, prepared)| render(opts, prepared))
        .transpose()?;
    let detail_screenshots = details
        .into_iter()
        .map(|(detail, prepared)| {
            Ok(DetailScreenshot {
                id: detail.id.clone(),
                purpose: detail.purpose.clone(),
                view: render(&detail.options, prepared)?,
            })
        })
        .collect::<Result<Vec<_>, FrameError>>()?;
    Ok(CaptureOutput {
        primary,
        detail_screenshots,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_matching_hash_never_enters_the_encoder() {
        let frame: Frame = serde_json::from_value(serde_json::json!({
            "id":"f","displayId":"display-1","width":1,"height":1,"coordinateSpace":"image-pixels",
            "toDesktopLogical":{"scaleX":1,"scaleY":1,"offsetX":0,"offsetY":0}
        }))
        .unwrap();
        let pixel = [30, 20, 10, 255];
        let mut options = ScreenshotOptions {
            encoding: Encoding::Png {},
            ..Default::default()
        };
        let mut budget = 0;
        assert!(screenshot("user", None, &frame, &options, &pixel, &mut budget).is_err());
        options.unchanged_if_content_hash = Some(hash::content_hash(
            "user",
            &frame.display_id,
            &frame,
            options.encoding,
            &pixel,
        ));
        assert!(matches!(
            screenshot("user", None, &frame, &options, &pixel, &mut budget),
            Ok(Screenshot::Unchanged { .. })
        ));
    }
}
