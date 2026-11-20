use crate::bus::proxy;
use std::time::Duration;
use tokio::time::timeout;
use zbus::Connection;

const ADDRESS: &str = "org.a11y.Bus";
const PATH: &str = "/org/a11y/bus";
const IFACE: &str = "org.a11y.Status";

#[derive(Default)]
pub struct Toolkit {
    changed: Option<Connection>,
}

impl Toolkit {
    pub async fn enable(&mut self, bus: &Connection) {
        let _ = timeout(Duration::from_millis(750), async {
            let p = proxy(bus, ADDRESS, PATH, IFACE).await?;
            if !p.get_property::<bool>("IsEnabled").await? {
                self.changed = Some(bus.clone());
                p.set_property("IsEnabled", true).await?;
            }
            Ok::<(), zbus::Error>(())
        })
        .await;
    }

    pub async fn restore(&mut self) {
        if let Some(bus) = self.changed.as_ref() {
            let _ = timeout(Duration::from_millis(750), async {
                let p = proxy(bus, ADDRESS, PATH, IFACE).await?;
                if !p.get_property::<bool>("ScreenReaderEnabled").await?
                    && p.get_property::<bool>("IsEnabled").await?
                {
                    p.set_property("IsEnabled", false).await?;
                }
                Ok::<(), zbus::Error>(())
            })
            .await;
            self.changed = None;
        }
    }
}
