use crate::{
    bus::{Props, proxy, token},
    error::{Error, Result},
};
use std::{process::Stdio, time::Duration};
use tokio::{
    process::Command,
    sync::watch,
    task::JoinHandle,
    time::{sleep, timeout},
};
use zbus::{
    Connection,
    zvariant::{OwnedObjectPath, OwnedValue, StructureBuilder, Value},
};

const IBUS: &str = "org.freedesktop.IBus";
const ROOT: &str = "/org/freedesktop/IBus";
const ENGINE: &str = "/org/freedesktop/IBus/Engine/T3";
const FACTORY: &str = "/org/freedesktop/IBus/Factory";

struct Factory {
    name: String,
}

#[zbus::interface(name = "org.freedesktop.IBus.Factory")]
impl Factory {
    fn create_engine(&self, name: &str) -> zbus::fdo::Result<OwnedObjectPath> {
        if self.name != name {
            return Err(zbus::fdo::Error::InvalidArgs("Unknown engine.".into()));
        }
        Ok(OwnedObjectPath::try_from(ENGINE).unwrap())
    }
}

struct Engine(watch::Sender<bool>);

#[zbus::interface(name = "org.freedesktop.IBus.Engine")]
impl Engine {
    fn focus_in(&self) {
        self.0.send_replace(true);
    }
    fn focus_out(&self) {
        self.0.send_replace(false);
    }
    fn enable(&self) {}
    fn disable(&self) {
        self.focus_out();
    }
    fn reset(&self) {}
    fn set_capabilities(&self, _caps: u32) {}
    fn set_cursor_location(&self, _x: i32, _y: i32, _w: i32, _h: i32) {}
    fn process_key_event(&self, _key: u32, _code: u32, _state: u32) -> bool {
        false
    }
}

fn component(name: &str) -> Result<Value<'_>> {
    let mut desc = StructureBuilder::new()
        .add_field("IBusEngineDesc")
        .add_field(Props::new());
    for s in [name, "T3 Code", "Exact text", "", "MIT", "", "", "default"] {
        desc.push_field(s);
    }
    desc.push_field(0_u32);
    for _ in 0..8 {
        desc.push_field("");
    }
    let engines = vec![Value::from(desc.build()?)];
    Ok(Value::from((
        "IBusComponent",
        Props::new(),
        name,
        "T3 Code",
        "1",
        "MIT",
        "",
        "",
        "",
        "",
        Vec::<Value>::new(),
        engines,
    )))
}

fn text_value(s: &str) -> Value<'_> {
    let attrs = Value::from(("IBusAttrList", Props::new(), Vec::<Value>::new()));
    Value::from(("IBusText", Props::new(), s, attrs))
}

async fn engine_name(bus: &zbus::Proxy<'_>) -> Result<String> {
    let value: OwnedValue = bus.get_property("GlobalEngine").await?;
    let mut desc: &Value<'_> = &value;
    while let Value::Value(inner) = desc {
        desc = inner;
    }
    if let Value::Structure(s) = desc
        && let Some(Value::Str(name)) = s.fields().get(2)
        && !name.is_empty()
    {
        return Ok(name.to_string());
    }
    Err(Error::text("IBus has no restorable active engine."))
}

pub struct Commit {
    cancel: watch::Sender<bool>,
    task: JoinHandle<Result<()>>,
}

impl Commit {
    pub fn start(text: String, interval: u64) -> Self {
        let (cancel, stop) = watch::channel(false);
        let task = tokio::spawn(run(text, interval, stop));
        Self { cancel, task }
    }
    pub async fn wait(&mut self) -> Result<()> {
        (&mut self.task).await.map_err(Error::text)?
    }
    pub async fn cancel(mut self) {
        self.cancel.send_replace(true);
        let _ = self.wait().await;
    }
}

async fn run(text: String, interval: u64, mut stop: watch::Receiver<bool>) -> Result<()> {
    if text.chars().any(char::is_control) {
        return Err(Error::text(
            "Literal control characters require an editable accessibility target.",
        ));
    }
    let name = token();
    let (focused, mut focus) = watch::channel(false);
    let discover = async {
        let address = Command::new("/usr/bin/ibus")
            .arg("address")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output()
            .await
            .map_err(Error::text)?;
        let address = std::str::from_utf8(&address.stdout)
            .map_err(Error::text)?
            .trim();
        if !address.starts_with("unix:") || address.contains(';') || address.len() > 4096 {
            return Err(Error::text("The local IBus session is unavailable."));
        }
        Ok(zbus::connection::Builder::address(address)?
            .method_timeout(Duration::from_secs(4))
            .serve_at(FACTORY, Factory { name: name.clone() })?
            .serve_at(ENGINE, Engine(focused))?
            .build()
            .await?)
    };
    let conn: Connection = tokio::select! {
        biased;
        _=stop.wait_for(|v|*v)=>return Err(Error::cancelled()),
        result=timeout(Duration::from_secs(4),discover)=>result.map_err(|_|Error::text("IBus discovery timed out."))??,
    };
    let ibus = proxy(&conn, IBUS, ROOT, IBUS).await?;
    let previous = engine_name(&ibus).await?;
    let context: OwnedObjectPath = ibus
        .get_property("CurrentInputContext")
        .await
        .map_err(|_| Error::text("IBus has no focused text input context."))?;
    ibus.call::<_, _, ()>("RegisterComponent", &(component(&name)?,))
        .await
        .map_err(Error::text)?;
    if *stop.borrow() {
        return Err(Error::cancelled());
    }
    // Finish activation even if cancelled. Selection changes asynchronously inside the daemon.
    let activation = ibus
        .call::<_, _, ()>("SetGlobalEngine", &(name.as_str(),))
        .await;
    let delivery = async {
        activation.map_err(Error::text)?;
        timeout(Duration::from_secs(4), focus.wait_for(|v| *v))
            .await
            .map_err(|_| Error::text("The IBus engine did not receive focus."))?
            .map_err(Error::text)?;
        let send = async |unit: &str| -> Result<()> {
            if !*focus.borrow()
                || ibus
                    .get_property::<OwnedObjectPath>("CurrentInputContext")
                    .await?
                    != context
            {
                return Err(Error::text("IBus focus changed during text entry."));
            }
            conn.emit_signal(
                None::<&str>,
                ENGINE,
                "org.freedesktop.IBus.Engine",
                "CommitText",
                &(text_value(unit),),
            )
            .await
            .map_err(Error::text)
        };
        if interval == 0 {
            send(&text).await?;
        } else {
            for ch in text.chars() {
                send(ch.encode_utf8(&mut [0; 4])).await?;
                sleep(Duration::from_millis(interval)).await;
            }
        }
        // A same-connection round trip orders the final CommitText before engine restoration.
        let _: OwnedObjectPath = ibus.get_property("CurrentInputContext").await?;
        Ok(())
    };
    let result = tokio::select! { biased; _=stop.wait_for(|v|*v)=>Err(Error::cancelled()), result=delivery=>result };
    if engine_name(&ibus)
        .await
        .is_ok_and(|selected| selected == name)
    {
        ibus.call::<_, _, ()>("SetGlobalEngine", &(previous.as_str(),))
            .await
            .map_err(|_| Error::text("The previous IBus engine could not be restored."))?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn serialized_component_and_text_match_ibus_wire_types() {
        let component = component("test").unwrap();
        assert_eq!(
            component.value_signature().to_string(),
            "(sa{sv}ssssssssavav)"
        );
        assert_eq!(text_value("猫").value_signature().to_string(), "(sa{sv}sv)");
    }
}
