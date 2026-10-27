#!/usr/bin/python
"""Guest-local command receipts and supervision. Invoked only over the private QGA channel.

systemd owns each job's cgroup, including descendants that start new sessions.
The supervisor owns pipes/PTYs; its lifetime follows the entire cgroup, not the
launcher. A root command is trusted guest work, not an adversarial sandbox.
"""

import base64
import codecs
import contextlib
import datetime
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import selectors
import signal
import socket
import struct
import subprocess
import sys
import termios
import time
import uuid

ROOT = Path("/var/lib/t3-command-v2")
TERMINAL = {"exited", "failed", "lost"}
MAX_INPUT = 1024 * 1024
MAX_READ = 1024 * 1024
DEFAULT_LIMIT = 64 * 1024 * 1024
PROTOCOL = 2


class CommandError(Exception):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def atomic(path, value):
    temporary = path.with_name(path.name + ".new")
    with open(temporary, "wb") as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(json.dumps(value, separators=(",", ":")).encode())
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def locked(directory):
    with open(directory / "lock", "a") as lock:
        os.chmod(directory / "lock", 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def generation():
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(ROOT, 0o700)
    with locked(ROOT):
        ledger = ROOT / "ledger.json"
        if not ledger.exists():
            if any(ROOT.glob("job-*")):
                raise CommandError("ledger-corrupt")
            atomic(ledger, {"version": PROTOCOL, "id": str(uuid.uuid4())})
        try:
            identity = json.loads(ledger.read_text())
            if identity["version"] != PROTOCOL or not re.fullmatch(r"[a-f0-9-]{36}", identity["id"]):
                raise ValueError()
            boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
            return boot + ":" + identity["id"]
        except (ValueError, KeyError, TypeError):
            raise CommandError("ledger-corrupt") from None


def directory(process_id):
    if not isinstance(process_id, str) or not re.fullmatch(r"[a-f0-9-]{36}", process_id):
        raise CommandError("invalid-process-id")
    return ROOT / ("job-" + process_id)


def load(job):
    try:
        record = json.loads((job / "receipt.json").read_text())
        if record["version"] != PROTOCOL or "status" not in record["process"]:
            raise ValueError()
        return record
    except FileNotFoundError:
        raise CommandError("receipt-missing") from None
    except (ValueError, KeyError, TypeError):
        raise CommandError("receipt-corrupt") from None


def save(job, record):
    record["process"]["statusRevision"] = record["process"].get("statusRevision", 0) + 1
    atomic(job / "receipt.json", record)


def systemctl(*arguments):
    return subprocess.run(["/usr/bin/systemctl", *arguments], capture_output=True, timeout=10, check=False)


def unit_state(record):
    result = systemctl("show", record["unit"], "--property=LoadState,ActiveState,Result,ControlGroup,ExecMainCode,ExecMainStatus")
    if result.returncode != 0:
        raise CommandError("supervisor-unavailable")
    return dict(line.split("=", 1) for line in result.stdout.decode().splitlines() if "=" in line)


def cgroup_members(path):
    root = Path("/sys/fs/cgroup") / path.lstrip("/")
    if not root.exists():
        return set()
    members = set()
    for file in root.rglob("cgroup.procs"):
        try:
            members.update(int(pid) for pid in file.read_text().split())
        except FileNotFoundError:
            pass
    return members


def reconcile(job, record, current_generation):
    process = record["process"]
    if process["status"] in TERMINAL:
        return
    if process["runtimeGeneration"] != current_generation:
        process.update(status="lost", completedAt=now(), stdinClosed=True, outputError="Guest generation ended.")
        save(job, record)
        return
    state = unit_state(record)
    if state.get("ActiveState") in {"active", "activating", "deactivating", "reloading"}:
        return
    # A durable terminal receipt from the supervisor is stronger evidence than
    # systemd's unit result. A missing unit alone never certifies a successful run.
    if state.get("LoadState") == "not-found" or not record.get("spawnCommitted"):
        process.update(status="unknown", outputError="The accepted start could not be reconciled.")
    elif not cgroup_members(state.get("ControlGroup") or record.get("cgroup", "/missing-t3-command")):
        timed_out = state.get("Result") == "timeout" and record["input"].get("timeoutMs") is not None and not record.get("stopRequested")
        process.update(
            status="exited" if record.get("stopRequested") or timed_out else "lost",
            completedAt=now(), stdinClosed=True, timedOut=timed_out,
            signal=(signal.Signals(int(state["ExecMainStatus"])).name if state.get("ExecMainCode") in {"2", "3"} else record.get("stopRequested") or ("SIGKILL" if timed_out else None)),
            outputError="Command output ended with the supervisor." if not record.get("stopRequested") else process["outputError"],
        )
    save(job, record)


def capabilities():
    version = subprocess.run(["/usr/bin/systemctl", "--version"], capture_output=True, check=True).stdout.decode().split()[1]
    if int(version) < 250 or not Path("/sys/fs/cgroup/cgroup.controllers").exists():
        raise CommandError("managed-commands-unsupported")
    return {"version": PROTOCOL, "generation": generation(), "systemdVersion": version, "cgroup": 2}


def start(request):
    current = capabilities()["generation"]
    if request["generation"] != current:
        raise CommandError("generation-changed")
    job = directory(request["process"]["processId"])
    with locked(ROOT):
        if job.exists():
            with locked(job):
                record = load(job)
                if record["fingerprint"] != request["fingerprint"] or record["owner"] != request["owner"]:
                    raise CommandError("identity-conflict")
                return {"version": PROTOCOL, "process": record["process"]}
        job.mkdir(mode=0o700)
        record = {
            "version": PROTOCOL, "owner": request["owner"], "fingerprint": request["fingerprint"],
            "process": request["process"], "input": request["input"],
            "unit": "t3-command-" + request["process"]["processId"] + ".service",
            "streams": {name: {"total": 0, "prefix": 0, "tail": 0} for name in ("stdout", "stderr")},
        }
        # This receipt is committed before contacting systemd. An uncertain
        # dispatch is discoverable and is never retried as a new execution.
        save(job, record)
    command = [
        "/usr/bin/systemd-run", "--quiet", "--unit=" + record["unit"],
        "--property=Type=exec", "--property=ExitType=cgroup", "--property=KillMode=control-group",
        "--property=TimeoutStopSec=2s", "--property=SendSIGKILL=yes", "--property=Restart=no",
    ]
    timeout = request["input"].get("timeoutMs")
    if timeout is not None:
        command.append("--property=RuntimeMaxSec=" + str(timeout / 1000) + "s")
    command.extend(["/usr/bin/python", str(Path(__file__).resolve()), "supervise", str(job)])
    subprocess.run(command, capture_output=True, timeout=10, check=False)
    with locked(job):
        record = load(job)
        reconcile(job, record, current)
        return {"version": PROTOCOL, "process": record["process"]}


def append_output(job, record, name, data):
    stream = record["streams"][name]
    limit = record["input"].get("maxStoredOutputBytes", DEFAULT_LIMIT)
    limit = DEFAULT_LIMIT if limit is None else limit
    tail_limit = min(64 * 1024, limit // 4)
    prefix_limit = limit - tail_limit
    prefix = data[:max(0, prefix_limit - stream["prefix"])]
    if prefix:
        with open(job / name, "ab") as output:
            output.write(prefix)
        stream["prefix"] += len(prefix)
    tail = data[len(prefix):]
    if tail and tail_limit:
        path = job / (name + ".tail")
        previous = path.read_bytes() if path.exists() else b""
        retained = (previous + tail)[-tail_limit:]
        path.write_bytes(retained)
        stream["tail"] = len(retained)
    stream["total"] += len(data)


def output_page(job, record, name, request):
    stream = record["streams"][name]
    offset = request.get(name + "Offset", 0)
    maximum = max(4, min(MAX_READ, request.get("maxBytes", 64 * 1024)))
    encoding = request.get("encoding", "utf8")
    total, prefix, tail = (stream[key] for key in ("total", "prefix", "tail"))
    if offset > total:
        raise CommandError("offset-out-of-range")
    if offset < prefix:
        path, position, end = job / name, offset, prefix
    else:
        offset = max(offset, total - tail)
        path, position, end = job / (name + ".tail"), offset - (total - tail), total
    data = b""
    if offset < end:
        with open(path, "rb") as output:
            output.seek(position)
            data = output.read(min(maximum, end - offset))
        if end == prefix and total - tail == prefix and len(data) < maximum and tail:
            data += (job / (name + ".tail")).read_bytes()[:maximum - len(data)]
            end = total
    invalid = False
    if encoding == "base64":
        rendered = base64.b64encode(data).decode()
    else:
        # Leave an incomplete final codepoint for the next page. Invalid input
        # remains explicitly marked; base64 always preserves every byte.
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        segment_complete = end == prefix and total - tail > prefix
        rendered = decoder.decode(data, final=offset + len(data) == end and (segment_complete or record["process"]["status"] in TERMINAL))
        pending = decoder.getstate()[0]
        data = data[:len(data) - len(pending)] if pending else data
        try:
            data.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            invalid = True
    return {
        "data": rendered, "encoding": encoding, "offset": offset, "nextOffset": offset + len(data),
        "totalBytes": total, "storedBytes": prefix + tail, "truncated": total > prefix + tail,
        "tailOffset": total - tail,
        "retainedEnd": total if tail else prefix,
        "invalidUtf8": invalid,
    }


def control(job, request):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(5)
        client.connect(str(job / "control.sock"))
        client.sendall(json.dumps(request).encode() + b"\n")
        response = b""
        while b"\n" not in response and len(response) < 4096:
            part = client.recv(4096)
            if not part:
                break
            response += part
        result = json.loads(response)
        if "error" in result:
            raise CommandError(result["error"])


def process_request(request):
    current = generation()
    job = directory(request["processId"])
    if not job.exists():
        raise CommandError("receipt-missing")
    with locked(job):
        record = load(job)
        if request["generation"] != record["process"]["runtimeGeneration"]:
            raise CommandError("identity-conflict")
        reconcile(job, record, current)
        action = request["action"]
        live = record["process"]["status"] not in TERMINAL
        same_generation = current == request["generation"]
        if action == "forget":
            if live:
                raise CommandError("process-still-running")
            for name in ("stdout", "stderr", "stdout.tail", "stderr.tail"):
                (job / name).unlink(missing_ok=True)
            record["forgotten"] = True
            record["input"] = {}
            record["streams"] = {name: {"total": 0, "prefix": 0, "tail": 0} for name in ("stdout", "stderr")}
            save(job, record)
        if action == "signal" and live and same_generation:
            selected = request.get("signal", "SIGTERM")
            if selected not in {"SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2", "SIGCONT", "SIGSTOP"}:
                raise CommandError("unsupported-signal")
            if selected in {"SIGTERM", "SIGKILL"}:
                record["stopRequested"] = selected
                record["process"]["status"] = "stopping"
                save(job, record)
        if action in {"write", "resize"} and (not live or not same_generation):
            raise CommandError("process-not-running")
    # Never hold the receipt lock while waiting for the supervisor or systemd.
    if action in {"write", "resize"}:
        control(job, request)
    elif action == "signal" and live and same_generation:
        result = systemctl("stop", record["unit"]) if selected == "SIGTERM" else systemctl("kill", "--kill-whom=all", "--signal=" + selected, record["unit"])
        if result.returncode != 0:
            with locked(job):
                current_record = load(job)
                current_record["process"].update(status="unknown", outputError="The signal request could not be confirmed; inspect this process before retrying.")
                save(job, current_record)
    with locked(job):
        record = load(job)
        reconcile(job, record, current)
        if record.get("forgotten") and action != "forget":
            raise CommandError("output-forgotten")
        return {
            "version": PROTOCOL, "process": record["process"],
            **({} if action == "status" else {name: output_page(job, record, name, request) for name in ("stdout", "stderr")}),
        }


def supervise(job):
    os.umask(0o077)
    with locked(job):
        record = load(job)
        if record.get("spawnCommitted"):
            return
        record["spawnCommitted"] = True
        record["cgroup"] = next(line[3:] for line in Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::"))
        save(job, record)
    request = record["input"]
    process = record["process"]
    stopped = []
    signal.signal(signal.SIGTERM, lambda *_: stopped.append("SIGTERM"))
    signal.signal(signal.SIGINT, lambda *_: stopped.append("SIGINT"))
    selector = selectors.DefaultSelector()
    master = slave = None
    child = None
    try:
        user = pwd.getpwnam(request.get("user", "root"))
        environment = dict(os.environ) if request.get("inheritEnvironment", True) else {}
        environment.update(HOME=user.pw_dir, USER=user.pw_name, LOGNAME=user.pw_name)
        for key, value in request.get("environment", {}).items():
            if value is None:
                environment.pop(key, None)
            else:
                environment[key] = value
        terminal = request.get("terminal", False)
        if terminal:
            master, slave = os.openpty()
            size = terminal if isinstance(terminal, dict) else {"columns": 80, "rows": 24}
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", size["rows"], size["columns"], 0, 0))

        def child_setup():
            os.setsid()
            if slave is not None:
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            os.initgroups(user.pw_name, user.pw_gid)
            os.setgid(user.pw_gid)
            os.setuid(user.pw_uid)

        working_directory = request.get("workingDirectory") or user.pw_dir
        if not os.path.isabs(working_directory):
            working_directory = os.path.join(user.pw_dir, working_directory)
        child = subprocess.Popen(
            [request["executable"], *request.get("arguments", [])],
            cwd=working_directory, env=environment,
            stdin=slave if terminal else subprocess.PIPE,
            stdout=slave if terminal else subprocess.PIPE, stderr=slave if terminal else subprocess.PIPE,
            preexec_fn=child_setup,
        )
        if slave is not None:
            os.close(slave)
            slave = None
        input_fd = master if terminal else child.stdin.fileno()
        output_fds = {master: "stdout"} if terminal else {child.stdout.fileno(): "stdout", child.stderr.fileno(): "stderr"}
        for descriptor, name in output_fds.items():
            os.set_blocking(descriptor, False)
            selector.register(descriptor, selectors.EVENT_READ, name)
        os.set_blocking(input_fd, False)
        pending = bytearray(base64.b64decode(request.get("stdin", "")) if request.get("stdinEncoding") == "base64" else request.get("stdin", "").encode())
        close_input = not request.get("keepStdinOpen", bool(terminal))
        closed = False
        with socket.socket(socket.AF_UNIX) as server:
            socket_path = job / "control.sock"
            socket_path.unlink(missing_ok=True)
            server.bind(str(socket_path))
            os.chmod(socket_path, 0o600)
            server.listen(4)
            server.setblocking(False)
            selector.register(server, selectors.EVENT_READ, "control")
            with locked(job):
                record = load(job)
                record["process"].update(status="running", pid=child.pid, user=user.pw_name, workingDirectory=working_directory, startedAt=now())
                save(job, record)
            while True:
                for key, _ in selector.select(0.05):
                    if key.data == "control":
                        connection, _ = server.accept()
                        with connection:
                            connection.settimeout(1)
                            try:
                                data = b""
                                while b"\n" not in data and len(data) <= 2 * MAX_INPUT:
                                    part = connection.recv(65536)
                                    if not part:
                                        raise CommandError("incomplete-input")
                                    data += part
                                message = json.loads(data)
                                if message["action"] == "resize":
                                    if not terminal:
                                        raise CommandError("not-a-terminal")
                                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", message["rows"], message["columns"], 0, 0))
                                else:
                                    if closed or close_input:
                                        raise CommandError("stdin-closed")
                                    payload = base64.b64decode(message.get("data", "")) if message.get("encoding") == "base64" else message.get("data", "").encode()
                                    if len(pending) + len(payload) > MAX_INPUT:
                                        raise CommandError("input-buffer-full")
                                    pending.extend(payload)
                                    close_input = message.get("close", False)
                                connection.sendall(b'{"ok":true}\n')
                            except (CommandError, ValueError, OSError, KeyError) as error:
                                connection.sendall(json.dumps({"error": str(error) if isinstance(error, CommandError) else "invalid-control"}).encode() + b"\n")
                    else:
                        try:
                            data = os.read(key.fd, 65536)
                        except BlockingIOError:
                            continue
                        except OSError:
                            data = b""
                        if not data:
                            selector.unregister(key.fd)
                            continue
                        with locked(job):
                            record = load(job)
                            append_output(job, record, key.data, data)
                            save(job, record)
                if pending and not closed:
                    try:
                        written = os.write(input_fd, pending)
                        del pending[:written]
                    except BlockingIOError:
                        pass
                    except (BrokenPipeError, OSError):
                        closed = True
                        pending.clear()
                if close_input and not pending and not closed:
                    if terminal:
                        try:
                            os.write(input_fd, b"\x04")
                        except OSError:
                            pass
                    else:
                        child.stdin.close()
                    closed = True
                result = child.poll()
                # Reap adopted children too. Their pipes may be closed already,
                # so pipe EOF alone cannot establish scope completion.
                if result is not None and not (cgroup_members(record["cgroup"]) - {os.getpid()}):
                    if any(key.data != "control" for key in selector.get_map().values()):
                        continue
                    with locked(job):
                        record = load(job)
                        timed_out = unit_state(record).get("Result") == "timeout" and record["input"].get("timeoutMs") is not None and not record.get("stopRequested")
                        record["process"].update(
                            status="exited", completedAt=now(), stdinClosed=True,
                            timedOut=timed_out,
                            exitCode=result if result >= 0 else None,
                            signal=signal.Signals(-result).name if result < 0 else None,
                        )
                        save(job, record)
                    break
                if closed and not record["process"]["stdinClosed"]:
                    with locked(job):
                        record = load(job)
                        record["process"]["stdinClosed"] = True
                        save(job, record)
    except BaseException as error:
        with locked(job):
            record = load(job)
            # If a launcher was accepted, systemd still owns its descendants.
            record["process"].update(
                status="unknown" if child is not None else "failed",
                completedAt=None if child is not None else now(), stdinClosed=True,
                outputError="Supervisor failed after start." if child is not None else "The executable, user, or working directory could not be started.",
            )
            save(job, record)
        if child is not None:
            raise error
    finally:
        selector.close()
        if master is not None:
            os.close(master)
        if slave is not None:
            os.close(slave)


def main():
    os.umask(0o077)
    if len(sys.argv) > 1 and sys.argv[1] == "supervise":
        supervise(Path(sys.argv[2]))
        return
    try:
        request = json.loads(sys.stdin.buffer.read(4 * MAX_INPUT + 1))
        action = request["action"]
        result = capabilities() if action == "capabilities" else start(request) if action == "start" else process_request(request)
    except CommandError as error:
        result = {"version": PROTOCOL, "error": str(error)}
    except Exception:
        result = {"version": PROTOCOL, "error": "helper-unavailable"}
    print(json.dumps(result, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
