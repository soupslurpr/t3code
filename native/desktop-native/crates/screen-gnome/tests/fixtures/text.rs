use super::{Fixture, Props, json};
use atspi::{Interface, InterfaceSet, State, StateSet};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;
use zbus::{
    Connection,
    message::Header,
    zvariant::{OwnedObjectPath, Value},
};

const ROOT: &str = "/org/a11y/atspi/accessible/root";
const APP: &str = "/fixture/app";
const WINDOW: &str = "/fixture/window";
const ENTRY: &str = "/fixture/entry";

struct AccessibilityBus(String);
#[zbus::interface(name = "org.a11y.Bus")]
impl AccessibilityBus {
    fn get_address(&self) -> String {
        self.0.clone()
    }
}

#[derive(Clone, Default)]
pub struct Field {
    pub value: Arc<Mutex<Vec<char>>>,
    pub detached: Arc<AtomicBool>,
    caret: Arc<Mutex<i32>>,
}

#[derive(Clone)]
struct Accessible {
    path: &'static str,
    sender: String,
    detached: Arc<AtomicBool>,
}
#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl Accessible {
    fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
        let child = match self.path {
            ROOT => APP,
            APP => WINDOW,
            WINDOW if !self.detached.load(Ordering::Relaxed) => ENTRY,
            _ => return vec![],
        };
        vec![(
            self.sender.clone(),
            OwnedObjectPath::try_from(child).unwrap(),
        )]
    }
    #[zbus(property)]
    fn name(&self) -> &str {
        match self.path {
            APP => "Fixture",
            WINDOW => "Window",
            ENTRY => "Field",
            _ => "Registry",
        }
    }
    #[zbus(property)]
    fn description(&self) -> &str {
        ""
    }
    fn get_role_name(&self) -> &str {
        match self.path {
            WINDOW => "frame",
            ENTRY => "entry",
            _ => "application",
        }
    }
    fn get_state(&self) -> StateSet {
        let mut state = StateSet::new(State::Visible | State::Enabled | State::Showing);
        if self.path == WINDOW {
            state.insert(State::Active);
        }
        if self.path == ENTRY {
            state.insert(State::Focused | State::Editable | State::MultiLine);
        }
        state
    }
    fn get_interfaces(&self) -> InterfaceSet {
        InterfaceSet::new(
            Interface::Accessible
                | Interface::Text
                | Interface::EditableText
                | Interface::Component,
        )
    }
}

struct Component;
#[zbus::interface(name = "org.a11y.atspi.Component")]
impl Component {
    fn get_extents(&self, _space: u32) -> (i32, i32, i32, i32) {
        (0, 0, 320, 170)
    }
    fn grab_focus(&self) -> bool {
        true
    }
}

struct Text(Field);
#[zbus::interface(name = "org.a11y.atspi.Text")]
impl Text {
    #[zbus(property)]
    fn character_count(&self) -> i32 {
        self.0.value.lock().unwrap().len() as i32
    }
    #[zbus(property)]
    fn caret_offset(&self) -> i32 {
        *self.0.caret.lock().unwrap()
    }
    fn set_caret_offset(&self, pos: i32) -> bool {
        *self.0.caret.lock().unwrap() = pos;
        true
    }
    fn get_n_selections(&self) -> i32 {
        0
    }
    fn get_text(&self, start: i32, end: i32) -> String {
        self.0.value.lock().unwrap()[start as usize..end as usize]
            .iter()
            .collect()
    }
}
struct Edit(Field);
#[zbus::interface(name = "org.a11y.atspi.EditableText")]
impl Edit {
    fn insert_text(&self, pos: i32, value: &str, bytes: i32) -> bool {
        assert_eq!(value.len() as i32, bytes);
        self.0
            .value
            .lock()
            .unwrap()
            .splice(pos as usize..pos as usize, value.chars());
        true
    }
}

pub async fn accessibility(f: &Fixture) -> Field {
    let c = &f.server;
    c.request_name("org.a11y.Bus").await.unwrap();
    c.request_name("org.a11y.atspi.Registry").await.unwrap();
    let s = c.object_server();
    s.at("/org/a11y/bus", AccessibilityBus(f._bus.address.clone()))
        .await
        .unwrap();
    let field = Field::default();
    for path in [ROOT, APP, WINDOW, ENTRY] {
        s.at(
            path,
            Accessible {
                path,
                sender: c.unique_name().unwrap().to_string(),
                detached: field.detached.clone(),
            },
        )
        .await
        .unwrap();
    }
    for path in [WINDOW, ENTRY] {
        s.at(path, Component).await.unwrap();
    }
    s.at(ENTRY, Text(field.clone())).await.unwrap();
    s.at(ENTRY, Edit(field.clone())).await.unwrap();
    field
}

#[derive(Clone)]
pub struct IBus {
    pub selected: Arc<Mutex<String>>,
    pub commits: Arc<Mutex<Vec<String>>>,
    pub committed: Arc<Notify>,
    context_budget: Arc<Mutex<u32>>,
    paused: Arc<Notify>,
    resume: Arc<Notify>,
    watchers: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}

#[zbus::interface(name = "org.freedesktop.IBus")]
impl IBus {
    #[zbus(property)]
    fn global_engine(&self) -> Value<'static> {
        Value::from((
            "IBusEngineDesc",
            Props::new(),
            self.selected.lock().unwrap().clone(),
        ))
    }
    #[zbus(property)]
    async fn current_input_context(&self) -> OwnedObjectPath {
        let pause = {
            let mut budget = self.context_budget.lock().unwrap();
            let pause = *budget == 1;
            *budget = budget.saturating_sub(1);
            pause
        };
        if pause {
            self.paused.notify_one();
            self.resume.notified().await;
        }
        OwnedObjectPath::try_from("/fixture/context").unwrap()
    }
    async fn register_component(
        &self,
        component: Value<'_>,
        #[zbus(connection)] c: &Connection,
        #[zbus(header)] h: Header<'_>,
    ) {
        assert_eq!(
            component.value_signature().to_string(),
            "(sa{sv}ssssssssavav)"
        );
        let source = h.sender().unwrap().clone();
        let engine = zbus::Proxy::new(
            c,
            source,
            "/org/freedesktop/IBus/Engine/T3",
            "org.freedesktop.IBus.Engine",
        )
        .await
        .unwrap();
        let mut commits = engine.receive_signal("CommitText").await.unwrap();
        let store = self.commits.clone();
        let received = self.committed.clone();
        self.watchers.lock().unwrap().push(tokio::spawn(async move {
            use std::{future::poll_fn, pin::Pin};
            use zbus::export::futures_core::Stream;
            while let Some(msg) = poll_fn(|cx| Pin::new(&mut commits).poll_next(cx)).await {
                let body = msg.body();
                let Value::Structure(text) = body.deserialize::<Value>().unwrap() else {
                    panic!("IBus text");
                };
                let Value::Str(s) = &text.fields()[2] else {
                    panic!("IBus string");
                };
                store.lock().unwrap().push(s.to_string());
                received.notify_one();
            }
        }));
    }

    async fn set_global_engine(
        &self,
        name: &str,
        #[zbus(connection)] c: &Connection,
        #[zbus(header)] h: Header<'_>,
    ) {
        if name != "fixture-previous" {
            let owner = h.sender().unwrap().as_str();
            let factory = zbus::Proxy::new(
                c,
                owner,
                "/org/freedesktop/IBus/Factory",
                "org.freedesktop.IBus.Factory",
            )
            .await
            .unwrap();
            let path: OwnedObjectPath = factory.call("CreateEngine", &(name,)).await.unwrap();
            let engine = zbus::Proxy::new(c, owner, path.as_str(), "org.freedesktop.IBus.Engine")
                .await
                .unwrap();
            engine.call::<_, _, ()>("FocusIn", &()).await.unwrap();
        }
        *self.selected.lock().unwrap() = name.into();
    }
}

pub async fn ibus(f: &Fixture) -> IBus {
    f.server.request_name("org.freedesktop.IBus").await.unwrap();
    let ibus = IBus {
        selected: Arc::new(Mutex::new("fixture-previous".into())),
        commits: Arc::default(),
        committed: Arc::default(),
        context_budget: Arc::default(),
        paused: Arc::default(),
        resume: Arc::default(),
        watchers: Arc::default(),
    };
    f.server
        .object_server()
        .at("/org/freedesktop/IBus", ibus.clone())
        .await
        .unwrap();
    ibus
}

#[tokio::test]
async fn handoff_cancels_partial_input_method_text_and_restores_the_engine() {
    let mut f = Fixture::new(1).await;
    let ibus = ibus(&f).await;
    assert_eq!(f.call("requestControl", json!({})).await["ok"], true);
    // Stop inside the context check for the second code point.
    *ibus.context_budget.lock().unwrap() = 3;
    f.send(
        "typing",
        "act",
        json!({"action":{"type":"insert_text","text":"猫犬","intervalMs":1}}),
    )
    .await;
    ibus.paused.notified().await;
    ibus.committed.notified().await;
    f.send("handoff", "releaseInputs", json!({})).await;
    let cancelled = f.reply().await;
    assert_eq!(
        cancelled["error"]["code"], "request-cancelled",
        "{cancelled}"
    );
    assert_eq!(f.reply().await["id"], "handoff");
    ibus.resume.notify_one();
    f.eof().await;
    assert_eq!(ibus.selected.lock().unwrap().as_str(), "fixture-previous");
    assert_eq!(*ibus.commits.lock().unwrap(), ["猫"]);
}

#[tokio::test]
async fn semantic_ids_expire_and_editable_text_confirms_literal_unicode() {
    let mut f = Fixture::new(1).await;
    let field = accessibility(&f).await;
    assert_eq!(f.call("requestControl", json!({})).await["ok"], true);
    let params = json!({"desktopId":"fixture","options":{"screenshot":false}});
    let first = f.call("snapshot", params.clone()).await;
    let id = first["result"]["accessibility"]["targets"][0]["id"].clone();
    assert!(id.is_string(), "{first}");
    f.call("snapshot", params.clone()).await;
    assert_eq!(
        f.call("act", json!({"action":{"type":"activate","targetId":id}}))
            .await["error"]["code"],
        "stale-semantic-target"
    );
    let attached = f.call("snapshot", params.clone()).await;
    let field_id = &attached["result"]["accessibility"]["targets"][0]["id"];
    field.detached.store(true, Ordering::Relaxed);
    let activation = f
        .call(
            "act",
            json!({"action":{"type":"activate","targetId":field_id}}),
        )
        .await;
    assert_eq!(activation["error"]["code"], "stale-semantic-target");
    field.detached.store(false, Ordering::Relaxed);
    let now = f.call("snapshot", params).await;
    let id = &now["result"]["accessibility"]["targets"][0]["id"];
    assert_eq!(
        f.call("act", json!({"action":{"type":"activate","targetId":id}}))
            .await["ok"],
        true
    );
    let text = "猫\t😀\nλ";
    let receipt = f
        .call(
            "act",
            json!({"action":{"type":"type","text":text,"verification":"required","submit":true}}),
        )
        .await;
    assert_eq!(receipt["result"]["confirmedCodePoints"], 5, "{receipt}");
    assert_eq!(receipt["result"]["submission"], "submitted");
    assert_eq!(field.value.lock().unwrap().iter().collect::<String>(), text);
    f.eof().await;
}

#[tokio::test]
async fn input_method_commits_unicode_and_restores_previous_engine() {
    let mut f = Fixture::new(1).await;
    let ibus = ibus(&f).await;
    assert_eq!(f.call("requestControl", json!({})).await["ok"], true);
    let blocked = f
        .call(
            "act",
            json!({"action":{"type":"type","text":"before\tafter"}}),
        )
        .await;
    assert_eq!(blocked["error"]["code"], "exact-text-unavailable");
    let receipt = f
        .call(
            "act",
            json!({"action":{"type":"type","text":"猫😀","submit":true,"verification":"required"}}),
        )
        .await;
    assert_eq!(receipt["result"]["delivery"], "input-method", "{receipt}");
    assert_eq!(receipt["result"]["acceptedCodePoints"], 2);
    assert_eq!(receipt["result"]["submission"], "withheld-unverified");
    ibus.committed.notified().await;
    assert_eq!(ibus.selected.lock().unwrap().as_str(), "fixture-previous");
    assert_eq!(*ibus.commits.lock().unwrap(), ["猫😀"]);
    assert!(!f.log().iter().any(|s| s.starts_with("key ")));
    f.eof().await;
}
