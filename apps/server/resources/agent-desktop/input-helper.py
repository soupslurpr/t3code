#!/usr/bin/env python3
"""Injects wheel events through one private Agent desktop uinput device."""

from __future__ import annotations

import fcntl
import os
import socket
import struct
import sys
import time
from collections.abc import Sequence


SOCKET_PATH = "/run/t3-agent-input/input.sock"
DEVICE_PATH = "/dev/uinput"
DEVICE_NAME = b"T3 Agent desktop wheel"
MAX_WHEEL_TICKS = 100
MAX_REQUEST_BYTES = 64
DEVICE_SETTLE_SECONDS = 1
CONNECT_ATTEMPTS = 40
CONNECT_RETRY_SECONDS = 0.05

EV_SYN = 0
EV_KEY = 1
EV_REL = 2
SYN_REPORT = 0
REL_X = 0
REL_Y = 1
REL_HWHEEL = 6
REL_WHEEL = 8
BTN_LEFT = 0x110
BUS_USB = 0x03

IOC_WRITE = 1
IOC_NR_SHIFT = 0
IOC_TYPE_SHIFT = 8
IOC_SIZE_SHIFT = 16
IOC_DIR_SHIFT = 30
UINPUT_IOCTL_BASE = ord("U")


class InputHelperError(Exception):
    """Reports one bounded Agent desktop input-helper failure."""


def ioctl_number(direction: int, number: int, size: int = 0) -> int:
    """Builds one Linux uinput ioctl request number."""
    return (
        (direction << IOC_DIR_SHIFT)
        | (UINPUT_IOCTL_BASE << IOC_TYPE_SHIFT)
        | (number << IOC_NR_SHIFT)
        | (size << IOC_SIZE_SHIFT)
    )


INT_SIZE = struct.calcsize("@i")
DEVICE_SETUP_FORMAT = "@80sHHHHI"
INPUT_EVENT_FORMAT = "@llHHi"
UI_DEV_CREATE = ioctl_number(0, 1)
UI_DEV_DESTROY = ioctl_number(0, 2)
UI_DEV_SETUP = ioctl_number(IOC_WRITE, 3, struct.calcsize(DEVICE_SETUP_FORMAT))
UI_SET_EVBIT = ioctl_number(IOC_WRITE, 100, INT_SIZE)
UI_SET_KEYBIT = ioctl_number(IOC_WRITE, 101, INT_SIZE)
UI_SET_RELBIT = ioctl_number(IOC_WRITE, 102, INT_SIZE)


def parse_ticks(value: str, field: str) -> int:
    """Parses one bounded signed wheel-tick count."""
    try:
        ticks = int(value, 10)
    except ValueError as cause:
        raise InputHelperError(f"{field} must be an integer") from cause
    if not -MAX_WHEEL_TICKS <= ticks <= MAX_WHEEL_TICKS:
        raise InputHelperError(
            f"{field} must be between {-MAX_WHEEL_TICKS} and {MAX_WHEEL_TICKS}"
        )
    return ticks


def parse_request(request: bytes) -> tuple[int, int]:
    """Decodes one exact horizontal-and-vertical wheel request."""
    if len(request) > MAX_REQUEST_BYTES:
        raise InputHelperError("wheel request is too large")
    try:
        fields = request.decode("ascii").strip().split()
    except UnicodeDecodeError as cause:
        raise InputHelperError("wheel request must be ASCII") from cause
    if len(fields) != 2:
        raise InputHelperError(
            "wheel request must contain horizontal and vertical ticks"
        )
    return parse_ticks(fields[0], "horizontal ticks"), parse_ticks(
        fields[1], "vertical ticks"
    )


def input_event(event_type: int, code: int, value: int) -> bytes:
    """Encodes one native Linux input event with an ignored timestamp."""
    return struct.pack(INPUT_EVENT_FORMAT, 0, 0, event_type, code, value)


def emit_wheel(device: int, horizontal_ticks: int, vertical_ticks: int) -> None:
    """Emits both requested hardware-like wheel axes in one input frame."""
    events = bytearray()
    if horizontal_ticks != 0:
        events.extend(input_event(EV_REL, REL_HWHEEL, horizontal_ticks))
    if vertical_ticks != 0:
        events.extend(input_event(EV_REL, REL_WHEEL, -vertical_ticks))
    if not events:
        return
    events.extend(input_event(EV_SYN, SYN_REPORT, 0))
    written = os.write(device, events)
    if written != len(events):
        raise InputHelperError("uinput accepted only part of the wheel event")


def create_device() -> int:
    """Creates one persistent virtual mouse with both wheel axes."""
    try:
        device = os.open(DEVICE_PATH, os.O_WRONLY | os.O_NONBLOCK)
    except OSError as cause:
        raise InputHelperError(
            f"cannot open {DEVICE_PATH}: {cause.strerror}"
        ) from cause
    try:
        fcntl.ioctl(device, UI_SET_EVBIT, EV_KEY)
        fcntl.ioctl(device, UI_SET_KEYBIT, BTN_LEFT)
        fcntl.ioctl(device, UI_SET_EVBIT, EV_REL)
        for code in (REL_X, REL_Y, REL_WHEEL, REL_HWHEEL):
            fcntl.ioctl(device, UI_SET_RELBIT, code)
        setup = struct.pack(
            DEVICE_SETUP_FORMAT,
            DEVICE_NAME,
            BUS_USB,
            0x5443,
            0x0001,
            1,
            0,
        )
        fcntl.ioctl(device, UI_DEV_SETUP, setup)
        fcntl.ioctl(device, UI_DEV_CREATE)
    except OSError as cause:
        os.close(device)
        raise InputHelperError(
            f"cannot create the uinput device: {cause.strerror}"
        ) from cause
    return device


def receive_request(connection: socket.socket) -> bytes:
    """Reads one bounded request through its newline terminator."""
    request = bytearray()
    while len(request) <= MAX_REQUEST_BYTES:
        chunk = connection.recv(MAX_REQUEST_BYTES + 1 - len(request))
        if not chunk:
            break
        request.extend(chunk)
        if b"\n" in chunk:
            break
    if b"\n" not in request:
        raise InputHelperError("wheel request is missing its terminator")
    line, remainder = bytes(request).split(b"\n", 1)
    if remainder:
        raise InputHelperError("wheel request contains trailing data")
    return line


def serve() -> None:
    """Serves serialized root-only wheel requests until the service stops."""
    device = create_device()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        try:
            os.unlink(SOCKET_PATH)
        except FileNotFoundError:
            pass
        listener.bind(SOCKET_PATH)
        os.chmod(SOCKET_PATH, 0o600)
        listener.listen(4)
        time.sleep(DEVICE_SETTLE_SECONDS)
        while True:
            connection, _ = listener.accept()
            with connection:
                try:
                    horizontal_ticks, vertical_ticks = parse_request(
                        receive_request(connection)
                    )
                    emit_wheel(device, horizontal_ticks, vertical_ticks)
                    connection.sendall(b"ok\n")
                except (InputHelperError, OSError) as cause:
                    connection.sendall(f"error {cause}\n".encode("utf-8", "replace"))
    finally:
        listener.close()
        try:
            os.unlink(SOCKET_PATH)
        except FileNotFoundError:
            pass
        try:
            fcntl.ioctl(device, UI_DEV_DESTROY)
        finally:
            os.close(device)


def send_wheel(horizontal_ticks: int, vertical_ticks: int) -> None:
    """Sends one wheel request and waits for an injection acknowledgement."""
    request = f"{horizontal_ticks} {vertical_ticks}\n".encode("ascii")
    last_error: OSError | None = None
    for attempt in range(CONNECT_ATTEMPTS):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            try:
                connection.connect(SOCKET_PATH)
            except OSError as cause:
                last_error = cause
                if attempt + 1 < CONNECT_ATTEMPTS:
                    time.sleep(CONNECT_RETRY_SECONDS)
                continue
            try:
                connection.sendall(request)
                response = connection.recv(MAX_REQUEST_BYTES + 1)
            except OSError as cause:
                raise InputHelperError(
                    f"input service communication failed: {cause.strerror}"
                ) from cause
            break
    else:
        detail = "unknown error" if last_error is None else last_error.strerror
        raise InputHelperError(f"cannot reach the input service: {detail}")
    if response != b"ok\n":
        detail = response.decode("utf-8", "replace").strip()
        raise InputHelperError(detail or "input service returned no acknowledgement")


def main(arguments: Sequence[str]) -> int:
    """Runs the private service or sends one validated wheel request."""
    try:
        if list(arguments) == ["serve"]:
            serve()
            return 0
        if len(arguments) == 3 and arguments[0] == "wheel":
            horizontal_ticks = parse_ticks(arguments[1], "horizontal ticks")
            vertical_ticks = parse_ticks(arguments[2], "vertical ticks")
            send_wheel(horizontal_ticks, vertical_ticks)
            return 0
        raise InputHelperError(
            "usage: input-helper.py serve | wheel HORIZONTAL VERTICAL"
        )
    except (InputHelperError, OSError) as cause:
        print(f"input helper failed: {cause}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
