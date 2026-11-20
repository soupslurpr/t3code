use crate::{
    desktop::Desktop,
    error::{Error, Result},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{future::pending, io};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, watch},
};

#[derive(Deserialize)]
struct Request {
    id: String,
    method: String,
    params: Value,
}

#[derive(Clone, Copy, Default)]
struct Epoch {
    access: u64,
    input: u64,
}
struct Work {
    request: Request,
    epoch: Epoch,
}

fn response(id: &str, result: Result<Value>) -> Value {
    match result {
        Ok(v) => json!({"id":id,"ok":true,"result":v}),
        Err(e) => json!({"id":id,"ok":false,"error":e}),
    }
}

async fn line<R: AsyncBufRead + Unpin>(r: &mut R, out: &mut Vec<u8>) -> io::Result<Option<bool>> {
    const MAX: usize = 128 * 1024;
    out.clear();
    let mut overflow = false;
    loop {
        let buf = r.fill_buf().await?;
        if buf.is_empty() {
            return Ok((!out.is_empty() || overflow).then_some(!overflow));
        }
        let end = buf.iter().position(|b| *b == b'\n');
        let n = end.unwrap_or(buf.len());
        if n > MAX - out.len() {
            overflow = true;
        }
        if !overflow {
            out.extend_from_slice(&buf[..n]);
        }
        let consumed = n + usize::from(end.is_some());
        r.consume(consumed);
        if end.is_some() {
            return Ok(Some(!overflow));
        }
    }
}

async fn read<R: AsyncBufRead + Unpin>(
    mut input: R,
    jobs: mpsc::Sender<Work>,
    out: mpsc::Sender<Value>,
    generations: watch::Sender<Epoch>,
    waiting: watch::Receiver<Option<Value>>,
) {
    let mut buf = Vec::new();
    while let Ok(Some(valid)) = line(&mut input, &mut buf).await {
        let parsed = valid
            .then(|| serde_json::from_slice::<Request>(&buf).ok())
            .flatten()
            .filter(|r| !r.id.is_empty() && r.id.len() <= 256 && r.params.is_object());
        let Some(request) = parsed else {
            if out
                .send(response("", Err(Error::invalid("Invalid JSONL request."))))
                .await
                .is_err()
            {
                break;
            }
            continue;
        };
        if request.method == "status" {
            let status = waiting.borrow().clone();
            if let Some(s) = status {
                if out.send(response(&request.id, Ok(s))).await.is_err() {
                    break;
                }
                continue;
            }
        }
        generations.send_modify(|e| match request.method.as_str() {
            "release" | "forget" => {
                e.access += 1;
                e.input += 1;
            }
            "cancelPendingAccess" => e.access += 1,
            "releaseInputs" => e.input += 1,
            _ => {}
        });
        let epoch = *generations.borrow();
        if jobs.send(Work { request, epoch }).await.is_err() {
            break;
        }
    }
}

async fn revoked(rx: Option<watch::Receiver<bool>>) {
    if let Some(mut rx) = rx {
        let _ = rx.wait_for(|v| *v).await;
    } else {
        pending::<()>().await;
    }
}

async fn changes(rx: &mut watch::Receiver<Epoch>, old: Epoch, method: &str) {
    let access = matches!(
        method,
        "requestView" | "requestControl" | "rememberView" | "rememberControl"
    );
    let input = matches!(method, "act" | "snapshot");
    if !access && !input {
        return pending::<()>().await;
    }
    let _ = rx
        .wait_for(|e| (access && e.access != old.access) || (input && e.input != old.input))
        .await;
}

async fn work(
    mut jobs: mpsc::Receiver<Work>,
    out: mpsc::Sender<Value>,
    mut generations: watch::Receiver<Epoch>,
    waiting: watch::Sender<Option<Value>>,
) {
    let mut desktop = Desktop::new();
    loop {
        let session = desktop.session.as_ref().map(|s| s.revoked.clone());
        let job = tokio::select! {biased;
            _=revoked(session.clone())=>{desktop.release().await;continue;},
            job=jobs.recv()=>match job{Some(j)=>j,None=>break},
        };
        let Request { id, method, params } = job.request;
        let uses_session = matches!(method.as_str(), "act" | "snapshot");
        let is_access = matches!(
            method.as_str(),
            "requestView" | "requestControl" | "rememberView" | "rememberControl"
        );
        let mut result = tokio::select! {biased;
            _=changes(&mut generations,job.epoch,&method)=>Err(Error::cancelled()),
            _=revoked(session),if uses_session=>Err(Error::cancelled()),
            result=desktop.call(&method,&params,&waiting)=>result,
        };
        let pending_consent = waiting.send_replace(None).is_some();
        if pending_consent && result.is_err() {
            desktop.release().await;
        }
        if let Err(e) = &mut result {
            if is_access
                && !pending_consent
                && e.code == "request-cancelled"
                && params
                    .get("restoreToken")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
            {
                let detail = e.detail.get_or_insert_with(|| json!({}));
                if let Some(obj) = detail.as_object_mut() {
                    obj.insert("restoreTokenUnconsumed".into(), json!(true));
                }
            }
            if uses_session || e.code == "request-cancelled" {
                let cleanup = desktop.release_inputs().await;
                let detail = e.detail.get_or_insert_with(|| json!({}));
                if let Some(obj) = detail.as_object_mut() {
                    obj.insert("cleanup".into(), json!(cleanup));
                } else {
                    *detail = json!({"cleanup": cleanup});
                }
            }
        }
        if desktop
            .session
            .as_ref()
            .is_some_and(|s| *s.revoked.borrow())
        {
            desktop.release().await;
        }
        if out.send(response(&id, result)).await.is_err() {
            break;
        }
    }
    desktop.finish().await;
}

pub async fn run<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
    input: R,
    mut output: W,
) -> io::Result<()> {
    let (jobs, queue) = mpsc::channel(32);
    let (out, mut replies) = mpsc::channel(2);
    let (generations, observed) = watch::channel(Epoch::default());
    let (waiting, status) = watch::channel(None);
    let (broken, stop) = tokio::sync::oneshot::channel();
    let write = async {
        while let Some(reply) = replies.recv().await {
            let mut data = serde_json::to_vec(&reply)?;
            data.push(b'\n');
            output.write_all(&data).await?;
            output.flush().await?;
        }
        Ok::<(), io::Error>(())
    };
    let report = async {
        let result = write.await;
        if result.is_err() {
            let _ = broken.send(());
        }
        result
    };
    let reports = out.clone();
    let ingress = async move {
        tokio::select! { _=read(input,jobs,reports,generations.clone(),status)=>(),_=stop=>() }
        generations.send_modify(|e| {
            e.access += 1;
            e.input += 1;
        });
    };
    let (_, (), result) = tokio::join!(ingress, work(queue, out, observed, waiting), report);
    result
}
