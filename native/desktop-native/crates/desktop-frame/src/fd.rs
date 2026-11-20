use std::{
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::net::UnixStream,
    },
    time::Instant,
};

pub(crate) fn inherited_vnc() -> io::Result<UnixStream> {
    // fcntl checks that fd 3 exists before we assume ownership of its new duplicate.
    let fd = unsafe { libc::fcntl(3, libc::F_DUPFD_CLOEXEC, 4) };
    if fd < 0 {
        return Err(io::Error::other(
            "expected a connected private Unix stream on fd 3",
        ));
    }
    let socket = unsafe { UnixStream::from_raw_fd(fd) };
    socket
        .peer_addr()
        .map_err(|_| io::Error::other("fd 3 is not a connected Unix socket"))?;
    let mut kind: libc::c_int = 0;
    let mut len = size_of_val(&kind) as libc::socklen_t;
    // peer_addr validates the family. SO_TYPE also rules out Unix datagram and sequenced packets.
    let result = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            (&raw mut kind).cast(),
            &mut len,
        )
    };
    if result != 0 || kind != libc::SOCK_STREAM {
        return Err(io::Error::other("fd 3 must be a Unix stream socket"));
    }
    Ok(socket)
}

pub(crate) struct Timed<T> {
    inner: T,
    deadline: Instant,
}

impl<T: AsRawFd> Timed<T> {
    pub(crate) fn new(inner: T, deadline: Instant) -> Self {
        Self { inner, deadline }
    }

    fn ready<R>(
        &mut self,
        events: i16,
        mut op: impl FnMut(&mut T) -> io::Result<R>,
    ) -> io::Result<R> {
        let mut fd = libc::pollfd {
            fd: self.inner.as_raw_fd(),
            events,
            revents: 0,
        };
        loop {
            let left = self.deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "capture input timed out",
                ));
            }
            let millis = left.as_nanos().div_ceil(1_000_000).min(i32::MAX as u128) as i32;
            // Only this live pollfd is borrowed. The inherited file-description flags stay intact.
            let ready = unsafe { libc::poll(&raw mut fd, 1, millis) };
            let result = match ready {
                0 => continue,
                -1 => Err(io::Error::last_os_error()),
                _ => op(&mut self.inner),
            };
            match result {
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) =>
                {
                    continue;
                }
                other => return other,
            }
        }
    }
}

impl<T: Read + AsRawFd> Read for Timed<T> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        self.ready(libc::POLLIN, |io| io.read(buf))
    }
}

impl<T: Write + AsRawFd> Write for Timed<T> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        self.ready(libc::POLLOUT, |io| io.write(buf))
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_expired_deadline_also_rejects_a_readable_fragment() {
        let (mut writer, reader) = UnixStream::pair().unwrap();
        writer.write_all(b"next").unwrap();
        let mut input = Timed::new(reader, Instant::now());
        assert_eq!(
            input.read(&mut [0; 4]).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
    }
}
