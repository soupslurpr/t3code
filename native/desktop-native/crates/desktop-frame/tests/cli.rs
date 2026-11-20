use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Child, Command, Output, Stdio},
};

fn req(width: u32, height: u32) -> Value {
    json!({"desktopId":"user","display":{"id":"display-1","primary":true,"label":"Test","scaleFactor":1,
        "bounds":{"x":0,"y":0,"width":width,"height":height}},"frameId":"cli"})
}

fn command(args: &[&str]) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_t3-desktop-frame"));
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

fn write_input(child: &mut Child, header: Value, pixels: &[u8]) {
    let mut input = child.stdin.take().unwrap();
    writeln!(input, "{header}").unwrap();
    input.write_all(pixels).unwrap();
}

fn json_output(result: Output) -> Value {
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(result.stderr.is_empty());
    assert_eq!(result.stdout.iter().filter(|c| **c == b'\n').count(), 1);
    serde_json::from_slice(&result.stdout).unwrap()
}

fn failed(result: Output) -> String {
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert!(result.stderr.len() < 256);
    String::from_utf8(result.stderr).unwrap()
}

#[test]
fn raw_protocol_accepts_tight_or_padded_rows_and_requires_exact_length() {
    let oracle = "sha256-bgra8-v2:l8SqHkxTIMn3dDTz0iiVgixwLr6pt1schFIILAefTDs";
    let rows = [
        [30, 20, 10, 255, 60, 50, 40, 255],
        [90, 80, 70, 255, 120, 110, 100, 255],
    ];
    for padded in [false, true] {
        let mut header = json!({"width":2,"height":2,"request":req(2,2)});
        let mut pixels = Vec::new();
        for row in rows {
            pixels.extend_from_slice(&row);
            if padded {
                header["stride"] = json!(12);
                pixels.extend_from_slice(&[42; 4]);
            }
        }
        let mut child = command(&["raw"]).spawn().unwrap();
        write_input(&mut child, header.clone(), &pixels);
        assert_eq!(
            json_output(child.wait_with_output().unwrap())["screenshot"]["contentHash"],
            oracle
        );
        for len in [pixels.len() - 1, pixels.len() + 1] {
            let mut child = command(&["raw"]).spawn().unwrap();
            write_input(&mut child, header.clone(), &vec![0; len]);
            failed(child.wait_with_output().unwrap());
        }
    }
}

#[test]
fn rejects_unbounded_headers_dimensions_and_path_arguments() {
    let mut child = command(&["raw"]).spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let _ = stdin.write_all(&vec![b' '; 256 * 1024 + 1]);
    drop(stdin);
    assert!(failed(child.wait_with_output().unwrap()).contains("256 KiB"));
    for header in [
        json!({"width":16385,"height":1,"request":req(1,1)}),
        json!({"width":16384,"height":16384,"request":req(1,1)}),
        json!({"width":1,"height":2,"stride":u64::MAX,"request":req(1,1)}),
        json!({"width":1,"height":1,"path":"placeholder","request":req(1,1)}),
    ] {
        let mut child = command(&["raw"]).spawn().unwrap();
        write_input(&mut child, header, &[]);
        failed(child.wait_with_output().unwrap());
    }
    assert!(failed(command(&["vnc", "placeholder.sock"]).output().unwrap()).contains("usage"));
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        io::Read,
        os::{
            fd::AsRawFd,
            unix::{
                net::{UnixDatagram, UnixStream},
                process::CommandExt,
            },
        },
        time::Duration,
    };

    fn inherited(socket: &impl AsRawFd) -> Child {
        let fd = socket.as_raw_fd();
        let mut cmd = command(&["vnc"]);
        // In the forked child, dup2 installs the socket and fcntl handles the fd == 3 case.
        unsafe {
            cmd.pre_exec(move || {
                if libc::dup2(fd, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        cmd.spawn().unwrap()
    }

    fn read<const N: usize>(socket: &mut UnixStream) -> [u8; N] {
        let mut data = [0; N];
        socket.read_exact(&mut data).unwrap();
        data
    }

    fn fragmented(socket: &mut UnixStream, bytes: &[u8]) {
        for part in bytes.chunks(2) {
            socket.write_all(part).unwrap();
        }
    }

    fn session(version: &[u8; 12], width: u16, height: u16) -> (Child, UnixStream) {
        let (client, mut server) = UnixStream::pair().unwrap();
        client.set_nonblocking(true).unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut child = inherited(&client);
        drop(client);
        write_input(
            &mut child,
            json!({"request":req(width.into(),height.into())}),
            &[],
        );
        fragmented(&mut server, version);
        assert_eq!(&read::<12>(&mut server), version);
        fragmented(&mut server, &[2, 2, 1]);
        assert_eq!(read::<1>(&mut server), [1]);
        if version == b"RFB 003.008\n" {
            fragmented(&mut server, &[0; 4]);
        }
        assert_eq!(read::<1>(&mut server), [1]);
        let mut init = [0; 24];
        init[..2].copy_from_slice(&width.to_be_bytes());
        init[2..4].copy_from_slice(&height.to_be_bytes());
        init[20..].copy_from_slice(&4_u32.to_be_bytes());
        fragmented(&mut server, &init);
        fragmented(&mut server, b"test");
        assert_eq!(
            read::<20>(&mut server),
            [
                0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0
            ]
        );
        assert_eq!(read::<8>(&mut server), [2, 0, 0, 1, 0, 0, 0, 0]);
        full_request(&mut server, width, height);
        (child, server)
    }

    fn full_request(server: &mut UnixStream, width: u16, height: u16) {
        let request = read::<10>(server);
        assert_eq!(&request[..6], [3, 0, 0, 0, 0, 0]);
        assert_eq!(&request[6..8], width.to_be_bytes());
        assert_eq!(&request[8..], height.to_be_bytes());
    }

    fn rectangle(server: &mut UnixStream, x: u16, y: u16, w: u16, h: u16, encoding: i32) {
        for n in [x, y, w, h] {
            fragmented(server, &n.to_be_bytes());
        }
        fragmented(server, &encoding.to_be_bytes());
    }

    #[test]
    fn fd3_negotiates_fragmented_rfb_and_requires_full_pixel_coverage() {
        for version in [b"RFB 003.007\n", b"RFB 003.008\n"] {
            let (child, mut server) = session(version, 2, 1);
            fragmented(
                &mut server,
                &[
                    2, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 2, b'o', b'k',
                ],
            );
            fragmented(&mut server, &[0, 0, 0, 0]);
            full_request(&mut server, 2, 1);
            fragmented(&mut server, &[0, 0, 0, 2]);
            for color in [[0, 0, 0, 2], [10, 20, 30, 0]] {
                rectangle(&mut server, 0, 0, 1, 1, 0);
                fragmented(&mut server, &color);
            }
            full_request(&mut server, 2, 1);
            fragmented(&mut server, &[0, 0, 0, 1]);
            rectangle(&mut server, 1, 0, 1, 1, 0);
            fragmented(&mut server, &[40, 50, 60, 77]);
            drop(server);
            let output = json_output(child.wait_with_output().unwrap());
            assert_eq!(
                output["screenshot"]["contentHash"],
                "sha256-bgra8-v2:Qpvp31nzF-c2xzb5GrjrbRA4w2mglUYh0N0A2_nMsgY"
            );
        }
    }

    #[test]
    fn rejects_bad_rectangles_truncation_and_oversized_server_messages() {
        for (x, w, h, encoding) in [(0, 0, 1, 0), (1, 2, 1, 0), (0, 2, 2, 0), (0, 2, 1, 1)] {
            let (child, mut server) = session(b"RFB 003.008\n", 2, 1);
            fragmented(&mut server, &[0, 0, 0, 1]);
            rectangle(&mut server, x, 0, w, h, encoding);
            assert!(
                failed(child.wait_with_output().unwrap()).contains("invalid raw VNC rectangle")
            );
        }
        let (child, mut server) = session(b"RFB 003.008\n", 2, 1);
        fragmented(&mut server, &[0, 0, 0, 1]);
        rectangle(&mut server, 0, 0, 2, 1, 0);
        fragmented(&mut server, &[0; 7]);
        drop(server);
        failed(child.wait_with_output().unwrap());
        let (child, mut server) = session(b"RFB 003.008\n", 2, 1);
        fragmented(&mut server, &[3, 0, 0, 0, 255, 255, 255, 255]);
        assert!(failed(child.wait_with_output().unwrap()).contains("clipboard"));
    }

    #[test]
    fn vnc_consumes_only_a_connected_unix_stream_and_declines_authentication() {
        let (client, _) = UnixDatagram::pair().unwrap();
        assert!(failed(inherited(&client).wait_with_output().unwrap()).contains("stream"));
        let (client, mut server) = UnixStream::pair().unwrap();
        let mut child = inherited(&client);
        drop(client);
        write_input(&mut child, json!({"request":req(1,1)}), &[]);
        server.write_all(b"RFB 003.008\n").unwrap();
        assert_eq!(&read::<12>(&mut server), b"RFB 003.008\n");
        server.write_all(&[1, 2]).unwrap();
        assert!(failed(child.wait_with_output().unwrap()).contains("security type None"));
    }
}
