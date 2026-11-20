use crate::{
    bus::{DESKTOP, Options, REMOTE, ROOT, proxy},
    error::{Error, Result},
    ibus::Commit,
    observation::Point,
    portal::{Monitor, Session, Transport},
};
use serde::Serialize;
use std::time::Duration;
use tokio::time::sleep;
use xkbcommon::xkb;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Key {
    sym: u32,
    physical: Option<u32>,
}

impl Key {
    pub fn character(ch: char) -> Self {
        Self {
            sym: ch as u32,
            physical: None,
        }
    }

    pub fn parse(name: &str) -> Result<Self> {
        let invalid = || Error::new("invalid-key-name", "Unknown keyboard key.");
        if name.len() == 1 && name.as_bytes()[0].is_ascii_graphic() {
            return Ok(Self::character(
                name.as_bytes()[0].to_ascii_lowercase() as char
            ));
        }
        let name = name.to_ascii_lowercase();
        let (xname, physical) = match name.as_str() {
            "alt" | "option" | "altleft" => ("Alt_L", None),
            "altright" => ("Alt_R", None),
            "ctrl" | "control" | "controlleft" => ("Control_L", None),
            "controlright" => ("Control_R", None),
            "meta" | "super" | "win" | "windows" | "cmd" | "command" | "metaleft" => {
                ("Super_L", None)
            }
            "metaright" => ("Super_R", None),
            "shift" | "shiftleft" => ("Shift_L", None),
            "shiftright" => ("Shift_R", None),
            "tab" => ("Tab", None),
            "return" | "enter" => ("Return", None),
            "escape" | "esc" => ("Escape", None),
            "backspace" => ("BackSpace", None),
            "home" => ("Home", None),
            "end" => ("End", None),
            "pageup" => ("Prior", None),
            "pagedown" => ("Next", None),
            "capslock" => ("Caps_Lock", None),
            "arrowleft" | "left" => ("Left", None),
            "arrowright" | "right" => ("Right", None),
            "arrowdown" | "down" => ("Down", None),
            "arrowup" | "up" => ("Up", None),
            "insert" => ("Insert", None),
            "delete" => ("Delete", None),
            "space" | " " => ("space", None),
            "numlock" => ("Num_Lock", Some(69)),
            "numpadenter" => ("KP_Enter", Some(96)),
            "numpadadd" => ("KP_Add", Some(78)),
            "numpadsubtract" => ("KP_Subtract", Some(74)),
            "numpadmultiply" => ("KP_Multiply", Some(55)),
            "numpaddivide" => ("KP_Divide", Some(98)),
            "numpaddecimal" => ("KP_Decimal", Some(83)),
            "numpadequal" => ("KP_Equal", Some(117)),
            _ => {
                if let Some(i) = name
                    .strip_prefix("numpad")
                    .filter(|s| s.len() == 1)
                    .and_then(|s| s.parse::<usize>().ok())
                    .filter(|i| *i < 10)
                {
                    return Ok(Self {
                        sym: 0xffb0 + i as u32,
                        physical: Some([82, 79, 80, 81, 75, 76, 77, 71, 72, 73][i]),
                    });
                }
                if let Some(i) = name
                    .strip_prefix('f')
                    .and_then(|s| s.parse::<u32>().ok())
                    .filter(|n| (1..=24).contains(n))
                {
                    return Ok(Self {
                        sym: 0xffbd + i,
                        physical: None,
                    });
                }
                return Err(invalid());
            }
        };
        Ok(Self {
            sym: xkb::keysym_from_name(xname, xkb::KEYSYM_NO_FLAGS).raw(),
            physical,
        })
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Wire {
    Code(u32),
    Sym(u32),
    Button(u32),
}

fn wire_keys(session: &Session, key: Key) -> Result<Vec<Wire>> {
    if !session.control() {
        return Err(Error::denied());
    }
    if let Some(code) = key.physical {
        return Ok(vec![Wire::Code(code)]);
    }
    match &session.transport {
        Transport::View => Err(Error::denied()),
        Transport::Legacy => Ok(vec![Wire::Sym(key.sym)]),
        Transport::Eis(ei) => {
            let (code, shift) = ei.resolve(key.sym)?;
            let mut keys = Vec::new();
            if shift {
                keys.push(Wire::Code(ei.resolve(Key::parse("Shift")?.sym)?.0));
            }
            keys.push(Wire::Code(code));
            Ok(keys)
        }
    }
}

async fn send(session: &Session, key: Wire, down: bool) -> Result<()> {
    match &session.transport {
        Transport::View => Err(Error::denied()),
        Transport::Eis(ei) => match key {
            Wire::Code(code) => ei.key(code, down),
            Wire::Button(code) => ei.button(code, down),
            Wire::Sym(_) => Err(Error::input("Invalid EIS key.")),
        },
        Transport::Legacy => {
            let (method, code) = match key {
                Wire::Code(c) => ("NotifyKeyboardKeycode", c),
                Wire::Sym(s) => ("NotifyKeyboardKeysym", s),
                Wire::Button(b) => ("NotifyPointerButton", b),
            };
            proxy(&session.bus, DESKTOP, ROOT, REMOTE)
                .await?
                .call(
                    method,
                    &(&session.path, Options::new(), code as i32, u32::from(down)),
                )
                .await
                .map_err(Error::input)
        }
    }
}

#[derive(Default)]
pub struct Inputs {
    held: Vec<(Wire, u32)>,
    manual: Vec<(Key, Vec<Wire>)>,
    pub ibus: Option<Commit>,
}

#[derive(Serialize)]
pub struct Cleanup {
    pub keys: &'static str,
    pub buttons: &'static str,
}

impl Inputs {
    pub async fn switch_window(&mut self, s: &Session, count: usize) -> Result<()> {
        let alt = wire_keys(s, Key::parse("Alt")?)?;
        let escape = Key::parse("Escape")?;
        for wire in &alt {
            self.down(s, *wire).await?;
        }
        for _ in 0..count {
            self.chord(s, &[escape]).await?;
        }
        for wire in alt.into_iter().rev() {
            self.up(s, wire).await?;
        }
        Ok(())
    }

    pub fn can_type(&self, session: &Session, text: &str) -> bool {
        if !self.held.is_empty() {
            return false;
        }
        let mut checked = [false; 128];
        text.bytes().all(|b| {
            let i = usize::from(b);
            if i >= checked.len() {
                return false;
            }
            if !checked[i] {
                checked[i] = wire_keys(session, Key::character(char::from(b))).is_ok();
            }
            checked[i]
        })
    }
    async fn down(&mut self, s: &Session, w: Wire) -> Result<()> {
        if let Some((_, count)) = self.held.iter_mut().find(|(key, _)| *key == w) {
            *count += 1;
            return Ok(());
        }
        // Register before awaiting the backend, which may receive the press even on cancellation.
        self.held.push((w, 1));
        send(s, w, true).await
    }

    async fn up(&mut self, s: &Session, w: Wire) -> Result<()> {
        let Some(i) = self.held.iter().position(|(key, _)| *key == w) else {
            return Ok(());
        };
        if self.held[i].1 > 1 {
            self.held[i].1 -= 1;
            return Ok(());
        }
        send(s, w, false).await?;
        self.held.remove(i);
        Ok(())
    }

    pub async fn key_state(&mut self, s: &Session, key: Key, down: bool) -> Result<()> {
        let prior = self.manual.iter().position(|(k, _)| *k == key);
        match (down, prior) {
            (true, None) => {
                let keys = wire_keys(s, key)?;
                for k in &keys {
                    self.down(s, *k).await?;
                }
                self.manual.push((key, keys));
            }
            (false, Some(i)) => {
                for k in self.manual.remove(i).1.into_iter().rev() {
                    self.up(s, k).await?;
                }
            }
            (true, Some(_)) => return Err(Error::invalid("The keyboard key is already held.")),
            (false, None) => {}
        }
        Ok(())
    }

    pub async fn chord(&mut self, s: &Session, keys: &[Key]) -> Result<()> {
        let mut chord = Vec::new();
        for (index, key) in keys.iter().enumerate() {
            if keys[..index].contains(key) {
                return Err(Error::invalid("Chord keys must be unique."));
            }
            let wires = wire_keys(s, *key)?;
            if index + 1 == keys.len()
                && let Some(terminal) = wires.last()
                && (self.held.iter().any(|(held, _)| held == terminal) || chord.contains(terminal))
            {
                return Err(Error::invalid("The final chord key is already held."));
            }
            for wire in wires {
                if !chord.contains(&wire) {
                    chord.push(wire);
                }
            }
        }
        for wire in &chord {
            self.down(s, *wire).await?;
            sleep(Duration::from_millis(10)).await;
        }
        for wire in chord.into_iter().rev() {
            self.up(s, wire).await?;
        }
        sleep(Duration::from_millis(10)).await;
        Ok(())
    }

    pub async fn button(&mut self, s: &Session, b: u32, down: bool) -> Result<()> {
        if down {
            self.down(s, Wire::Button(b)).await
        } else {
            self.up(s, Wire::Button(b)).await
        }
    }

    pub async fn release(&mut self, session: Option<&Session>) -> Cleanup {
        if let Some(work) = self.ibus.take() {
            work.cancel().await;
        }
        self.manual.clear();
        let mut cleanup = Cleanup {
            keys: "not-needed",
            buttons: "not-needed",
        };
        for (w, _) in self.held.drain(..).rev() {
            let slot = if matches!(w, Wire::Button(_)) {
                &mut cleanup.buttons
            } else {
                &mut cleanup.keys
            };
            if let Some(s) = session {
                if *s.revoked.borrow() {
                    *slot = "session-closed";
                } else if send(s, w, false).await.is_err() {
                    *slot = "release-failed";
                } else if *slot != "release-failed" {
                    *slot = "released";
                }
            } else {
                *slot = "session-closed";
            }
        }
        cleanup
    }
}

pub async fn motion(
    session: &Session,
    monitor: &Monitor,
    point: Point,
    previous: Option<Point>,
) -> Result<()> {
    let local = (
        point.0 - f64::from(monitor.x),
        point.1 - f64::from(monitor.y),
    );
    let unit = (
        local.0 / f64::from(monitor.width),
        local.1 / f64::from(monitor.height),
    );
    if !(0.0..1.0).contains(&unit.0) || !(0.0..1.0).contains(&unit.1) {
        return Err(Error::new(
            "invalid-coordinate",
            "The point lies outside the shared monitor.",
        ));
    }
    match &session.transport {
        Transport::View => Err(Error::denied()),
        Transport::Eis(ei) => ei.motion(monitor.mapping.as_deref(), unit, point),
        Transport::Legacy if monitor.scale != (1., 1.) => {
            let remote = proxy(&session.bus, DESKTOP, ROOT, REMOTE).await?;
            let from = if let Some(p) = previous {
                p
            } else {
                // GNOME's legacy absolute method rescales logical stream coordinates on HiDPI monitors.
                let center = (
                    f64::from(monitor.width) / 2.,
                    f64::from(monitor.height) / 2.,
                );
                remote
                    .call::<_, _, ()>(
                        "NotifyPointerMotionAbsolute",
                        &(
                            &session.path,
                            Options::new(),
                            monitor.node,
                            center.0,
                            center.1,
                        ),
                    )
                    .await
                    .map_err(Error::input)?;
                (
                    f64::from(monitor.x) + center.0 / monitor.scale.0,
                    f64::from(monitor.y) + center.1 / monitor.scale.1,
                )
            };
            remote
                .call(
                    "NotifyPointerMotion",
                    &(
                        &session.path,
                        Options::new(),
                        point.0 - from.0,
                        point.1 - from.1,
                    ),
                )
                .await
                .map_err(Error::input)
        }
        Transport::Legacy => proxy(&session.bus, DESKTOP, ROOT, REMOTE)
            .await?
            .call(
                "NotifyPointerMotionAbsolute",
                &(
                    &session.path,
                    Options::new(),
                    monitor.node,
                    local.0,
                    local.1,
                ),
            )
            .await
            .map_err(Error::input),
    }
}

pub async fn wheel(session: &Session, x: i32, y: i32) -> Result<()> {
    match &session.transport {
        Transport::View => Err(Error::denied()),
        Transport::Eis(ei) => ei.scroll(x, y),
        Transport::Legacy => {
            let remote = proxy(&session.bus, DESKTOP, ROOT, REMOTE).await?;
            for (axis, ticks) in [(0_u32, y), (1, x)] {
                if ticks != 0 {
                    remote
                        .call::<_, _, ()>(
                            "NotifyPointerAxisDiscrete",
                            &(&session.path, Options::new(), axis, ticks),
                        )
                        .await
                        .map_err(Error::input)?;
                }
            }
            Ok(())
        }
    }
}
