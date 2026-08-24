#!/usr/bin/python
"""Commits exact Unicode text through a transient IBus engine."""

import base64
import json
import signal
import sys
import uuid

import gi

gi.require_version("IBus", "1.0")
from gi.repository import GLib, GLibUnix, IBus


MAX_TEXT_CODE_POINTS = 10_000
MAX_INTERVAL_MS = 250
ACTIVATION_TIMEOUT_MS = 5_000
DELIVERY_SETTLE_MS = 75


class ExactTextInputError(Exception):
    """Reports a bounded exact-text input failure."""

    def __init__(self, code, detail, accepted_code_points=0):
        """Initializes one agent-facing exact-text failure."""
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.accepted_code_points = accepted_code_points


def decode_input(encoded):
    """Decodes and validates one base64 JSON exact-text request."""
    try:
        value = json.loads(base64.b64decode(encoded, validate=True).decode("utf-8"))
    except (ValueError, UnicodeError, json.JSONDecodeError) as error:
        raise ExactTextInputError("invalid-input", "the exact-text request is invalid") from error
    if not isinstance(value, dict):
        raise ExactTextInputError("invalid-input", "the exact-text request must be an object")
    text = value.get("text")
    interval_ms = value.get("intervalMs")
    if (
        not isinstance(text, str)
        or len(text) > MAX_TEXT_CODE_POINTS
        or "\n" in text
        or "\r" in text
        or "\t" in text
        or not isinstance(interval_ms, int)
        or isinstance(interval_ms, bool)
        or interval_ms < 0
        or interval_ms > MAX_INTERVAL_MS
    ):
        raise ExactTextInputError("invalid-input", "the exact-text request fields are invalid")
    return text, interval_ms


class ExactTextSession:
    """Owns one transient IBus engine and restores prior input state."""

    def __init__(self, text, interval_ms):
        """Initializes one isolated IBus delivery session."""
        self.text = text
        self.interval_ms = interval_ms
        self.code_points = [text] if interval_ms == 0 else list(text)
        self.engine_name = f"t3-exact-{uuid.uuid4().hex}"
        self.loop = GLib.MainLoop()
        self.bus = None
        self.engine = None
        self.previous_engine_name = ""
        self.next_code_point = 0
        self.accepted_code_points = 0
        self.timeout_source = 0
        self.finished = False
        self.error = None
        self.signal_sources = []

        session = self

        class ExactEngine(IBus.Engine):
            """Forwards IBus focus to the owning delivery session."""

            __gtype_name__ = f"T3ExactEngine{uuid.uuid4().hex}"

            def do_focus_in(self):
                """Starts committing text after the application focuses this engine."""
                session.focus(self)

        self.engine_type = ExactEngine

    def run(self):
        """Registers, activates, runs, and tears down the transient engine."""
        IBus.init()
        self.bus = IBus.Bus()
        if not self.bus.is_connected():
            raise ExactTextInputError("ibus-unavailable", "the IBus session is unavailable")
        try:
            previous = self.bus.get_global_engine()
            self.previous_engine_name = "" if previous is None else previous.get_name()
        except GLib.Error:
            self.previous_engine_name = ""

        factory = IBus.Factory(self.bus)
        factory.add_engine(self.engine_name, self.engine_type.__gtype__)
        component = IBus.Component(
            name=self.engine_name,
            description="T3 exact text",
            version="1",
            license="MIT",
            author="T3 Tools Inc.",
            homepage="",
            command_line="",
            textdomain="",
        )
        component.add_engine(
            IBus.EngineDesc(
                name=self.engine_name,
                longname="T3 exact text",
                description="T3 exact text",
                language="en",
                license="MIT",
                author="T3 Tools Inc.",
                icon="",
                layout="us",
                rank=0,
            )
        )
        if not self.bus.register_component(component):
            raise ExactTextInputError(
                "ibus-registration-failed", "the transient IBus engine could not be registered"
            )
        self.signal_sources = [
            GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, self.cancel),
            GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, self.cancel),
        ]
        GLib.idle_add(self.activate)
        self.timeout_source = GLib.timeout_add(ACTIVATION_TIMEOUT_MS, self.timeout)
        try:
            self.loop.run()
        finally:
            for source in self.signal_sources:
                if source != 0:
                    GLib.source_remove(source)
            self.signal_sources = []
        if self.timeout_source != 0:
            GLib.source_remove(self.timeout_source)
            self.timeout_source = 0
        if self.error is not None:
            raise self.error
        return self.accepted_code_points

    def activate(self):
        """Selects the transient engine without blocking its factory callback."""
        self.bus.set_global_engine_async(
            self.engine_name,
            ACTIVATION_TIMEOUT_MS,
            None,
            self.activation_finished,
        )
        return GLib.SOURCE_REMOVE

    def activation_finished(self, bus, result):
        """Records an asynchronous engine activation failure."""
        try:
            activated = bus.set_global_engine_async_finish(result)
        except GLib.Error as error:
            self.fail("ibus-activation-failed", str(error))
            return
        if not activated:
            self.fail(
                "ibus-activation-failed", "the transient IBus engine could not be activated"
            )

    def focus(self, engine):
        """Accepts focus exactly once and starts ordered text commits."""
        if self.engine is not None or self.finished:
            return
        if self.timeout_source != 0:
            GLib.source_remove(self.timeout_source)
            self.timeout_source = 0
        self.engine = engine
        GLib.idle_add(self.commit_next)

    def commit_next(self):
        """Commits one paced unit or schedules successful teardown."""
        if self.finished:
            return GLib.SOURCE_REMOVE
        if self.next_code_point >= len(self.code_points):
            GLib.timeout_add(DELIVERY_SETTLE_MS, self.succeed)
            return GLib.SOURCE_REMOVE
        value = self.code_points[self.next_code_point]
        self.engine.commit_text(IBus.Text.new_from_string(value))
        self.next_code_point += 1
        self.accepted_code_points += len(value)
        if self.interval_ms > 0:
            GLib.timeout_add(self.interval_ms, self.commit_next)
        else:
            GLib.idle_add(self.commit_next)
        return GLib.SOURCE_REMOVE

    def succeed(self):
        """Finishes after every requested code point was accepted by IBus."""
        self.restore()
        return GLib.SOURCE_REMOVE

    def timeout(self):
        """Fails boundedly when no focused IBus-capable control appears."""
        self.timeout_source = 0
        self.fail("ibus-focus-timeout", "no focused IBus-capable text control became available")
        return GLib.SOURCE_REMOVE

    def cancel(self):
        """Stops delivery and restores input state after process cancellation."""
        self.fail("ibus-cancelled", "the exact-text request was cancelled")
        return GLib.SOURCE_REMOVE

    def fail(self, code, detail):
        """Records a bounded failure and begins compare-and-restore teardown."""
        if self.finished:
            return
        self.error = ExactTextInputError(code, detail, self.accepted_code_points)
        self.restore()

    def restore(self):
        """Restores the prior engine only while this session still owns selection."""
        if self.finished:
            return
        try:
            current = self.bus.get_global_engine()
            owns_selection = current is not None and current.get_name() == self.engine_name
        except GLib.Error:
            owns_selection = False
        if owns_selection and self.previous_engine_name:
            self.bus.set_global_engine_async(
                self.previous_engine_name,
                ACTIVATION_TIMEOUT_MS,
                None,
                self.restore_finished,
            )
            return
        self.quit()

    def restore_finished(self, bus, result):
        """Completes teardown after restoring the prior engine."""
        try:
            if not bus.set_global_engine_async_finish(result) and self.error is None:
                self.error = ExactTextInputError(
                    "ibus-restore-failed",
                    "the prior IBus engine could not be restored",
                    self.accepted_code_points,
                )
        except GLib.Error as error:
            if self.error is None:
                self.error = ExactTextInputError(
                    "ibus-restore-failed", str(error), self.accepted_code_points
                )
        self.quit()

    def quit(self):
        """Stops the event loop exactly once."""
        if self.finished:
            return
        self.finished = True
        self.loop.quit()


def response_for(encoded):
    """Runs one request and returns its bounded protocol response."""
    text, interval_ms = decode_input(encoded)
    accepted_code_points = ExactTextSession(text, interval_ms).run()
    return {"ok": True, "acceptedCodePoints": accepted_code_points}


def main(arguments):
    """Emits exactly one JSON protocol response."""
    try:
        if len(arguments) != 1:
            raise ExactTextInputError("invalid-input", "one exact-text request is required")
        response = response_for(arguments[0])
    except ExactTextInputError as error:
        response = {
            "ok": False,
            "code": error.code,
            "detail": error.detail[:2_000],
            "acceptedCodePoints": error.accepted_code_points,
        }
    except Exception as error:  # noqa: BLE001
        response = {
            "ok": False,
            "code": "ibus-internal-error",
            "detail": str(error)[:2_000],
            "acceptedCodePoints": 0,
        }
    print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
