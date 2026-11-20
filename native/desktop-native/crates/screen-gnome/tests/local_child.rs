use serde_json::{Value as Json, json};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader as StdReader},
    os::fd::OwnedFd,
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child as AsyncChild, ChildStdin, ChildStdout},
    sync::mpsc,
};
use zbus::{
    Connection,
    message::Header,
    zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value},
};

const DESKTOP: &str = "org.freedesktop.portal.Desktop";
const ROOT: &str = "/org/freedesktop/portal/desktop";
const REQUEST: &str = "org.freedesktop.portal.Request";
const SESSION: &str = "org.freedesktop.portal.Session";
type Props = HashMap<String, OwnedValue>;

struct Bus {
    process: Child,
    directory: PathBuf,
    address: String,
}

impl Bus {
    fn start() -> Self {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("t3-native-test-{}-{id}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let config = directory.join("bus.conf");
        let socket = directory.join("socket");
        fs::write(&config,format!("<busconfig><type>session</type><listen>unix:path={}</listen><auth>EXTERNAL</auth><policy context=\"default\"><allow own=\"*\"/><allow send_destination=\"*\"/><allow receive_sender=\"*\"/></policy></busconfig>",socket.display())).unwrap();
        let mut process = Command::new("dbus-daemon")
            .arg("--nofork")
            .arg("--print-address=1")
            .arg(format!("--config-file={}", config.display()))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut address = String::new();
        StdReader::new(process.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        Self {
            process,
            directory,
            address: address.trim().into(),
        }
    }
}
impl Drop for Bus {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[derive(Clone)]
struct Portal {
    log: Arc<Mutex<Vec<String>>>,
    interrupted: Arc<AtomicBool>,
    locked: Arc<AtomicBool>,
    create_response_code: Arc<std::sync::atomic::AtomicU32>,
    pending: mpsc::UnboundedSender<()>,
    closed: mpsc::UnboundedSender<()>,
    state: Arc<Mutex<Option<(String, String)>>>,
    version: u32,
    eis: Arc<Mutex<Option<OwnedFd>>>,
    video: Arc<Mutex<Option<pipewire_fixture::Source>>>,
    button_down: Arc<tokio::sync::Notify>,
}
impl Portal {
    fn record(&self, message: impl Into<String>) {
        self.log.lock().unwrap().push(message.into());
    }
    async fn response(
        &self,
        conn: &Connection,
        h: Header<'_>,
        method: &str,
        options: Props,
    ) -> OwnedObjectPath {
        self.record(method);
        let sender = h.sender().unwrap().as_str();
        let fragment = sender.trim_start_matches(':').replace('.', "_");
        let token = <&str>::try_from(&options["handle_token"]).unwrap();
        let path = OwnedObjectPath::try_from(format!("{ROOT}/request/{fragment}/{token}")).unwrap();
        let mut result = Props::new();
        if method.ends_with(".CreateSession") {
            let code = self.create_response_code.load(Ordering::SeqCst);
            if code != 0 {
                conn.emit_signal(Some(sender), &path, REQUEST, "Response", &(code, result))
                    .await
                    .unwrap();
                return path;
            }
            let token = <&str>::try_from(&options["session_handle_token"]).unwrap();
            let session = format!("{ROOT}/session/{fragment}/{token}");
            conn.object_server()
                .at(session.as_str(), MockSession(self.clone()))
                .await
                .unwrap();
            *self.state.lock().unwrap() = Some((sender.to_owned(), session.clone()));
            result.insert(
                "session_handle".into(),
                Value::from(session).try_into().unwrap(),
            );
        }
        if method.ends_with(".SelectDevices") || method.ends_with(".SelectSources") {
            let opts = (
                options
                    .get("persist_mode")
                    .and_then(|v| u32::try_from(v).ok()),
                options
                    .get("restore_token")
                    .and_then(|v| <&str>::try_from(v).ok()),
            );
            self.record(format!("persistence {opts:?}"));
        }
        if method.ends_with(".Start") {
            let mut monitor = Props::from([
                (
                    "position".into(),
                    Value::from((20_i32, -10_i32)).try_into().unwrap(),
                ),
                (
                    "size".into(),
                    Value::from((640_i32, 480_i32)).try_into().unwrap(),
                ),
                ("id".into(), Value::from("fixture").try_into().unwrap()),
            ]);
            let mut node = 7_u32;
            if let Some(source) = self.video.lock().unwrap().as_ref() {
                node = source.node;
                monitor.insert("pipewire-serial".into(), source.serial.into());
            }
            result.insert(
                "streams".into(),
                Value::from(vec![(node, monitor)]).try_into().unwrap(),
            );
            result.insert("devices".into(), 3_u32.into());
            result.insert(
                "restore_token".into(),
                Value::from("replacement-token").try_into().unwrap(),
            );
            if self.interrupted.load(Ordering::SeqCst) {
                conn.object_server()
                    .at(path.clone(), MockRequest(self.closed.clone()))
                    .await
                    .unwrap();
                self.pending.send(()).unwrap();
                return path;
            }
        }
        // The response deliberately precedes the method reply.
        conn.emit_signal(Some(sender), &path, REQUEST, "Response", &(0_u32, result))
            .await
            .unwrap();
        path
    }
}

struct MockSession(Portal);
#[zbus::interface(name = "org.freedesktop.portal.Session")]
impl MockSession {
    fn close(&self) {
        self.0.record("Session.Close");
    }
}

struct MockRequest(mpsc::UnboundedSender<()>);
#[zbus::interface(name = "org.freedesktop.portal.Request")]
impl MockRequest {
    fn close(&self) {
        let _ = self.0.send(());
    }
}

struct Screen(Portal);
#[zbus::interface(name = "org.freedesktop.portal.ScreenCast")]
impl Screen {
    #[zbus(name = "OpenPipeWireRemote")]
    fn open_pipe_wire_remote(
        &self,
        _session: ObjectPath<'_>,
        _opts: Props,
    ) -> zbus::zvariant::OwnedFd {
        self.0.record("OpenPipeWireRemote");
        let source = self.0.video.lock().unwrap().clone().unwrap();
        OwnedFd::from(UnixStream::connect(source.socket).unwrap()).into()
    }
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 {
        6
    }
    #[zbus(property)]
    fn available_source_types(&self) -> u32 {
        1
    }
    async fn create_session(
        &self,
        opts: Props,
        #[zbus(connection)] c: &Connection,
        #[zbus(header)] h: Header<'_>,
    ) -> OwnedObjectPath {
        self.0.response(c, h, "Screen.CreateSession", opts).await
    }
    async fn select_sources(
        &self,
        _s: ObjectPath<'_>,
        opts: Props,
        #[zbus(connection)] c: &Connection,
        #[zbus(header)] h: Header<'_>,
    ) -> OwnedObjectPath {
        self.0.response(c, h, "Screen.SelectSources", opts).await
    }
    async fn start(
        &self,
        _s: ObjectPath<'_>,
        _parent: &str,
        opts: Props,
        #[zbus(connection)] c: &Connection,
        #[zbus(header)] h: Header<'_>,
    ) -> OwnedObjectPath {
        self.0.response(c, h, "Screen.Start", opts).await
    }
}

struct Remote(Portal);
#[zbus::interface(name = "org.freedesktop.portal.RemoteDesktop")]
impl Remote {
    fn notify_pointer_button(&self, _s: ObjectPath<'_>, _opts: Props, b: i32, d: u32) {
        self.0.record(format!("button {b} {d}"));
        if d == 1 {
            self.0.button_down.notify_one();
        }
    }
    fn notify_pointer_motion_absolute(
        &self,
        _s: ObjectPath<'_>,
        _opts: Props,
        _node: u32,
        _x: f64,
        _y: f64,
    ) {
    }
    fn notify_pointer_motion(&self, _s: ObjectPath<'_>, _opts: Props, _x: f64, _y: f64) {}
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 {
        self.0.version
    }
    async fn create_session(
        &self,
        opts: Props,
        #[zbus(connection)] c: &Connection,
        #[zbus(header)] h: Header<'_>,
    ) -> OwnedObjectPath {
        self.0.response(c, h, "Remote.CreateSession", opts).await
    }
    async fn select_devices(
        &self,
        _s: ObjectPath<'_>,
        opts: Props,
        #[zbus(connection)] c: &Connection,
        #[zbus(header)] h: Header<'_>,
    ) -> OwnedObjectPath {
        self.0.response(c, h, "Remote.SelectDevices", opts).await
    }
    async fn start(
        &self,
        _s: ObjectPath<'_>,
        _parent: &str,
        opts: Props,
        #[zbus(connection)] c: &Connection,
        #[zbus(header)] h: Header<'_>,
    ) -> OwnedObjectPath {
        self.0.response(c, h, "Remote.Start", opts).await
    }
    fn notify_keyboard_keysym(&self, _s: ObjectPath<'_>, _opts: Props, key: i32, state: u32) {
        self.0.record(format!("key {key} {state}"));
    }
    #[zbus(name = "ConnectToEIS")]
    fn connect_to_eis(&self, _s: ObjectPath<'_>, _opts: Props) -> zbus::zvariant::OwnedFd {
        self.0.record("ConnectToEIS");
        if let Some(fd) = self.0.eis.lock().unwrap().take() {
            return fd.into();
        }
        let (client, peer) = UnixStream::pair().unwrap();
        drop(peer);
        OwnedFd::from(client).into()
    }
}

struct Power(Portal);
#[zbus::interface(name = "org.gnome.SessionManager")]
impl Power {
    fn inhibit(&self, _app: &str, _window: u32, _reason: &str, flags: u32) -> u32 {
        self.0.record(format!("inhibit {flags}"));
        17
    }
    fn uninhibit(&self, cookie: u32) {
        self.0.record(format!("uninhibit {cookie}"));
    }
}

struct LoginManager;
#[zbus::interface(name = "org.freedesktop.login1.Manager")]
impl LoginManager {
    fn get_session(&self, _id: &str) -> OwnedObjectPath {
        OwnedObjectPath::try_from("/org/freedesktop/login1/session/fixture").unwrap()
    }
}

struct LoginSession(Arc<AtomicBool>);
#[zbus::interface(name = "org.freedesktop.login1.Session")]
impl LoginSession {
    #[zbus(property)]
    fn locked_hint(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

struct Fixture {
    _bus: Bus,
    server: Connection,
    portal: Portal,
    child: AsyncChild,
    input: Option<ChildStdin>,
    output: Lines<BufReader<ChildStdout>>,
    pending: mpsc::UnboundedReceiver<()>,
    closed: mpsc::UnboundedReceiver<()>,
}
impl Fixture {
    async fn new(version: u32) -> Self {
        let bus = Bus::start();
        let (p, pending) = mpsc::unbounded_channel();
        let (c, closed) = mpsc::unbounded_channel();
        let portal = Portal {
            version,
            log: Arc::default(),
            interrupted: Arc::default(),
            locked: Arc::default(),
            create_response_code: Arc::default(),
            pending: p,
            closed: c,
            state: Arc::default(),
            eis: Arc::default(),
            video: Arc::default(),
            button_down: Arc::default(),
        };
        let server = zbus::connection::Builder::address(bus.address.as_str())
            .unwrap()
            .name(DESKTOP)
            .unwrap()
            .name("org.gnome.SessionManager")
            .unwrap()
            .name("org.freedesktop.login1")
            .unwrap()
            .serve_at(ROOT, Screen(portal.clone()))
            .unwrap()
            .serve_at(ROOT, Remote(portal.clone()))
            .unwrap()
            .serve_at("/org/gnome/SessionManager", Power(portal.clone()))
            .unwrap()
            .serve_at("/org/freedesktop/login1", LoginManager)
            .unwrap()
            .serve_at(
                "/org/freedesktop/login1/session/fixture",
                LoginSession(portal.locked.clone()),
            )
            .unwrap()
            .build()
            .await
            .unwrap();
        let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_t3-screen-gnome"))
            .env_clear()
            .env("DBUS_SESSION_BUS_ADDRESS", &bus.address)
            .env("DBUS_SYSTEM_BUS_ADDRESS", &bus.address)
            .env("XDG_SESSION_TYPE", "wayland")
            .env("HOME", &bus.directory)
            .env("XDG_RUNTIME_DIR", &bus.directory)
            .env("IBUS_ADDRESS", &bus.address)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let output = BufReader::new(child.stdout.take().unwrap()).lines();
        Self {
            _bus: bus,
            server,
            portal,
            child,
            input,
            output,
            pending,
            closed,
        }
    }
    async fn send(&mut self, id: &str, method: &str, params: Json) {
        let bytes = serde_json::to_vec(&json!({"id":id,"method":method,"params":params})).unwrap();
        let i = self.input.as_mut().unwrap();
        i.write_all(&bytes).await.unwrap();
        i.write_all(b"\n").await.unwrap();
    }
    async fn reply(&mut self) -> Json {
        let line = self
            .output
            .next_line()
            .await
            .unwrap()
            .expect("native reply");
        serde_json::from_str(&line).unwrap()
    }
    async fn call(&mut self, method: &str, params: Json) -> Json {
        self.send(method, method, params).await;
        self.reply().await
    }
    fn log(&self) -> Vec<String> {
        self.portal.log.lock().unwrap().clone()
    }
    async fn eof(&mut self) {
        self.input.take();
        assert!(self.child.wait().await.unwrap().success());
    }
}

#[tokio::test]
async fn availability_and_early_responses_are_independent_of_view_consent() {
    let mut f = Fixture::new(1).await;
    assert_eq!(
        f.call("status", json!({})).await["result"]["permission"],
        "prompt-required"
    );
    assert_eq!(
        f.call("requestAvailability", json!({})).await["result"]["keepAwake"],
        true
    );
    assert_eq!(f.log(), ["inhibit 12"]);
    let view = f
        .call("rememberView", json!({"restoreToken":"one-use-fixture"}))
        .await;
    assert_eq!(view["result"]["permission"], "view-only", "{view}");
    assert_eq!(view["result"]["restoreToken"], "replacement-token");
    let log = f.log();
    let existing = f
        .call("requestView", json!({"restoreToken":"replacement-token"}))
        .await;
    assert_eq!(existing["result"]["restoreToken"], "replacement-token");
    assert_eq!(f.log(), log);
    assert_eq!(
        view["result"]["displays"][0]["bounds"],
        json!({"x":20,"y":-10,"width":640,"height":480})
    );
    assert_eq!(
        f.call("act", json!({"action":{"type":"press","key":"Enter"}}))
            .await["error"]["code"],
        "permission-denied"
    );
    f.call("release", json!({})).await;
    let status = f.call("status", json!({})).await;
    assert_eq!(status["result"]["keepAwake"], true);
    assert_eq!(status["result"]["permission"], "remembered");
    f.portal.locked.store(true, Ordering::SeqCst);
    let locked = f
        .call("requestView", json!({"restoreToken":"replacement-token"}))
        .await;
    assert_eq!(locked["error"]["code"], "display-locked", "{locked}");
    assert_eq!(
        locked["error"]["detail"]["restoreTokenUnconsumed"], true,
        "{locked}"
    );
    f.portal.locked.store(false, Ordering::SeqCst);
    assert!(!f.log().iter().any(|s| s.starts_with("Remote.")));
    assert!(
        f.log()
            .contains(&"persistence (Some(2), Some(\"one-use-fixture\"))".into())
    );
    assert_eq!(
        f.call("releaseAvailability", json!({})).await["result"]["keepAwake"],
        false
    );
    f.eof().await;
    assert!(f.log().contains(&"uninhibit 17".into()));
}

#[tokio::test]
async fn cancelling_pending_start_closes_the_request_and_prevents_late_authorization() {
    let mut f = Fixture::new(1).await;
    f.portal.interrupted.store(true, Ordering::SeqCst);
    f.send("consent", "requestView", json!({})).await;
    f.pending.recv().await.unwrap();
    assert_eq!(
        f.call("status", json!({})).await["result"]["permission"],
        "pending"
    );
    f.send("cancel", "cancelPendingAccess", json!({})).await;
    let denied = f.reply().await;
    assert_eq!(denied["id"], "consent");
    assert_eq!(denied["error"]["code"], "request-cancelled");
    assert_eq!(f.reply().await["id"], "cancel");
    f.closed.recv().await.unwrap();
    assert_eq!(
        f.call("status", json!({})).await["result"]["displays"],
        json!([])
    );
    f.eof().await;
}

#[tokio::test]
async fn held_keys_release_on_failure_handoff_and_eof() {
    let mut f = Fixture::new(1).await;
    assert_eq!(
        f.call("requestControl", json!({})).await["result"]["permission"],
        "granted"
    );
    let duplicate = f
        .call(
            "act",
            json!({"action":{"type":"hotkey","keys":["ctrl","Control"]}}),
        )
        .await;
    assert_eq!(duplicate["error"]["code"], "invalid-action");
    for next in ["already-held", "error", "handoff", "eof"] {
        assert_eq!(
            f.call("act", json!({"action":{"type":"key_down","key":"Shift"}}))
                .await["ok"],
            true
        );
        match next {
            "already-held" => {
                let result = f
                    .call("act", json!({"action":{"type":"press","key":"Shift"}}))
                    .await;
                assert_eq!(result["error"]["code"], "invalid-action");
                assert_eq!(result["error"]["detail"]["cleanup"]["keys"], "released");
            }
            "error" => assert_eq!(
                f.call(
                    "act",
                    json!({"action":{"type":"press","key":"invalid-fixture-key"}})
                )
                .await["error"]["detail"]["cleanup"]["keys"],
                "released"
            ),
            "handoff" => assert_eq!(
                f.call("releaseInputs", json!({})).await["result"]["keys"],
                "released"
            ),
            _ => f.eof().await,
        }
    }
    assert_eq!(
        f.log()
            .into_iter()
            .filter(|s| s.starts_with("key "))
            .collect::<Vec<_>>(),
        [
            "key 65505 1",
            "key 65505 0",
            "key 65505 1",
            "key 65505 0",
            "key 65505 1",
            "key 65505 0",
            "key 65505 1",
            "key 65505 0"
        ]
    );
}

#[tokio::test]
async fn revoked_session_expires_and_eis_disconnect_never_selects_notify() {
    let mut f = Fixture::new(1).await;
    assert_eq!(
        f.call("requestControl", json!({})).await["result"]["permission"],
        "granted"
    );
    let (destination, path) = f.portal.state.lock().unwrap().clone().unwrap();
    f.send(
        "wait",
        "act",
        json!({"action":{"type":"wait","durationMs":60000}}),
    )
    .await;
    f.server
        .emit_signal(
            Some(destination.as_str()),
            path.as_str(),
            SESSION,
            "Closed",
            &(Props::new(),),
        )
        .await
        .unwrap();
    let reply = f.reply().await;
    assert!(matches!(
        reply["error"]["code"].as_str(),
        Some("permission-denied" | "request-cancelled")
    ));
    assert_eq!(
        f.call("status", json!({})).await["result"]["permission"],
        "prompt-required"
    );
    f.eof().await;

    let mut f = Fixture::new(2).await;
    f.portal.create_response_code.store(2, Ordering::SeqCst);
    let create_failed = f
        .call("requestControl", json!({"restoreToken":"saved-control"}))
        .await;
    assert_eq!(
        create_failed["error"]["code"], "execution-failed",
        "{create_failed}"
    );
    assert_eq!(
        create_failed["error"]["detail"]["restoreTokenUnconsumed"], true,
        "{create_failed}"
    );
    assert_eq!(
        f.call("status", json!({})).await["result"]["permission"],
        "prompt-required"
    );
    f.portal.create_response_code.store(0, Ordering::SeqCst);
    f.send(
        "queued-cancel",
        "requestControl",
        json!({"restoreToken":"saved-control"}),
    )
    .await;
    f.send("cancel-queued", "cancelPendingAccess", json!({}))
        .await;
    let cancelled = f.reply().await;
    assert_eq!(cancelled["id"], "queued-cancel", "{cancelled}");
    assert_eq!(
        cancelled["error"]["code"], "request-cancelled",
        "{cancelled}"
    );
    assert_eq!(
        cancelled["error"]["detail"]["restoreTokenUnconsumed"], true,
        "{cancelled}"
    );
    assert_eq!(
        cancelled["error"]["detail"]["cleanup"]["keys"], "not-needed",
        "{cancelled}"
    );
    assert_eq!(f.reply().await["id"], "cancel-queued");
    let reply = f.call("requestControl", json!({})).await;
    assert_eq!(reply["error"]["code"], "input-injection-failed", "{reply}");
    assert!(f.log().contains(&"ConnectToEIS".into()));
    assert_eq!(
        f.call("act", json!({"action":{"type":"press","key":"A"}}))
            .await["error"]["code"],
        "permission-denied"
    );
    assert!(!f.log().iter().any(|s| s.starts_with("key ")));
    f.eof().await;
}
#[path = "fixtures/eis.rs"]
mod eis_fixture;
#[path = "fixtures/pipewire.rs"]
mod pipewire_fixture;
#[path = "fixtures/text.rs"]
mod text_fixture;

#[tokio::test]
async fn eis_delivers_layout_keys_physical_keypad_and_discrete_wheel() {
    let mut f = Fixture::new(2).await;
    let mut peer = eis_fixture::Peer::open(&f._bus.directory);
    *f.portal.eis.lock().unwrap() = Some(peer.fd);
    let grant = f.call("requestControl", json!({})).await;
    assert_eq!(grant["result"]["permission"], "granted", "{grant}");
    for key in ["A", "NumpadEnter"] {
        let receipt = f
            .call("act", json!({"action":{"type":"press","key":key}}))
            .await;
        assert_eq!(receipt["ok"], true, "{receipt}");
    }
    for event in [(30, true), (30, false), (96, true), (96, false)] {
        assert_eq!(peer.keys.recv().await.unwrap(), event);
    }
    let wheel = f
        .call(
            "act",
            json!({"action":{"type":"wheel","horizontalTicks":-2,"verticalTicks":3}}),
        )
        .await;
    assert_eq!(wheel["ok"], true, "{wheel}");
    assert_eq!(peer.scroll.recv().await.unwrap(), (-240, 360));
    assert!(!f.log().iter().any(|s| s.starts_with("key ")));
    f.eof().await;
}
