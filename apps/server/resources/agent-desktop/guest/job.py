"""Stream one systemd-owned guest command across bounded QGA exchanges."""
import base64
import fcntl
import json
import os
import pty
import pwd
import selectors
import shutil
import signal
import socket
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

WINDOW = 1024 * 1024
PAGE = 64 * 1024
MAX_REQUEST = 2 * WINDOW


def reply(stream, value):
    stream.write(json.dumps(value, separators=(",", ":")).encode() + b"\n")
    stream.flush()


def terminal_size(fd, columns, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


def child_process(settings):
    account = pwd.getpwnam(settings["user"])
    terminal = settings["terminal"]
    master, slave = pty.openpty() if terminal else (None, None)
    if terminal:
        terminal_size(master, terminal["columns"], terminal["rows"])

    def prepare():
        os.setsid()
        if slave is not None:
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        os.initgroups(account.pw_name, account.pw_gid)
        os.setgid(account.pw_gid)
        os.setuid(account.pw_uid)
        os.chdir(settings["cwd"])

    try:
        child = subprocess.Popen(
            [settings["executable"], *settings["args"]], env=settings["environment"],
            stdin=slave if terminal else subprocess.PIPE, stdout=slave if terminal else subprocess.PIPE,
            stderr=slave if terminal else subprocess.PIPE, preexec_fn=prepare,
        )
    finally:
        if slave is not None:
            os.close(slave)
    if terminal:
        return child, master, {"stdout": master}, True
    return child, child.stdin.fileno(), {"stdout": child.stdout.fileno(), "stderr": child.stderr.fileno()}, False


def serve(directory):
    settings = json.loads((directory / "launch").read_bytes())
    (directory / "launch").unlink()
    child, stdin, outputs, terminal = child_process(settings)
    # Leave unread output in the guest pipe when its unacknowledged window fills.
    streams = {name: bytearray() for name in ("stdout", "stderr")}
    offsets = dict.fromkeys(streams, 0)
    pending = bytearray()
    closed = False
    eof = False
    last = time.monotonic()
    seen = {}
    os.set_blocking(stdin, False)
    for fd in outputs.values():
        os.set_blocking(fd, False)
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(str(directory / "control"))
        server.listen(4)
        while time.monotonic() - last < 90:
            with selectors.DefaultSelector() as selector:
                selector.register(server, selectors.EVENT_READ, "request")
                for name, fd in outputs.items():
                    if len(streams[name]) < WINDOW:
                        selector.register(fd, selectors.EVENT_READ, name)
                for key, _ in selector.select(0.05 if pending else 0.5):
                    if key.data != "request":
                        name = key.data
                        try:
                            data = os.read(key.fd, min(PAGE, WINDOW - len(streams[name])))
                        except OSError as error:
                            if not terminal or error.errno != 5:
                                raise
                            data = b""
                        if data:
                            streams[name].extend(data)
                        else:
                            outputs.pop(name)
                        continue
                    connection, _ = server.accept()
                    with connection, connection.makefile("rwb", buffering=0) as stream:
                        connection.settimeout(5)
                        try:
                            request = json.loads(stream.readline(MAX_REQUEST + 1))
                            op = request["op"]
                            last = time.monotonic()
                            if op == "close":
                                reply(stream, {})
                                return
                            if op == "poll":
                                result = {"pid": child.pid}
                                for name, data in streams.items():
                                    count = request[name] - offsets[name]
                                    if count < 0 or count > len(data):
                                        raise ValueError("invalid output offset")
                                    del data[:count]
                                    offsets[name] = request[name]
                                    result[name] = base64.b64encode(data[:PAGE]).decode()
                                if child.poll() is not None and not outputs and not any(streams.values()):
                                    result["exit"] = child.returncode
                            elif request["key"] in seen:
                                result = {}
                            else:
                                if op == "write":
                                    data = base64.b64decode(request["bytes"], validate=True)
                                    if eof or len(pending) + len(data) > WINDOW:
                                        raise ValueError("guest stdin is closed or full")
                                    pending.extend(data)
                                    closed = request["close"]
                                elif op == "resize" and terminal:
                                    terminal_size(stdin, request["columns"], request["rows"])
                                elif op == "signal":
                                    os.killpg(child.pid, signal.Signals[request["signal"]])
                                else:
                                    raise ValueError("unsupported job operation")
                                seen[request["key"]] = True
                                if len(seen) > 256:
                                    del seen[next(iter(seen))]
                                result = {}
                            reply(stream, result)
                        except (OSError, ValueError, KeyError) as error:
                            try:
                                reply(stream, {"error": str(error)[:256]})
                            except OSError:
                                pass
            if pending and not eof:
                try:
                    del pending[:os.write(stdin, pending)]
                except BlockingIOError:
                    pass
                except (BrokenPipeError, OSError):
                    pending.clear()
                    eof = True
            if closed and not pending and not eof:
                if terminal:
                    os.write(stdin, b"\x04")
                else:
                    child.stdin.close()
                eof = True


def main():
    directory = Path(sys.argv[2])
    if sys.argv[1] == "serve":
        try:
            serve(directory)
        finally:
            shutil.rmtree(directory, ignore_errors=True)
        return
    payload = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(payload) > MAX_REQUEST:
        raise ValueError("oversized guest job request")
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(8)
        client.connect(str(directory / "control"))
        client.sendall(payload + b"\n")
        with client.makefile("rb") as stream:
            sys.stdout.buffer.write(stream.readline(MAX_REQUEST + 1))


if __name__ == "__main__":
    main()
