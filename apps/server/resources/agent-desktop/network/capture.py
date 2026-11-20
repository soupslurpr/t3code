"""Stop a QEMU dump filter independently of the server and publish its bounded PCAP."""

import datetime
import json
import mmap
import os
import re
import select
import socket
import struct
import sys
import time
import uuid
from pathlib import Path


PCAP_FORMATS = {
    bytes.fromhex("d4c3b2a1"): ("<", 1_000_000),
    bytes.fromhex("a1b2c3d4"): (">", 1_000_000),
    bytes.fromhex("4d3cb2a1"): ("<", 1_000_000_000),
    bytes.fromhex("a1b23c4d"): (">", 1_000_000_000),
}


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")


def remaining(deadline):
    value = deadline - time.monotonic()
    if value <= 0:
        raise TimeoutError("QMP deadline expired")
    return value


def qmp(path, command, arguments, deadline=None):
    deadline = min(deadline if deadline is not None else float("inf"), time.monotonic() + 3)
    request_id = uuid.uuid4().hex
    with socket.socket(socket.AF_UNIX) as peer:
        peer.settimeout(remaining(deadline))
        peer.connect(path)
        pending = bytearray()
        phase = "greeting"
        while True:
            end = pending.find(b"\n")
            if end < 0:
                peer.settimeout(remaining(deadline))
                chunk = peer.recv(65536)
                if not chunk:
                    raise ConnectionError("QMP disconnected")
                pending.extend(chunk)
                if len(pending) > 1024 * 1024:
                    raise ValueError("QMP response exceeds the limit")
                continue
            response = json.loads(pending[:end])
            del pending[:end + 1]
            if phase == "greeting":
                if "QMP" not in response:
                    continue
                phase = "capabilities"
                request = {"execute": "qmp_capabilities", "id": phase}
            else:
                if response.get("id") != phase:
                    continue
                if "error" in response:
                    detail = str(response["error"].get("desc", ""))[:256]
                    raise RuntimeError(f"QMP rejected {command}: {detail}")
                if phase == request_id:
                    return response["return"]
                phase = request_id
                request = {"execute": command, "arguments": arguments, "id": phase}
            peer.settimeout(remaining(deadline))
            peer.sendall(json.dumps(request).encode() + b"\n")


def detach(path, name):
    deadline = time.monotonic() + 20
    for attempt in range(2):
        try:
            qmp(path, "object-del", {"id": name}, deadline)
            return
        except (OSError, ValueError, RuntimeError):
            # A long monitor operation can delay the inventory too. Observe before replaying a delete.
            while True:
                try:
                    inventory = qmp(path, "qom-list", {"path": "/objects"}, deadline)
                    break
                except OSError:
                    time.sleep(min(0.2, remaining(deadline)))
            if not any(row.get("name") == name for row in inventory):
                return
            if attempt:
                raise


def watch(output, deadline, maximum):
    last_size = 0
    last_sample = time.monotonic()
    while True:
        now = time.monotonic()
        size = os.fstat(output.fileno()).st_size
        if size >= maximum:
            return True
        if now >= deadline:
            return False
        # Normally ten stats per second. A burst near the bound shortens the next interval.
        interval = 0.1
        if size > last_size:
            estimated = (maximum - size) * (now - last_sample) / (size - last_size)
            interval = min(interval, max(0.005, estimated / 2))
        last_size, last_sample = size, now
        ready, _, _ = select.select([sys.stdin], [], [], min(interval, deadline - now))
        if ready:
            raise InterruptedError("Capture cancelled")


def trim(output, maximum):
    actual = os.fstat(output.fileno()).st_size
    limit = min(actual, maximum)
    if limit < 24:
        raise ValueError("Missing PCAP file header")
    with mmap.mmap(output.fileno(), limit, access=mmap.ACCESS_READ) as data:
        encoding = PCAP_FORMATS.get(data[:4])
        if encoding is None:
            raise ValueError("Unknown PCAP byte order or timestamp precision")
        order, precision = encoding
        major, minor, _, _, snaplen, network = struct.unpack_from(order + "HHIIII", data, 4)
        if (major, minor) != (2, 4) or not snaplen or network != 1:
            raise ValueError("Invalid QEMU Ethernet PCAP header")
        record = struct.Struct(order + "IIII")
        pos = 24
        while pos + record.size <= limit:
            _, fraction, saved, original = record.unpack_from(data, pos)
            if fraction >= precision or saved > min(original, snaplen):
                raise ValueError("Invalid PCAP record header")
            end = pos + record.size + saved
            if end > limit:
                break
            pos = end
    output.truncate(pos)
    return pos, pos < actual


def capture(qmp_path, directory, token, duration_ms, max_bytes):
    if (
        not re.fullmatch(r"[0-9a-f]{32}", token)
        or not 1000 <= duration_ms <= 300_000
        or not 1024 <= max_bytes <= 268_435_456
    ):
        raise ValueError("Invalid capture limits or identifier")
    if select.select([sys.stdin], [], [], 0)[0]:
        raise InterruptedError("Capture cancelled")
    os.umask(0o077)
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    staging = directory / f".network-{token}.part"
    target = directory / f"network-{token}.pcap"
    name = "t3-capture-" + token
    with staging.open("x+b") as output:
        detached = False
        try:
            started_at = timestamp()
            deadline = time.monotonic() + duration_ms / 1000
            try:
                qmp(qmp_path, "object-add", {
                    "id": name,
                    "qom-type": "filter-dump",
                    "netdev": "net0",
                    "file": str(staging),
                    "maxlen": min(65536, max_bytes - 40),
                }, deadline)
                hit_size = watch(output, deadline, max_bytes)
            finally:
                detach(qmp_path, name)
                detached = True
            size, trimmed = trim(output, max_bytes)
            os.fsync(output.fileno())
            os.link(staging, target)
            return {
                "sizeBytes": size,
                "startedAt": started_at,
                "completedAt": timestamp(),
                "truncated": hit_size or trimmed,
            }
        finally:
            # Keep an unconfirmed writer visible for reattach reconciliation.
            if detached:
                staging.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        print(json.dumps(capture(*sys.argv[1:4], int(sys.argv[4]), int(sys.argv[5]))))
    except (OSError, ValueError, RuntimeError) as error:
        sys.exit(str(error))
