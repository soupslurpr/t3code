use serde::{Deserialize, Serialize};
use std::{error::Error, fmt};

#[derive(Debug, Clone, Copy)]
pub struct FrameError(pub(crate) &'static str);

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl Error for FrameError {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    #[serde(skip)]
    pub legacy_display_id: Option<String>,
    pub desktop_id: String,
    pub display: Display,
    pub frame_id: String,
    pub pointer: Option<Point>,
    #[serde(default)]
    pub options: ObservationOptions,
    #[serde(default)]
    pub source_frames: Vec<Frame>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub id: String,
    pub label: String,
    pub primary: bool,
    pub bounds: Bounds,
    pub scale_factor: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    pub x: i64,
    pub y: i64,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationOptions {
    pub display_id: Option<String>,
    pub include_accessibility: Option<bool>,
    pub delay_ms: Option<u32>,
    #[serde(default)]
    pub screenshot: PrimaryScreenshot,
    pub detail_screenshots: Option<Vec<DetailOptions>>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum PrimaryScreenshot {
    Options(ScreenshotOptions),
    Flag(bool),
}

impl Default for PrimaryScreenshot {
    fn default() -> Self {
        Self::Options(ScreenshotOptions::default())
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotOptions {
    pub region: Option<Region>,
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
    #[serde(default)]
    pub encoding: Encoding,
    pub unchanged_if_content_hash: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DetailOptions {
    pub id: String,
    pub purpose: Option<String>,
    #[serde(flatten)]
    pub options: ScreenshotOptions,
}

#[derive(Debug, Deserialize)]
#[serde(untagged, deny_unknown_fields, rename_all_fields = "camelCase")]
pub enum Region {
    Logical {
        coordinate_space: DesktopLogical,
        display_id: String,
        x: i64,
        y: i64,
        width: u32,
        height: u32,
    },
    Image {
        frame_id: String,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    },
}

#[derive(Debug, Deserialize)]
pub enum DesktopLogical {
    #[serde(rename = "desktop-logical")]
    DesktopLogical,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(tag = "format", rename_all = "lowercase", deny_unknown_fields)]
pub enum Encoding {
    Png {},
    Webp(WebpMode),
}

impl Default for Encoding {
    fn default() -> Self {
        Self::Webp(WebpMode::Lossless {})
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(tag = "mode", rename_all = "kebab-case", deny_unknown_fields)]
pub enum WebpMode {
    Lossless {},
    NearLossless {
        #[serde(default = "near_lossless_quality")]
        quality: u8,
    },
    Lossy {
        #[serde(default = "lossy_quality")]
        quality: u8,
    },
}

fn near_lossless_quality() -> u8 {
    90
}

fn lossy_quality() -> u8 {
    82
}

#[derive(Debug, Copy, Clone, Deserialize, Serialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Deserialize, Serialize)]
pub enum CoordinateSpace {
    #[serde(rename = "image-pixels")]
    ImagePixels,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    pub scale_x: f64,
    pub scale_y: f64,
    pub offset_x: f64,
    pub offset_y: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub id: String,
    pub display_id: String,
    pub coordinate_space: CoordinateSpace,
    pub width: u32,
    pub height: u32,
    pub to_desktop_logical: Transform,
}

#[derive(Debug, Deserialize, Serialize)]
pub enum PointerSource {
    #[serde(rename = "last-commanded")]
    LastCommanded,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pointer {
    pub frame_id: String,
    pub position: Point,
    pub source: PointerSource,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "state",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Screenshot {
    Image {
        #[serde(skip_serializing_if = "Option::is_none")]
        matched_legacy_content_hash: Option<String>,
        content_hash: String,
        width: u32,
        height: u32,
        mime_type: String,
        encoding: Encoding,
        size_bytes: usize,
        data: String,
    },
    Unchanged {
        content_hash: String,
        width: u32,
        height: u32,
    },
}

#[derive(Debug, Deserialize, Serialize)]
pub struct View {
    pub frame: Frame,
    pub pointer: Option<Pointer>,
    pub screenshot: Screenshot,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct DetailScreenshot {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    #[serde(flatten)]
    pub view: View,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOutput {
    #[serde(flatten)]
    pub primary: Option<View>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub detail_screenshots: Vec<DetailScreenshot>,
}
