use crate::{
    error::{Error, Result},
    input::{self, Inputs, Key},
    observation::{Observation, Point},
    portal::{Monitor, Session},
    text,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::sleep;

fn name<'a>(action: &'a Value, key: &str) -> Result<&'a str> {
    action[key]
        .as_str()
        .ok_or_else(|| Error::invalid(format!("Missing or invalid {key}.")))
}
fn number(a: &Value, k: &str, default: u64, min: u64, max: u64) -> Result<u64> {
    if a.get(k).is_none() {
        return Ok(default);
    }
    a[k].as_u64()
        .filter(|v| (min..=max).contains(v))
        .ok_or_else(|| Error::invalid(format!("Invalid {k}.")))
}
fn button(a: &Value) -> Result<u32> {
    match a.get("button").map(Value::as_str) {
        None | Some(Some("left")) => Ok(0x110),
        Some(Some("right")) => Ok(0x111),
        Some(Some("middle")) => Ok(0x112),
        _ => Err(Error::invalid("Invalid pointer button.")),
    }
}
fn point(obs: &Observation, s: &Session, a: &Value, x: &str, y: &str) -> Result<(Monitor, Point)> {
    let coord = |k: &str| {
        a[k].as_f64()
            .ok_or_else(|| Error::new("invalid-coordinate", format!("Invalid {k}.")))
    };
    obs.point(s, name(a, "frameId")?, coord(x)?, coord(y)?)
}
async fn move_point(
    obs: &mut Observation,
    session: &Session,
    m: &Monitor,
    target: Point,
    duration: u64,
    steps: u64,
    dragging: bool,
) -> Result<()> {
    let start = obs.cursor.filter(|(x, y)| {
        *x >= f64::from(m.x)
            && *y >= f64::from(m.y)
            && *x < f64::from(m.x) + f64::from(m.width)
            && *y < f64::from(m.y) + f64::from(m.height)
    });
    let n = if start.is_some() { steps } else { 1 };
    let mut previous = if dragging || duration > 0 {
        start
    } else {
        None
    };
    let start = start.unwrap_or(target);
    let interval = Duration::from_millis(duration) / n as u32;
    for step in 1..=n {
        if duration > 0 && start != target {
            sleep(interval).await;
        }
        let t = step as f64 / n as f64;
        let p = (
            start.0 + (target.0 - start.0) * t,
            start.1 + (target.1 - start.1) * t,
        );
        input::motion(session, m, p, previous).await?;
        obs.cursor = Some(p);
        previous = Some(p);
    }
    Ok(())
}

pub async fn act(
    obs: &mut Observation,
    inputs: &mut Inputs,
    session: &Session,
    a: &Value,
) -> Result<Value> {
    if !session.control() {
        return Err(Error::denied());
    }
    let kind = name(a, "type")?;
    let semantics = std::mem::take(&mut obs.semantics);
    let delay = |ms: u64| sleep(Duration::from_millis(ms));
    match kind {
        "activate" | "activate_window" => {
            let window = kind == "activate_window";
            let id = name(a, if window { "windowId" } else { "targetId" })?;
            let keyboard = tokio::time::timeout(
                Duration::from_secs(5),
                semantics.activate(id, window, inputs, session),
            )
            .await
            .map_err(|_| Error::new("timed-out", "Semantic activation timed out."))??;
            if keyboard {
                inputs.chord(session, &[Key::parse("Enter")?]).await?;
            }
        }
        "click" => {
            let (m, p) = point(obs, session, a, "x", "y")?;
            let b = button(a)?;
            let count = number(a, "count", 1, 1, 3)?;
            move_point(obs, session, &m, p, 0, 1, false).await?;
            for _ in 0..count {
                inputs.button(session, b, true).await?;
                delay(10).await;
                inputs.button(session, b, false).await?;
                delay(10).await;
            }
        }
        "move" => {
            let (m, p) = point(obs, session, a, "x", "y")?;
            let duration = number(a, "durationMs", 0, 0, 5000)?;
            let settle = number(a, "settleMs", 250, 0, 2000)?;
            move_point(
                obs,
                session,
                &m,
                p,
                duration,
                duration.div_ceil(16).clamp(1, 120),
                false,
            )
            .await?;
            delay(settle).await;
        }
        "drag" => {
            let (m, start) = point(obs, session, a, "startX", "startY")?;
            let (_, end) = point(obs, session, a, "endX", "endY")?;
            let b = button(a)?;
            let duration = number(a, "durationMs", 500, 0, 5000)?;
            let steps = number(a, "steps", duration.div_ceil(16).clamp(1, 120), 1, 120)?;
            move_point(obs, session, &m, start, 0, 1, false).await?;
            inputs.button(session, b, true).await?;
            delay(10).await;
            move_point(obs, session, &m, end, duration, steps, true).await?;
            inputs.button(session, b, false).await?;
        }
        "wheel" => {
            let ticks = |k: &str| match a.get(k) {
                None => Ok(0),
                Some(v) => v
                    .as_i64()
                    .filter(|i| (-100..=100).contains(i))
                    .map(|v| v as i32)
                    .ok_or_else(|| Error::invalid("Invalid wheel ticks.")),
            };
            let (x, y) = (ticks("horizontalTicks")?, ticks("verticalTicks")?);
            if a.get("horizontalTicks").is_none() && a.get("verticalTicks").is_none() {
                return Err(Error::invalid("Missing wheel ticks."));
            }
            if ["frameId", "x", "y"].iter().any(|k| a.get(*k).is_some()) {
                let (m, p) = point(obs, session, a, "x", "y")?;
                move_point(obs, session, &m, p, 0, 1, false).await?;
            }
            input::wheel(session, x, y).await?;
            return Ok(json!({"index":0,"type":kind,"horizontalTicks":x,"verticalTicks":y}));
        }
        "press" | "hotkey" => {
            let mut keys = Vec::new();
            if let Some(list) = a.get(if kind == "hotkey" {
                "keys"
            } else {
                "modifiers"
            }) {
                let list = list
                    .as_array()
                    .ok_or_else(|| Error::invalid("Invalid key list."))?;
                if (kind == "hotkey" && !(2..=8).contains(&list.len()))
                    || (kind == "press" && list.len() > 4)
                {
                    return Err(Error::invalid("Invalid chord size."));
                }
                for k in list {
                    keys.push(Key::parse(
                        k.as_str().ok_or_else(|| Error::invalid("Invalid key."))?,
                    )?);
                }
            }
            if kind == "press" {
                keys.push(Key::parse(name(a, "key")?)?);
            }
            if keys.is_empty() {
                return Err(Error::invalid("Missing keyboard keys."));
            }
            inputs.chord(session, &keys).await?;
        }
        "key_down" | "key_up" => {
            inputs
                .key_state(session, Key::parse(name(a, "key")?)?, kind == "key_down")
                .await?
        }
        "type" | "insert_text" => {
            let insert = kind == "insert_text";
            let interval = number(a, "intervalMs", 0, 0, 250)?;
            let submit = match a.get("submit") {
                None => false,
                Some(v) if !insert => v
                    .as_bool()
                    .ok_or_else(|| Error::invalid("Invalid submit flag."))?,
                _ => return Err(Error::invalid("insert_text cannot submit.")),
            };
            let required = match a.get("verification").map(Value::as_str) {
                None | Some(Some("best-effort")) => false,
                Some(Some("required")) if !insert => true,
                _ => return Err(Error::invalid("Invalid verification policy.")),
            };
            return text::enter(
                inputs,
                session,
                name(a, "text")?,
                interval,
                insert,
                submit,
                required,
            )
            .await;
        }
        "wait" => {
            if a.get("durationMs").is_none() {
                return Err(Error::invalid("Missing durationMs."));
            }
            delay(number(a, "durationMs", 0, 0, 60000)?).await;
        }
        "wait_for_change" => return obs.wait_for_change(session, a).await,
        _ => {
            return Err(Error::new(
                "unsupported-operation",
                "Unknown desktop action.",
            ));
        }
    }
    Ok(json!({"index":0,"type":kind}))
}
