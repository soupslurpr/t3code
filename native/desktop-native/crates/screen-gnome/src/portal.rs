use crate::{
    bus::{self, *},
    capture,
    eis::Eis,
    error::{Error, Result},
};
use serde_json::{Value as Json, json};
use std::{collections::HashSet, os::fd::OwnedFd, time::Duration};
use tokio::{sync::watch, task::JoinHandle};
use zbus::{
    Connection,
    zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value},
};

#[derive(Clone, Debug)]
pub struct Monitor {
    pub id: String,
    pub node: u32,
    pub serial: Option<u64>,
    pub mapping: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: (f64, f64),
    pub primary: bool,
}

impl Monitor {
    pub fn display(&self) -> Json {
        json!({"id": self.id, "label": format!("Monitor {}", self.id), "primary": self.primary,
            "bounds": {"x": self.x, "y": self.y, "width": self.width, "height": self.height}, "scaleFactor":self.scale.0})
    }
}

pub enum Transport {
    View,
    Legacy,
    Eis(Eis),
}

pub struct Session {
    pub bus: Connection,
    pub path: OwnedObjectPath,
    pub transport: Transport,
    pub remote: bool,
    pub persistent: bool,
    pub monitors: Vec<Monitor>,
    pub revoked: watch::Receiver<bool>,
    _watcher: Watcher,
    _system: crate::power::Revocations,
    handle: Handle,
}

struct Watcher(JoinHandle<()>);
impl Drop for Watcher {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl Session {
    pub fn control(&self) -> bool {
        !matches!(self.transport, Transport::View)
    }

    pub async fn open(
        control: bool,
        remember: bool,
        restore: Option<&str>,
    ) -> Result<(Self, Option<String>)> {
        fn unconsumed<E: Into<Error>>(restore: Option<&str>) -> impl FnOnce(E) -> Error + '_ {
            move |error| {
                let mut error = error.into();
                if restore.is_some() {
                    error.detail = Some(json!({"restoreTokenUnconsumed": true}));
                }
                error
            }
        }
        // Each consent attempt owns its bus connection. Closing it also cancels a request
        // that was still being created when Close crossed the original method call.
        let bus = session_bus().await.map_err(unconsumed(restore))?;
        let registry = proxy(&bus, DESKTOP, ROOT, "org.freedesktop.host.portal.Registry")
            .await
            .map_err(unconsumed(restore))?;
        let app_id = if std::env::var("VITE_DEV_SERVER_URL").is_ok_and(|url| !url.trim().is_empty())
        {
            "t3code"
        } else {
            "com.t3tools.T3Code"
        };
        let _: zbus::Result<()> = registry.call("Register", &(app_id, Options::new())).await;
        let iface = if control { REMOTE } else { SCREEN };
        let screen_version = version(&bus, SCREEN).await.map_err(unconsumed(restore))?;
        let remote_version = if control {
            version(&bus, REMOTE).await.map_err(unconsumed(restore))?
        } else {
            0
        };
        let persistent = remember || restore.is_some();
        if persistent
            && !(if control {
                remote_version >= 2
            } else {
                screen_version >= 4
            })
        {
            return Err(unconsumed(restore)(Error::new(
                "unsupported-operation",
                "This portal does not support remembered screen access.",
            )));
        }

        let session_token = token();
        let expected = bus::path(&bus, "session", &session_token).map_err(unconsumed(restore))?;
        let path = OwnedObjectPath::try_from(expected.as_str()).map_err(unconsumed(restore))?;
        let handle = Handle::new(&bus, expected.clone(), SESSION);
        let closed_proxy = proxy(&bus, DESKTOP, &expected, SESSION)
            .await
            .map_err(unconsumed(restore))?;
        let mut closed = closed_proxy
            .receive_signal("Closed")
            .await
            .map_err(unconsumed(restore))?;
        let mut owner = proxy(&bus, DESKTOP, ROOT, iface)
            .await
            .map_err(unconsumed(restore))?
            .receive_owner_changed()
            .await
            .map_err(unconsumed(restore))?;
        let (revoker, mut revoked) = watch::channel(false);
        let system = crate::power::revocations(&bus, &revoker).await;
        let send = revoker.clone();
        let watcher = Watcher(tokio::spawn(async move {
            tokio::select! { _ = next(&mut closed) => (), _ = next(&mut owner) => () }
            send.send_replace(true);
        }));

        let prepare = async {
            let opts =
                Options::from([("session_handle_token", Value::from(session_token.as_str()))]);
            let mut create = request(&bus, iface, "CreateSession", None, opts)
                .await
                .map_err(unconsumed(restore))?;
            let handle = create.remove("session_handle");
            // Portal implementations have historically used both s and o here.
            let matches = handle.as_ref().is_some_and(|v| {
                <&str>::try_from(v).ok() == Some(&expected)
                    || <&ObjectPath>::try_from(v)
                        .ok()
                        .is_some_and(|p| p.as_str() == expected)
            });
            if !matches {
                return Err(unconsumed(restore)(Error::new(
                    "execution-failed",
                    "The portal returned an unexpected session handle.",
                )));
            }

            let mut persist = Options::new();
            if persistent {
                persist.insert("persist_mode", Value::from(2_u32));
                if let Some(token) = restore {
                    persist.insert("restore_token", Value::from(token));
                }
            }
            if control {
                let mut devices = std::mem::take(&mut persist);
                devices.insert("types", Value::from(3_u32));
                request(&bus, REMOTE, "SelectDevices", Some(&path), devices).await?;
            }
            persist.insert("types", Value::from(1_u32));
            persist.insert("multiple", Value::from(true));
            if screen_version >= 2 {
                persist.insert("cursor_mode", Value::from(1_u32));
            }
            request(&bus, SCREEN, "SelectSources", Some(&path), persist).await?;
            let mut results = request(&bus, iface, "Start", Some(&path), Options::new()).await?;
            let mut monitors = decode_monitors(results.remove("streams"))?;
            let granted = control
                && results
                    .get("devices")
                    .and_then(|v| u32::try_from(v).ok())
                    .is_some_and(|d| d & 3 == 3);
            let transport = if !granted {
                Transport::View
            } else if remote_version < 2 {
                Transport::Legacy
            } else {
                let fd = remote_fd(&bus, &path, REMOTE, "ConnectToEIS").await?;
                Transport::Eis(Eis::connect(fd, revoker).await?)
            };
            let mut display_ids = HashSet::new();
            for monitor in &mut monitors {
                if monitor.width == 0 {
                    let fd = remote_fd(&bus, &path, SCREEN, "OpenPipeWireRemote").await?;
                    let pixels = capture::capture(fd, monitor).await?;
                    (monitor.width, monitor.height) = (pixels.width, pixels.height);
                }
                monitor.id = public_display_id(
                    &monitor.id,
                    monitor.x,
                    monitor.y,
                    monitor.width,
                    monitor.height,
                );
                if monitor.id.len() > 128 || !display_ids.insert(monitor.id.clone()) {
                    return Err(Error::capture(
                        "Shared display identities are ambiguous. Select a display and capture a new baseline.",
                    ));
                }
            }
            let token = results
                .remove("restore_token")
                .and_then(|v| String::try_from(v).ok())
                .filter(|s| persistent && control == granted && !s.is_empty() && s.len() <= 4096);
            Ok((transport, monitors, token))
        };
        let (transport, monitors, token) = tokio::select! {
            biased;
            _ = revoked.wait_for(|v| *v) => return Err(Error::cancelled()),
            result = prepare => result?,
        };
        Ok((
            Self {
                bus,
                path,
                transport,
                remote: control,
                persistent: token.is_some(),
                monitors,
                revoked,
                _watcher: watcher,
                _system: system,
                handle,
            },
            token,
        ))
    }

    pub async fn pixels(&self, monitor: &Monitor) -> Result<capture::Pixels> {
        let fd = remote_fd(&self.bus, &self.path, SCREEN, "OpenPipeWireRemote").await?;
        capture::capture(fd, monitor).await
    }

    pub async fn close(self) {
        self.handle.close().await;
    }
}

async fn remote_fd(
    bus: &Connection,
    path: &ObjectPath<'_>,
    iface: &str,
    method: &str,
) -> Result<OwnedFd> {
    let fd: zbus::zvariant::OwnedFd = proxy(bus, DESKTOP, ROOT, iface)
        .await?
        .call(method, &(path, Options::new()))
        .await?;
    Ok(fd.into())
}

async fn request(
    bus: &Connection,
    iface: &str,
    method: &str,
    session: Option<&ObjectPath<'_>>,
    mut opts: Options<'_>,
) -> Result<Props> {
    let token = token();
    let path = bus::path(bus, "request", &token)?;
    let mut guard = Handle::new(bus, path.clone(), REQUEST);
    let request = proxy(bus, DESKTOP, &path, REQUEST).await?;
    let mut responses = request.receive_signal("Response").await?;
    opts.insert("handle_token", Value::from(token));
    let desktop = proxy(bus, DESKTOP, ROOT, iface).await?;
    let returned: OwnedObjectPath = match session {
        None => desktop.call(method, &(opts,)).await?,
        Some(session) if method == "Start" => desktop.call(method, &(session, "", opts)).await?,
        Some(session) => desktop.call(method, &(session, opts)).await?,
    };
    if returned.as_str() != path {
        Handle::new(bus, returned.to_string(), REQUEST)
            .close()
            .await;
        return Err(Error::new(
            "execution-failed",
            "The portal returned an unexpected request handle.",
        ));
    }
    let msg = tokio::time::timeout(Duration::from_secs(120), next(&mut responses))
        .await
        .map_err(|_| Error::new("timed-out", "The desktop portal consent request timed out."))?
        .ok_or_else(Error::cancelled)?;
    let (code, results): (u32, Props) = msg.body().deserialize()?;
    guard.disarm();
    match code {
        0 => Ok(results),
        1 => Err(Error::new(
            "permission-denied",
            "Desktop sharing was declined.",
        )),
        _ => Err(Error::new(
            "execution-failed",
            "The desktop portal failed to start sharing.",
        )),
    }
}

fn public_display_id(portal_id: &str, x: i32, y: i32, width: u32, height: u32) -> String {
    let digits = portal_id.strip_prefix('-').unwrap_or(portal_id);
    if portal_id.is_empty() {
        // PipeWire node numbers are recycled when a portal session closes.
        format!("geometry:{x},{y}:{width}x{height}")
    } else if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        format!("portal-{portal_id}")
    } else {
        portal_id.into()
    }
}

fn decode_monitors(value: Option<OwnedValue>) -> Result<Vec<Monitor>> {
    let streams: Vec<(u32, Props)> = value.ok_or_else(Error::denied)?.try_into()?;
    if streams.is_empty() || streams.len() > 64 {
        return Err(Error::denied());
    }
    let mut nodes = HashSet::new();
    let multiple = streams.len() > 1;
    streams
        .into_iter()
        .enumerate()
        .map(|(i, (node, mut p))| {
            let pair =
                |value: OwnedValue| <(i32, i32)>::try_from(zbus::zvariant::Value::from(value));
            let position = p.remove("position").map(pair).transpose()?;
            if multiple && position.is_none() {
                return Err(Error::capture(
                    "Shared monitors have no compositor positions.",
                ));
            }
            let (x, y) = position.unwrap_or_default();
            let (width, height) = match p.remove("size").map(pair).transpose()? {
                None => (0, 0),
                Some((w, h)) if w > 0 && h > 0 => (w as u32, h as u32),
                _ => return Err(Error::capture("Invalid logical monitor size.")),
            };
            let id = p
                .remove("id")
                .and_then(|v| String::try_from(v).ok())
                .filter(|s| !s.trim().is_empty() && s.len() <= 128)
                .unwrap_or_default();
            if !nodes.insert(node) || node == u32::MAX {
                return Err(Error::capture(
                    "The portal returned ambiguous monitor streams.",
                ));
            }
            Ok(Monitor {
                id,
                node,
                x,
                y,
                width,
                height,
                primary: i == 0,
                scale: (1., 1.),
                mapping: p.remove("mapping_id").map(String::try_from).transpose()?,
                serial: p.remove("pipewire-serial").map(u64::try_from).transpose()?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::public_display_id;

    #[test]
    fn display_ids_keep_numeric_aliases_separate_and_survive_pipewire_restarts() {
        assert_eq!(public_display_id("42", 0, 0, 100, 80), "portal-42");
        assert_eq!(public_display_id("DP-1", 0, 0, 100, 80), "DP-1");
        assert_eq!(
            public_display_id("", -100, 0, 100, 80),
            "geometry:-100,0:100x80"
        );
        assert_ne!(
            public_display_id("", -100, 0, 100, 80),
            public_display_id("", 0, 0, 100, 80)
        );
    }
}
