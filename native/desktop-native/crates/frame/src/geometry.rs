use crate::model::{
    Bounds, CaptureRequest, CoordinateSpace, Frame, FrameError, Point, Region, ScreenshotOptions,
    Transform,
};

pub(crate) const MAX_DIMENSION: u32 = 4096;

#[derive(Debug, Clone, Copy)]
pub(crate) struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy)]
struct LogicalRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl From<Bounds> for LogicalRect {
    fn from(bounds: Bounds) -> Self {
        Self {
            x: bounds.x as f64,
            y: bounds.y as f64,
            width: bounds.width.into(),
            height: bounds.height.into(),
        }
    }
}

fn image_region(frame: &Frame, display_id: &str, rect: Rect) -> Result<LogicalRect, FrameError> {
    if frame.display_id != display_id {
        return Err(FrameError("source frame belongs to a different display"));
    }
    if rect.width == 0
        || rect.height == 0
        || rect
            .x
            .checked_add(rect.width)
            .is_none_or(|v| v > frame.width)
        || rect
            .y
            .checked_add(rect.height)
            .is_none_or(|v| v > frame.height)
    {
        return Err(FrameError("region is outside its source frame"));
    }
    let t = frame.to_desktop_logical;
    Ok(LogicalRect {
        x: t.offset_x + f64::from(rect.x) * t.scale_x,
        y: t.offset_y + f64::from(rect.y) * t.scale_y,
        width: f64::from(rect.width) * t.scale_x,
        height: f64::from(rect.height) * t.scale_y,
    })
}

fn resolve_region(
    request: &CaptureRequest,
    region: Option<&Region>,
) -> Result<LogicalRect, FrameError> {
    let display = &request.display;
    let bounds = display.bounds;
    match region {
        None => Ok(bounds.into()),
        Some(Region::Logical {
            display_id,
            x,
            y,
            width,
            height,
            ..
        }) => {
            if *display_id != display.id {
                return Err(FrameError("region belongs to a different display"));
            }
            if *width == 0
                || *height == 0
                || *x < bounds.x
                || *y < bounds.y
                || x.checked_add(i64::from(*width))
                    .is_none_or(|v| v > bounds.x + i64::from(bounds.width))
                || y.checked_add(i64::from(*height))
                    .is_none_or(|v| v > bounds.y + i64::from(bounds.height))
            {
                return Err(FrameError("region is outside its source display"));
            }
            Ok(Bounds {
                x: *x,
                y: *y,
                width: *width,
                height: *height,
            }
            .into())
        }
        Some(Region::Image {
            frame_id,
            x,
            y,
            width,
            height,
        }) => {
            let frame = request
                .source_frames
                .iter()
                .find(|f| f.id == *frame_id)
                .ok_or(FrameError("unknown source frame"))?;
            image_region(
                frame,
                &display.id,
                Rect {
                    x: *x,
                    y: *y,
                    width: *width,
                    height: *height,
                },
            )
        }
    }
}

fn source_axis(
    origin: i64,
    logical_size: u32,
    source_size: u32,
    start: f64,
    extent: f64,
) -> Result<(u32, u32, f64), FrameError> {
    let origin = origin as f64;
    let scale = f64::from(source_size) / f64::from(logical_size);
    let first = (start - origin) * scale;
    let last = (start + extent - origin) * scale;
    // A rounded prior transform can miss an edge by a few ulps, but never forgive a whole pixel.
    let tolerance =
        (4.0 * f64::EPSILON * (origin.abs() + f64::from(logical_size)) * scale).min(0.5);
    if !first.is_finite()
        || !last.is_finite()
        || first < -tolerance
        || last > f64::from(source_size) + tolerance
    {
        return Err(FrameError("frame transform is outside its source display"));
    }
    let left = first.floor().max(0.0) as u32;
    let right = last.ceil().min(f64::from(source_size)) as u32;
    if right <= left {
        return Err(FrameError("region resolved to an empty image"));
    }
    Ok((left, right - left, scale))
}

pub(crate) fn prepare_view(
    source_width: u32,
    source_height: u32,
    request: &CaptureRequest,
    options: &ScreenshotOptions,
    id: String,
) -> Result<(Rect, Frame), FrameError> {
    let logical = resolve_region(request, options.region.as_ref())?;
    let bounds = request.display.bounds;
    let (x, width, sx) = source_axis(
        bounds.x,
        bounds.width,
        source_width,
        logical.x,
        logical.width,
    )?;
    let (y, height, sy) = source_axis(
        bounds.y,
        bounds.height,
        source_height,
        logical.y,
        logical.height,
    )?;
    let logical_width = f64::from(width) / sx;
    let logical_height = f64::from(height) / sy;
    let (mw, mh) = match (options.max_width, options.max_height) {
        (None, None) => (
            logical_width.round().clamp(1.0, 1600.0),
            logical_height.round().clamp(1.0, 900.0),
        ),
        (w, h) => (
            w.unwrap_or(MAX_DIMENSION).into(),
            h.unwrap_or(MAX_DIMENSION).into(),
        ),
    };
    let divisor = 1.0_f64
        .max(f64::from(width) / mw)
        .max(f64::from(height) / mh);
    let out_width = (f64::from(width) / divisor).round().max(1.0) as u32;
    let out_height = (f64::from(height) / divisor).round().max(1.0) as u32;
    let frame = Frame {
        id,
        display_id: request.display.id.clone(),
        coordinate_space: CoordinateSpace::ImagePixels,
        width: out_width,
        height: out_height,
        to_desktop_logical: Transform {
            offset_x: bounds.x as f64 + f64::from(x) / sx,
            offset_y: bounds.y as f64 + f64::from(y) / sy,
            scale_x: logical_width / f64::from(out_width),
            scale_y: logical_height / f64::from(out_height),
        },
    };
    Ok((
        Rect {
            x,
            y,
            width,
            height,
        },
        frame,
    ))
}

pub(crate) fn pointer_position(frame: &Frame, point: Point) -> Option<Point> {
    let t = frame.to_desktop_logical;
    let x = (point.x - t.offset_x) / t.scale_x;
    let y = (point.y - t.offset_y) / t.scale_y;
    ((0.0..f64::from(frame.width)).contains(&x) && (0.0..f64::from(frame.height)).contains(&y))
        .then_some(Point { x, y })
}
