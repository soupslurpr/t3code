use crate::bus::{Props, next};
use crate::{
    bus::{self, DESKTOP, ROOT, SCREEN, proxy},
    error::{Error, Result},
};
use tokio::{sync::watch, task::JoinHandle};
use zbus::{Connection, zvariant::OwnedObjectPath};

const MANAGER: &str = "org.gnome.SessionManager";
const MANAGER_PATH: &str = "/org/gnome/SessionManager";
const SAVER: &str = "org.gnome.ScreenSaver";
const SAVER_PATH: &str = "/org/gnome/ScreenSaver";

pub struct Power {
    pub bus: Option<Connection>,
    inhibitor: Option<u32>,
}

impl Power {
    pub fn new() -> Self {
        Self {
            bus: None,
            inhibitor: None,
        }
    }
    pub fn held(&self) -> bool {
        self.inhibitor.is_some()
    }

    pub async fn probe(&mut self) -> bool {
        if std::env::var("XDG_SESSION_TYPE").is_ok_and(|s| s != "wayland")
            || std::env::var("XDG_CURRENT_DESKTOP")
                .is_ok_and(|s| !s.split(':').any(|d| d.eq_ignore_ascii_case("gnome")))
        {
            return false;
        }
        if self.bus.is_none() {
            self.bus = bus::session_bus().await.ok();
        }
        let Some(conn) = &self.bus else { return false };
        let Ok(screen) = proxy(conn, DESKTOP, ROOT, SCREEN).await else {
            return false;
        };
        let ok = screen
            .get_property::<u32>("AvailableSourceTypes")
            .await
            .is_ok_and(|s| s & 1 == 1);
        if !ok && !self.held() {
            self.bus = None;
        }
        ok
    }

    pub async fn acquire(&mut self) -> Result<()> {
        if self.held() {
            return Ok(());
        }
        if self.bus.is_none() {
            self.bus = Some(bus::session_bus().await?);
        }
        let manager = proxy(self.bus.as_ref().unwrap(), MANAGER, MANAGER_PATH, MANAGER).await?;
        let cookie = manager
            .call(
                "Inhibit",
                &("T3 Code", 0_u32, "Keep this desktop available", 4_u32 | 8),
            )
            .await
            .map_err(|e| Error::new("keep-awake-denied", e))?;
        self.inhibitor = Some(cookie);
        Ok(())
    }

    pub async fn release(&mut self) -> Result<()> {
        if let Some(cookie) = self.inhibitor {
            let conn = self
                .bus
                .as_ref()
                .ok_or_else(|| Error::new("keep-awake-denied", "Lost inhibitor connection."))?;
            proxy(conn, MANAGER, MANAGER_PATH, MANAGER)
                .await?
                .call::<_, _, ()>("Uninhibit", &(cookie,))
                .await?;
            self.inhibitor = None;
        }
        Ok(())
    }

    pub async fn state(&self) -> &'static str {
        let Some(conn) = &self.bus else {
            return "unknown";
        };
        let saver = async {
            proxy(conn, SAVER, SAVER_PATH, SAVER)
                .await
                .ok()?
                .call::<_, _, bool>("GetActive", &())
                .await
                .ok()
        };
        let (locked, active) = tokio::join!(locked(), saver);
        match (locked, active) {
            (Some(true), _) => "locked",
            (_, Some(false)) => "active",
            (Some(false), Some(true)) => "blanked",
            _ => "unknown",
        }
    }

    pub async fn prepare(&self) -> Result<()> {
        match self.state().await {
            "locked" => Err(Error::new(
                "display-locked",
                "Unlock the desktop before sharing it.",
            )),
            "blanked" => {
                let conn = self.bus.as_ref().ok_or_else(Error::denied)?;
                proxy(conn, SAVER, SAVER_PATH, SAVER)
                    .await?
                    .call::<_, _, ()>("SimulateUserActivity", &())
                    .await?;
                for _ in 0..10 {
                    if self.state().await == "active" {
                        return Ok(());
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                Err(Error::new(
                    "display-inactive",
                    "The shared display is still inactive.",
                ))
            }
            _ => Ok(()),
        }
    }
}

async fn login_session() -> Option<(Connection, OwnedObjectPath)> {
    let conn = bus::local_bus(zbus::Address::system().ok()?, 1)
        .await
        .ok()?;
    let manager = proxy(
        &conn,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
    )
    .await
    .ok()?;
    let session: OwnedObjectPath = if let Ok(id) = std::env::var("XDG_SESSION_ID") {
        manager.call("GetSession", &(id,)).await.ok()?
    } else {
        manager.call("GetSession", &("auto",)).await.ok()?
    };
    Some((conn, session))
}

async fn locked() -> Option<bool> {
    let (conn, session) = login_session().await?;
    proxy(
        &conn,
        "org.freedesktop.login1",
        &session,
        "org.freedesktop.login1.Session",
    )
    .await
    .ok()?
    .get_property("LockedHint")
    .await
    .ok()
}

pub struct Revocations(Vec<JoinHandle<()>>);
impl Drop for Revocations {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

pub async fn revocations(bus: &Connection, revoked: &watch::Sender<bool>) -> Revocations {
    let mut tasks = Vec::new();
    if let Ok(saver) = proxy(bus, SAVER, SAVER_PATH, SAVER).await
        && let Ok(mut signals) = saver.receive_signal("ActiveChanged").await
    {
        let tx = revoked.clone();
        tasks.push(tokio::spawn(async move {
            while let Some(msg) = next(&mut signals).await {
                if msg.body().deserialize::<bool>().unwrap_or(false) {
                    tx.send_replace(true);
                    break;
                }
            }
        }));
    }
    if let Some((system, path)) = login_session().await {
        if let Ok(manager) = proxy(
            &system,
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
        )
        .await
            && let Ok(mut signals) = manager.receive_signal("PrepareForSleep").await
        {
            let tx = revoked.clone();
            tasks.push(tokio::spawn(async move {
                while let Some(msg) = next(&mut signals).await {
                    if msg.body().deserialize::<bool>().unwrap_or(false) {
                        tx.send_replace(true);
                        break;
                    }
                }
            }));
        }
        if let Ok(props) = proxy(
            &system,
            "org.freedesktop.login1",
            &path,
            "org.freedesktop.DBus.Properties",
        )
        .await
            && let Ok(mut changes) = props
                .receive_signal_with_args(
                    "PropertiesChanged",
                    &[(0, "org.freedesktop.login1.Session")],
                )
                .await
        {
            let tx = revoked.clone();
            tasks.push(tokio::spawn(async move {
                while let Some(msg) = next(&mut changes).await {
                    if let Ok((_, v, _)) = msg.body().deserialize::<(String, Props, Vec<String>)>()
                        && v.get("LockedHint").and_then(|p| bool::try_from(p).ok()) == Some(true)
                    {
                        tx.send_replace(true);
                        break;
                    }
                }
            }));
        }
    }
    Revocations(tasks)
}
