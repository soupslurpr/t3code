use super::{Fixture, Json, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    time::timeout,
};

#[derive(Clone)]
pub struct Source {
    pub node: u32,
    pub serial: u64,
    pub socket: PathBuf,
}

fn command(exe: &str, dir: &Path) -> Command {
    let mut cmd = Command::new(exe);
    cmd.env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", dir)
        .env("XDG_RUNTIME_DIR", dir)
        .env("PIPEWIRE_RUNTIME_DIR", dir)
        .env("PIPEWIRE_REMOTE", "pipewire-0")
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}/absent", dir.display()),
        )
        .env(
            "DBUS_SYSTEM_BUS_ADDRESS",
            format!("unix:path={}/absent", dir.display()),
        )
        .stdin(Stdio::null())
        .kill_on_drop(true);
    cmd
}

#[tokio::test]
async fn one_portal_fd_yields_actionable_primary_and_detail_frames() {
    let mut f = Fixture::new(1).await;
    let dir = f._bus.directory.join("synthetic-video");
    fs::create_dir(&dir).unwrap();
    let cfg = dir.join("fixture.conf");
    fs::write(&cfg,r#"
context.properties = { core.name=pipewire-0 core.daemon=true support.dbus=false mem.allow-mlock=false }
context.spa-libs = { support.*=support/libspa-support }
context.modules = [
 { name=libpipewire-module-protocol-native }
 { name=libpipewire-module-access }
 { name=libpipewire-module-spa-node-factory }
 { name=libpipewire-module-client-node }
 { name=libpipewire-module-link-factory }
 { name=libpipewire-module-metadata }
]
context.objects = [
 { factory=spa-node-factory args={ factory.name=support.node.driver node.name=FixtureDriver priority.driver=200000 } }
]
context.exec = [ { path="/usr/bin/echo" args="ready" } ]
"#).unwrap();
    let mut daemon = command("pipewire", &dir)
        .arg("-c")
        .arg(cfg)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let ready = BufReader::new(daemon.stdout.take().unwrap())
        .lines()
        .next_line()
        .await
        .unwrap();
    assert_eq!(ready.as_deref(), Some("ready"));
    let mut ports = command("stdbuf", &dir)
        .args(["-oL", "pw-link", "-m", "-i", "-o", "-I"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(ports.stdout.take().unwrap()).lines();
    let mut generator = command("gst-launch-1.0", &dir)
        .args([
            "-q",
            "videotestsrc",
            "is-live=true",
            "pattern=red",
            "!",
            "video/x-raw,format=RGBx,width=640,height=480,framerate=25/1",
            "!",
            "pipewiresink",
            "mode=provide",
            "stream-properties=props,node.name=FixtureVideo,media.class=Video/Source",
        ])
        .spawn()
        .unwrap();
    let producer = timeout(Duration::from_secs(5), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if let Some(port) = line
                .split_whitespace()
                .last()
                .filter(|port| port.starts_with("FixtureVideo:"))
            {
                return port.to_owned();
            }
        }
        panic!("Missing synthetic source");
    })
    .await
    .unwrap();
    let dump = command("pw-dump", &dir).output().await.unwrap();
    let graph: Vec<Json> = serde_json::from_slice(&dump.stdout).unwrap();
    let v = graph
        .iter()
        .find(|v| v["info"]["props"]["node.name"] == "FixtureVideo")
        .unwrap();
    let source = Source {
        node: v["id"].as_u64().unwrap() as u32,
        serial: v["info"]["props"]["object.serial"].as_u64().unwrap(),
        socket: dir.join("pipewire-0"),
    };
    *f.portal.video.lock().unwrap() = Some(source);
    let status = f.call("requestControl", json!({})).await;
    assert_eq!(status["result"]["permission"], "granted", "{status}");

    let snapshots = json!({"desktopId":"fixture","options":{"includeAccessibility":false,"screenshot":{"maxWidth":32,"maxHeight":24},
        "detailScreenshots":[{"id":"corner","maxWidth":8,"maxHeight":6,"region":{"coordinateSpace":"desktop-logical","displayId":"fixture","x":20,"y":-10,"width":320,"height":240}}]}});
    f.send("capture", "snapshot", snapshots).await;
    // The fixture has no session manager. Link only the synthetic generator to the consumer.
    let link = async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if let Some(port) = line
                .split_whitespace()
                .last()
                .filter(|name| name.contains(":input_"))
            {
                let result = command("pw-link", &dir)
                    .args(["-L", &producer, port])
                    .output()
                    .await
                    .unwrap();
                assert!(
                    result.status.success(),
                    "{}",
                    String::from_utf8_lossy(&result.stderr)
                );
                return;
            }
        }
        panic!("The synthetic PipeWire daemon exited.");
    };
    tokio::select! {
        result=timeout(Duration::from_secs(5),link)=>result.unwrap(),
        early=f.reply()=>panic!("Capture ended before negotiation: {early}"),
    }
    let reply = f.reply().await;
    assert_eq!(reply["ok"], true, "{reply}");
    let result = &reply["result"];
    assert_eq!(result["captureSource"], "remote-desktop-stream");
    assert_eq!(result["frame"]["width"], 32);
    let detail = &result["detailScreenshots"][0];
    assert_eq!(detail["frame"]["width"], 8);
    assert_ne!(detail["frame"]["id"], result["frame"]["id"]);
    assert_eq!(
        f.log()
            .iter()
            .filter(|m| m.as_str() == "OpenPipeWireRemote")
            .count(),
        1
    );
    let click = json!({"action":{"type":"click","frameId":detail["frame"]["id"],"x":1,"y":1}});
    let clicked = f.call("act", click.clone()).await;
    assert_eq!(clicked["ok"], true, "{clicked}");
    f.portal.button_down.notified().await;
    let status = f.call("status", json!({})).await;
    assert_eq!(status["result"]["cursor"], json!({"x":60.,"y":30.}));
    let drag = json!({"action":{"type":"drag","frameId":detail["frame"]["id"],"startX":1,"startY":1,
        "endX":5,"endY":3,"durationMs":5000,"steps":1}});
    f.send("drag", "act", drag).await;
    f.portal.button_down.notified().await;
    f.send("handoff", "releaseInputs", json!({})).await;
    let stopped = f.reply().await;
    assert_eq!(stopped["error"]["detail"]["cleanup"]["buttons"], "released");
    assert_eq!(f.reply().await["id"], "handoff");
    let buttons: Vec<_> = f
        .log()
        .into_iter()
        .filter(|line| line.starts_with("button "))
        .collect();
    assert_eq!(
        buttons,
        [
            "button 272 1",
            "button 272 0",
            "button 272 1",
            "button 272 0"
        ]
    );
    assert_eq!(f.call("act", click).await["error"]["code"], "stale-frame");
    f.eof().await;
    generator.kill().await.unwrap();
    ports.kill().await.unwrap();
    daemon.kill().await.unwrap();
}
