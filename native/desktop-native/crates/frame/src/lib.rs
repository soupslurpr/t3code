mod encode;
mod geometry;
mod hash;
mod model;
mod render;

pub use model::{CaptureOutput, CaptureRequest, FrameError};

/// Includes row padding. Call before allocating storage for an incoming capture.
pub fn bgra_len(width: u32, height: u32, stride: usize) -> Result<usize, FrameError> {
    if !(1..=16_384).contains(&width) || !(1..=16_384).contains(&height) {
        return Err(FrameError("invalid BGRA dimensions"));
    }
    if stride < width as usize * 4 {
        return Err(FrameError("BGRA stride is shorter than a row"));
    }
    stride
        .checked_mul(height as usize)
        .filter(|bytes| *bytes <= 128 * 1024 * 1024)
        .ok_or(FrameError("BGRA capture exceeds 128 MiB"))
}

/// Render every requested view from one BGRA8 capture. The stride is in bytes.
pub fn render_bgra(
    width: u32,
    height: u32,
    stride: usize,
    bgra: &[u8],
    request: &CaptureRequest,
) -> Result<CaptureOutput, FrameError> {
    render::render_bgra(width, height, stride, bgra, request)
}
