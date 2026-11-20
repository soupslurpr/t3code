use crate::error::{Error, Result};
use std::{
    collections::HashMap,
    future::poll_fn,
    pin::Pin,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use zbus::{
    Connection, Proxy,
    export::futures_core::Stream,
    proxy::CacheProperties,
    zvariant::{OwnedValue, Value},
};

pub const DESKTOP: &str = "org.freedesktop.portal.Desktop";
pub const ROOT: &str = "/org/freedesktop/portal/desktop";
pub const SCREEN: &str = "org.freedesktop.portal.ScreenCast";
pub const REMOTE: &str = "org.freedesktop.portal.RemoteDesktop";
pub const REQUEST: &str = "org.freedesktop.portal.Request";
pub const SESSION: &str = "org.freedesktop.portal.Session";
pub type Props = HashMap<String, OwnedValue>;
pub type Options<'a> = HashMap<&'static str, Value<'a>>;

pub fn token() -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(1);
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("t3_{time:x}_{}", SEQUENCE.fetch_add(1, Ordering::Relaxed))
}

pub async fn next<S: Stream + Unpin>(stream: &mut S) -> Option<S::Item> {
    poll_fn(|cx| Pin::new(&mut *stream).poll_next(cx)).await
}

pub async fn proxy<'a>(
    bus: &Connection,
    dest: &'a str,
    path: &'a str,
    iface: &'a str,
) -> zbus::Result<Proxy<'a>> {
    zbus::proxy::Builder::new(bus)
        .destination(dest)?
        .path(path)?
        .interface(iface)?
        .cache_properties(CacheProperties::No)
        .build()
        .await
}

pub async fn session_bus() -> Result<Connection> {
    local_bus(zbus::Address::session()?, 5).await
}

pub async fn local_bus(address: zbus::Address, timeout: u64) -> Result<Connection> {
    if !matches!(address.transport(), zbus::address::Transport::Unix(_)) {
        return Err(Error::new(
            "unsupported-operation",
            "A local Unix message bus is required.",
        ));
    }
    Ok(zbus::connection::Builder::address(address)?
        .method_timeout(std::time::Duration::from_secs(timeout))
        .build()
        .await?)
}

pub async fn version(bus: &Connection, iface: &str) -> Result<u32> {
    Ok(proxy(bus, DESKTOP, ROOT, iface)
        .await?
        .get_property("version")
        .await?)
}

pub struct Handle {
    bus: Connection,
    path: String,
    interface: &'static str,
    armed: bool,
}

impl Handle {
    pub fn new(bus: &Connection, path: String, interface: &'static str) -> Self {
        Self {
            bus: bus.clone(),
            path,
            interface,
            armed: true,
        }
    }

    pub fn disarm(&mut self) {
        self.armed = false;
    }

    pub async fn close(mut self) {
        if Self::send_close(&self.bus, &self.path, self.interface)
            .await
            .is_ok()
        {
            self.disarm();
        }
    }

    async fn send_close(bus: &Connection, path: &str, iface: &str) -> Result<()> {
        Ok(proxy(bus, DESKTOP, path, iface)
            .await?
            .call("Close", &())
            .await?)
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        if self.armed {
            let (bus, path, iface) = (self.bus.clone(), self.path.clone(), self.interface);
            tokio::spawn(async move {
                let _ = Self::send_close(&bus, &path, iface).await;
            });
        }
    }
}

pub fn path(bus: &Connection, kind: &str, token: &str) -> Result<String> {
    let sender = bus
        .unique_name()
        .ok_or_else(|| Error::new("execution-failed", "The session bus has no unique name."))?;
    Ok(format!(
        "{ROOT}/{kind}/{}/{}",
        sender.as_str().trim_start_matches(':').replace('.', "_"),
        token
    ))
}
