#[cfg(unix)]
mod fd;
#[cfg(unix)]
mod vnc;

use frame::{CaptureRequest, bgra_len, render_bgra};
use serde::{Deserialize, de::DeserializeOwned};
use std::{
    error::Error,
    io::{self, BufRead, BufWriter, Read, Write},
    process::ExitCode,
    time::Duration,
};

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;
const INPUT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HEADER: usize = 256 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawInput {
    width: u32,
    height: u32,
    stride: Option<usize>,
    request: CaptureRequest,
}

#[derive(Deserialize)]
#[cfg(unix)]
#[serde(deny_unknown_fields)]
struct VncInput {
    request: CaptureRequest,
}

struct Bitmap {
    width: u32,
    height: u32,
    stride: usize,
    pixels: Vec<u8>,
}

fn header<T: DeserializeOwned>(input: &mut impl BufRead) -> Result<T> {
    let mut line = Vec::new();
    input
        .take((MAX_HEADER + 1) as u64)
        .read_until(b'\n', &mut line)?;
    if line.len() > MAX_HEADER || !line.ends_with(b"\n") {
        return Err("expected a JSON line of at most 256 KiB".into());
    }
    serde_json::from_slice(&line)
        .map_err(|error| format!("invalid JSON header at column {}", error.column()).into())
}

fn raw(input: &mut impl BufRead) -> Result<(CaptureRequest, Bitmap)> {
    let RawInput {
        width,
        height,
        stride,
        request,
    } = header(input)?;
    let stride = stride.unwrap_or_else(|| (width as usize).saturating_mul(4));
    let mut pixels = vec![0; bgra_len(width, height, stride)?];
    input.read_exact(&mut pixels)?;
    if !input.fill_buf()?.is_empty() {
        return Err("unexpected data after raw BGRA frame".into());
    }
    Ok((
        request,
        Bitmap {
            width,
            height,
            stride,
            pixels,
        },
    ))
}

enum Mode {
    Raw,
    Vnc,
}

fn mode() -> Result<Mode> {
    let mut args = std::env::args_os().skip(1);
    match (args.next().as_deref().and_then(|s| s.to_str()), args.next()) {
        (Some("raw"), None) => Ok(Mode::Raw),
        (Some("vnc"), None) => Ok(Mode::Vnc),
        _ => Err("usage: t3-desktop-frame raw | vnc".into()),
    }
}

#[cfg(unix)]
fn capture(mode: Mode) -> Result<(CaptureRequest, Bitmap)> {
    use std::{fs::File, io::BufReader, os::fd::AsFd, time::Instant};
    let deadline = Instant::now() + INPUT_TIMEOUT;
    // Check fd 3 before opening another descriptor: a missing inherited fd must stay missing.
    let socket = match mode {
        Mode::Raw => None,
        Mode::Vnc => Some(fd::inherited_vnc()?),
    };
    let stdin = File::from(io::stdin().as_fd().try_clone_to_owned()?);
    let mut input = BufReader::new(fd::Timed::new(stdin, deadline));
    if let Some(socket) = socket {
        let VncInput { request } = header(&mut input)?;
        Ok((request, vnc::capture(fd::Timed::new(socket, deadline))?))
    } else {
        raw(&mut input)
    }
}

#[cfg(not(unix))]
fn capture(mode: Mode) -> Result<(CaptureRequest, Bitmap)> {
    if matches!(mode, Mode::Vnc) {
        return Err("vnc requires a connected private Unix socket on fd 3".into());
    }
    let (send, recv) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = send.send(raw(&mut io::stdin().lock()));
    });
    Ok(recv.recv_timeout(INPUT_TIMEOUT)??)
}

fn run() -> Result<()> {
    let (request, bitmap) = capture(mode()?)?;
    let output = render_bgra(
        bitmap.width,
        bitmap.height,
        bitmap.stride,
        &bitmap.pixels,
        &request,
    )?;
    let mut stdout = BufWriter::new(io::stdout().lock());
    serde_json::to_writer(&mut stdout, &output)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("t3-desktop-frame: {error}");
            ExitCode::FAILURE
        }
    }
}
