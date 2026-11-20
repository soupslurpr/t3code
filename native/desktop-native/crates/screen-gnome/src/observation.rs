use crate::{
    accessibility::Semantics,
    bus::token,
    error::{Error, Result},
    portal::{Monitor, Session},
};
use serde_json::{Value, json};
use std::{collections::VecDeque, time::Duration};
use tokio::time::{Instant, sleep, timeout_at};

pub type Point = (f64, f64);

#[derive(Default)]
pub struct Observation {
    desktop: String,
    frames: VecDeque<Value>,
    pub cursor: Option<Point>,
    pub semantics: Semantics,
}

impl Observation {
    fn frame(&self, id: &str) -> Result<&Value> {
        self.frames
            .iter()
            .find(|f| f["id"].as_str() == Some(id))
            .ok_or_else(|| {
                Error::new(
                    "stale-frame",
                    "The source frame has expired. Observe the display again.",
                )
            })
    }

    pub fn point(
        &self,
        session: &Session,
        frame_id: &str,
        x: f64,
        y: f64,
    ) -> Result<(Monitor, Point)> {
        let f = self.frame(frame_id)?;
        if !(0.0..f["width"].as_f64().unwrap_or(0.)).contains(&x)
            || !(0.0..f["height"].as_f64().unwrap_or(0.)).contains(&y)
        {
            return Err(Error::new(
                "invalid-coordinate",
                "The requested point lies outside its source frame.",
            ));
        }
        let t = &f["toDesktopLogical"];
        let pos = (
            x * t["scaleX"].as_f64().unwrap() + t["offsetX"].as_f64().unwrap(),
            y * t["scaleY"].as_f64().unwrap() + t["offsetY"].as_f64().unwrap(),
        );
        let monitor = session
            .monitors
            .iter()
            .find(|m| Some(m.id.as_str()) == f["displayId"].as_str())
            .ok_or_else(display_error)?;
        Ok((monitor.clone(), pos))
    }

    fn monitor(&self, session: &Session, options: &Value) -> Result<usize> {
        let mut id = options["displayId"].as_str();
        for shot in std::iter::once(&options["screenshot"]).chain(
            options["detailScreenshots"]
                .as_array()
                .into_iter()
                .flatten(),
        ) {
            let r = &shot["region"];
            let source = if let Some(frame) = r["frameId"].as_str() {
                self.frame(frame)?["displayId"].as_str()
            } else {
                r["displayId"].as_str()
            };
            if let Some(source) = source {
                if id.is_some_and(|current| current != source) {
                    return Err(Error::invalid(
                        "All screenshot views must select one monitor.",
                    ));
                }
                id = Some(source);
            }
        }
        session
            .monitors
            .iter()
            .position(|m| id.map_or(m.primary, |id| m.id == id))
            .ok_or_else(display_error)
    }

    fn cursor_json(&self) -> Value {
        self.cursor
            .map(|(x, y)| json!({"x":x,"y":y}))
            .unwrap_or(Value::Null)
    }
    pub fn status_cursor(&self) -> Value {
        self.cursor_json()
    }

    async fn render(
        &self,
        session: &Session,
        index: usize,
        options: &Value,
        legacy_display_id: Option<&str>,
    ) -> Result<(Value, (f64, f64))> {
        let monitor = &session.monitors[index];
        let pixels = session.pixels(monitor).await?;
        let scale = (
            f64::from(pixels.width) / f64::from(monitor.width),
            f64::from(pixels.height) / f64::from(monitor.height),
        );
        let mut display = monitor.display();
        display["scaleFactor"] = scale.0.into();
        let mut request: frame::CaptureRequest = serde_json::from_value(json!({"desktopId": self.desktop, "display":display,
            "frameId":token(), "pointer":self.cursor_json(), "options":options, "sourceFrames":self.frames})).map_err(Error::invalid)?;
        request.legacy_display_id = legacy_display_id.map(str::to_owned);
        let output = tokio::task::spawn_blocking(move || {
            frame::render_bgra(
                pixels.width,
                pixels.height,
                pixels.stride,
                &pixels.bytes,
                &request,
            )
        })
        .await
        .map_err(Error::capture)?
        .map_err(Error::capture)?;
        Ok((serde_json::to_value(output).map_err(Error::capture)?, scale))
    }

    pub async fn snapshot(
        &mut self,
        session: &mut Session,
        desktop: &str,
        options: &Value,
        legacy_display_id: Option<&str>,
    ) -> Result<Value> {
        if desktop.is_empty() || desktop.len() > 256 || !options.is_object() {
            return Err(Error::invalid("Invalid snapshot parameters."));
        }
        if self.desktop != desktop {
            self.frames.clear();
            self.cursor = None;
            self.desktop = desktop.into();
        }
        self.semantics = Semantics::default();
        let index = self.monitor(session, options)?;
        if let Some(delay) = options["delayMs"].as_u64() {
            if delay > 5000 {
                return Err(Error::invalid("Observation delay exceeds five seconds."));
            }
            sleep(Duration::from_millis(delay)).await;
        }
        let mut result =
            if options["screenshot"] != false || options["detailScreenshots"].is_array() {
                let (views, scale) = self
                    .render(session, index, options, legacy_display_id)
                    .await?;
                session.monitors[index].scale = scale;
                views
            } else {
                json!({})
            };
        for frame in std::iter::once(&result["frame"])
            .chain(
                result["detailScreenshots"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|d| &d["frame"]),
            )
            .filter(|f| f.is_object())
        {
            self.frames.push_back(frame.clone());
            if self.frames.len() > 32 {
                self.frames.pop_front();
            }
        }
        result["display"] = session.monitors[index].display();
        result["cursor"] = self.cursor_json();
        result["captureSource"] = if session.remote {
            "remote-desktop-stream"
        } else {
            "screen-cast-stream"
        }
        .into();
        if options["includeAccessibility"] != false {
            result["accessibility"] = self.semantics.snapshot().await;
        }
        Ok(result)
    }

    pub async fn wait_for_change(&self, session: &Session, action: &Value) -> Result<Value> {
        let duration = action["timeoutMs"]
            .as_u64()
            .filter(|v| (1..=60000).contains(v))
            .ok_or_else(|| Error::invalid("Invalid wait timeout."))?;
        let poll = action["pollIntervalMs"].as_u64().unwrap_or(250);
        if !(100..=2000).contains(&poll) {
            return Err(Error::invalid("Invalid capture interval."));
        }
        let region = json!({"frameId":action["frameId"],"x":action["x"],"y":action["y"],"width":action["width"],"height":action["height"]});
        let mut options = json!({"screenshot":{"region":region,"maxWidth":480,"maxHeight":270}, "includeAccessibility":false});
        let index = self.monitor(session, &options)?;
        let start = Instant::now();
        let deadline = start + Duration::from_millis(duration);
        let (first, _) = self.render(session, index, &options, None).await?;
        let baseline = &first["screenshot"]["contentHash"];
        options["screenshot"]["unchangedIfContentHash"] = baseline.clone();
        let mut samples = 1;
        let mut changed = false;
        while Instant::now() < deadline {
            let next = async {
                sleep(Duration::from_millis(poll)).await;
                self.render(session, index, &options, None).await
            };
            let Ok(output) = timeout_at(deadline, next).await else {
                break;
            };
            let (view, _) = output?;
            samples += 1;
            if view["screenshot"]["contentHash"] != *baseline {
                changed = true;
                break;
            }
        }
        Ok(
            json!({"index":0,"type":"wait_for_change","changed":changed,"samples":samples,
            "elapsedMs":(start.elapsed().as_millis() as u64).min(duration)}),
        )
    }
}
fn display_error() -> Error {
    Error::new("display-not-found", "The requested monitor is not shared.")
}
