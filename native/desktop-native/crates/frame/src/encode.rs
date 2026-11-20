use crate::model::{Encoding, FrameError, WebpMode};
use libwebp_sys as webp;
use std::{
    io::{self, Write},
    mem::MaybeUninit,
    slice,
};

struct Output {
    bytes: Vec<u8>,
    limit: usize,
}

impl Write for Output {
    fn write(&mut self, part: &[u8]) -> io::Result<usize> {
        if part.len() > self.limit - self.bytes.len() {
            return Err(io::Error::other("encoded capture exceeds output limit"));
        }
        self.bytes
            .try_reserve(part.len())
            .map_err(io::Error::other)?;
        self.bytes.extend_from_slice(part);
        Ok(part.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn png(out: &mut Output, width: u32, height: u32, bgra: &[u8]) -> Result<(), png::EncodingError> {
    let mut encoder = png::Encoder::new(out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_deflate_compression(png::DeflateCompression::Level(6));
    encoder.set_filter(png::Filter::Adaptive);
    let mut image = encoder.write_header()?;
    let mut stream = image.stream_writer()?;
    let mut rgba = vec![0; width as usize * 4];
    for row in bgra.chunks_exact(rgba.len()) {
        rgba.copy_from_slice(row);
        for pixel in rgba.as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
        }
        stream.write_all(&rgba)?;
    }
    stream.finish()?;
    image.finish()
}

struct Picture(webp::WebPPicture);

impl Drop for Picture {
    fn drop(&mut self) {
        // Picture owns the planes allocated by WebPPictureImportBGRA.
        unsafe { webp::WebPPictureFree(&mut self.0) }
    }
}

extern "C" fn write_webp(data: *const u8, len: usize, picture: *const webp::WebPPicture) -> i32 {
    if len == 0 {
        return 1;
    }
    // WebPEncode invokes its writer synchronously with len readable bytes and our borrowed Output.
    unsafe {
        let out = &mut *(*picture).custom_ptr.cast::<Output>();
        i32::from(out.write_all(slice::from_raw_parts(data, len)).is_ok())
    }
}

fn webp(
    out: &mut Output,
    width: u32,
    height: u32,
    bgra: &[u8],
    mode: WebpMode,
) -> Result<(), FrameError> {
    let mut config = MaybeUninit::uninit();
    let mut picture = MaybeUninit::uninit();
    // Both version-checked initializers fill their structures on success.
    let (mut config, mut picture) = unsafe {
        if webp::WebPConfigInit(config.as_mut_ptr()) == 0
            || webp::WebPPictureInit(picture.as_mut_ptr()) == 0
        {
            return Err(FrameError("incompatible WebP encoder"));
        }
        (config.assume_init(), Picture(picture.assume_init()))
    };
    config.method = 1;
    match mode {
        WebpMode::Lossless {} => {
            config.lossless = 1;
            config.exact = 1;
        }
        WebpMode::NearLossless { quality } => {
            config.lossless = 1;
            config.near_lossless = quality.into();
        }
        WebpMode::Lossy { quality } => {
            config.quality = quality.into();
            config.use_sharp_yuv = 1;
        }
    }
    picture.0.width = width as i32;
    picture.0.height = height as i32;
    picture.0.use_argb = 1;
    picture.0.custom_ptr = std::ptr::from_mut(out).cast();
    picture.0.writer = Some(write_webp);
    // The renderer supplies width * height BGRA pixels. The input and writer outlive WebPEncode.
    unsafe {
        if webp::WebPPictureImportBGRA(&mut picture.0, bgra.as_ptr(), picture.0.width * 4) == 0 {
            return Err(FrameError("could not import BGRA for WebP encoding"));
        }
        if webp::WebPEncode(&config, &mut picture.0) == 0 {
            return Err(FrameError(
                "WebP encoding failed or exceeded the output limit",
            ));
        }
    }
    Ok(())
}

pub(crate) fn encode(
    width: u32,
    height: u32,
    bgra: &[u8],
    encoding: Encoding,
    limit: usize,
) -> Result<(&'static str, Vec<u8>), FrameError> {
    let mut out = Output {
        bytes: Vec::new(),
        limit,
    };
    let mime = match encoding {
        Encoding::Png {} => {
            png(&mut out, width, height, bgra)
                .map_err(|_| FrameError("PNG encoding failed or exceeded the output limit"))?;
            "image/png"
        }
        Encoding::Webp(mode) => {
            webp(&mut out, width, height, bgra, mode)?;
            "image/webp"
        }
    };
    Ok((mime, out.bytes))
}
