"""Focused tests of retained byte ranges and guest receipt failure handling."""
import base64
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("command_helper", Path(__file__).parents[3] / "resources/agent-desktop/command-helper.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class CommandHelperTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.job = Path(self.temporary.name)
        self.record = {
            "version": 2, "input": {"maxStoredOutputBytes": 1024},
            "process": {"status": "exited"},
            "streams": {"stdout": {"total": 0, "prefix": 0, "tail": 0}},
        }

    def invoke(self, request):
        output_bytes = io.BytesIO()
        output = io.TextIOWrapper(output_bytes)
        wire = json.dumps(request, separators=(",", ":"), ensure_ascii=False).encode()
        with patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(wire))), patch.object(sys, "stdout", output), patch.object(sys, "argv", ["command-helper.py"]), patch.object(helper, "generation", return_value="generation"), patch.object(helper, "directory", return_value=self.job):
            helper.main()
        output.flush()
        raw = output_bytes.getvalue()
        self.assertLessEqual(len(raw), 4 * 1024 * 1024)
        return json.loads(raw)

    def test_maximum_output_pages_fit_wire_budget_and_recover_every_byte(self):
        for name, data, encoding in [
            ("control", bytes(1024 * 1024), "utf8"),
            ("ascii", b"x" * (1024 * 1024), "utf8"),
            ("unicode", "🦀".encode() * (256 * 1024), "utf8"),
            ("mixed", "a🦀\0".encode() * 170000, "utf8"),
            ("binary", bytes(range(256)) * 4096, "base64"),
        ]:
            with self.subTest(name=name):
                for path in self.job.iterdir():
                    path.unlink()
                self.record = {
                    "version": 2, "input": {"maxStoredOutputBytes": 64 * 1024 * 1024},
                    "process": {"status": "exited", "runtimeGeneration": "generation", "arguments": ["m" * (512 * 1024)]},
                    "streams": {stream: {"total": 0, "prefix": 0, "tail": 0} for stream in ("stdout", "stderr")},
                }
                for stream in ("stdout", "stderr"):
                    helper.append_output(self.job, self.record, stream, data)
                helper.atomic(self.job / "receipt.json", self.record)
                offsets = {"stdout": 0, "stderr": 0}
                restored = {"stdout": bytearray(), "stderr": bytearray()}
                for _ in range(32):
                    reply = self.invoke({"action": "read", "processId": "test", "generation": "generation", "maxBytes": 1024 * 1024, "encoding": encoding, **{stream + "Offset": offset for stream, offset in offsets.items()}})
                    self.assertNotIn("error", reply)
                    self.assertEqual(reply["process"], self.record["process"])
                    for stream in offsets:
                        page = reply[stream]
                        chunk = base64.b64decode(page["data"]) if encoding == "base64" else page["data"].encode()
                        self.assertEqual(page["encoding"], encoding)
                        self.assertEqual(page["offset"], offsets[stream])
                        self.assertEqual(page["nextOffset"], offsets[stream] + len(chunk))
                        self.assertEqual(page["retainedEnd"], len(data))
                        self.assertFalse(page["invalidUtf8"])
                        restored[stream].extend(chunk)
                        offsets[stream] = page["nextOffset"]
                    if all(offset == len(data) for offset in offsets.values()):
                        break
                    self.assertTrue(any(reply[stream]["data"] for stream in offsets))
                self.assertEqual(restored["stdout"], data)
                self.assertEqual(restored["stderr"], data)

    def test_reply_metadata_too_large_returns_a_bounded_explicit_error(self):
        self.record["process"].update(runtimeGeneration="generation", arguments=["x" * (4 * 1024 * 1024)])
        helper.atomic(self.job / "receipt.json", self.record)
        reply = self.invoke({"action": "status", "processId": "test", "generation": "generation"})
        self.assertEqual(reply, {"version": 2, "error": "reply-too-large"})

    def test_large_invalid_utf8_stays_marked_and_base64_preserves_the_bytes(self):
        self.record["input"]["maxStoredOutputBytes"] = 64 * 1024 * 1024
        self.record["process"]["runtimeGeneration"] = "generation"
        self.record["streams"]["stderr"] = {"total": 0, "prefix": 0, "tail": 0}
        data = b"\xff" * (1024 * 1024)
        for stream in ("stdout", "stderr"):
            helper.append_output(self.job, self.record, stream, data)
        helper.atomic(self.job / "receipt.json", self.record)
        request = {"action": "read", "processId": "test", "generation": "generation", "maxBytes": len(data)}
        text = self.invoke(request)
        binary = self.invoke({**request, "encoding": "base64"})
        for stream in ("stdout", "stderr"):
            self.assertTrue(text[stream]["invalidUtf8"])
            self.assertEqual(text[stream]["data"], "\ufffd" * text[stream]["nextOffset"])
            self.assertGreater(text[stream]["nextOffset"], 0)
            self.assertEqual(base64.b64decode(binary[stream]["data"]), data)

    def test_unicode_and_lone_surrogates_keep_their_json_identity(self):
        value = {"text": "🦀\ud800"}
        self.assertEqual(json.loads(helper.encode_json(value)), value)

    def test_control_uses_the_same_bounded_byte_encoding(self):
        data = bytes(1024 * 1024)
        with patch.object(helper.socket, "socket") as socket:
            client = socket.return_value.__enter__.return_value
            client.recv.return_value = b'{"ok":true}\n'
            helper.control(self.job, {"action": "write", "data": base64.b64encode(data).decode(), "encoding": "base64"})
            wire = client.sendall.call_args.args[0]
            self.assertLessEqual(len(wire), 2 * 1024 * 1024)
            self.assertEqual(base64.b64decode(json.loads(wire)["data"]), data)
        with patch.object(helper.socket, "socket") as socket:
            with self.assertRaisesRegex(helper.CommandError, "request-too-large"):
                helper.control(self.job, {"action": "write", "data": "\0" * (1024 * 1024)})
            socket.assert_not_called()

    def test_oversized_input_is_rejected_before_native_dispatch(self):
        with patch.object(helper, "start") as start:
            reply = self.invoke({"action": "start", "input": {"stdin": "\0" * (1024 * 1024)}})
        start.assert_not_called()
        self.assertEqual(reply, {"version": 2, "error": "request-too-large"})

    def test_base64_input_reaches_the_actual_parser_without_expansion(self):
        data = bytes(1024 * 1024)
        with patch.object(helper, "start", return_value={"version": 2, "accepted": True}) as start:
            reply = self.invoke({"action": "start", "input": {"stdin": base64.b64encode(data).decode(), "stdinEncoding": "base64"}})
        self.assertTrue(reply["accepted"])
        self.assertEqual(base64.b64decode(start.call_args.args[0]["input"]["stdin"]), data)

    def test_binary_prefix_and_tail_keep_truthful_offsets(self):
        data = bytes(range(256)) * 1024
        for offset in range(0, len(data), 733):
            helper.append_output(self.job, self.record, "stdout", data[offset:offset + 733])
        prefix = helper.output_page(self.job, self.record, "stdout", {"encoding": "base64"})
        self.assertEqual(base64.b64decode(prefix["data"]), data[:768])
        tail = helper.output_page(self.job, self.record, "stdout", {"encoding": "base64", "stdoutOffset": prefix["nextOffset"]})
        self.assertEqual(tail["offset"], len(data) - 256)
        self.assertEqual(base64.b64decode(tail["data"]), data[-256:])
        self.assertEqual(tail["storedBytes"], 1024)
        self.assertTrue(tail["truncated"])

    def test_utf8_pages_never_split_a_codepoint(self):
        helper.append_output(self.job, self.record, "stdout", "a🦀b🦀c".encode())
        first = helper.output_page(self.job, self.record, "stdout", {"maxBytes": 4})
        second = helper.output_page(self.job, self.record, "stdout", {"stdoutOffset": first["nextOffset"], "maxBytes": 4})
        self.assertEqual(first["data"], "a")
        self.assertEqual(first["nextOffset"], 1)
        self.assertEqual(second["data"], "🦀")
        self.assertEqual(second["nextOffset"], 5)

    def test_cut_prefix_makes_progress_and_binary_tail_remains_exact(self):
        self.record["input"]["maxStoredOutputBytes"] = 8
        self.record["process"]["status"] = "running"
        data = "🦀🦀crabs".encode()
        helper.append_output(self.job, self.record, "stdout", data)
        first = helper.output_page(self.job, self.record, "stdout", {})
        self.assertEqual(first["nextOffset"], 6)
        self.assertTrue(first["invalidUtf8"])
        last = helper.output_page(self.job, self.record, "stdout", {"stdoutOffset": 6, "encoding": "base64"})
        self.assertEqual(last["offset"], len(data) - 2)
        self.assertEqual(base64.b64decode(last["data"]), b"bs")

    def test_missing_or_corrupt_receipts_are_not_success(self):
        with self.assertRaisesRegex(helper.CommandError, "receipt-missing"):
            helper.load(self.job)
        (self.job / "receipt.json").write_text('{"version":2')
        with self.assertRaisesRegex(helper.CommandError, "receipt-corrupt"):
            helper.load(self.job)

    def test_missing_ledger_with_jobs_is_not_a_new_runtime(self):
        (self.job / "job-existing").mkdir()
        with patch.object(helper, "ROOT", self.job):
            with self.assertRaisesRegex(helper.CommandError, "ledger-corrupt"):
                helper.generation()
        self.assertFalse((self.job / "ledger.json").exists())

    def test_stop_grace_timeout_is_not_a_command_runtime_timeout(self):
        self.record.update(spawnCommitted=True, stopRequested="SIGTERM")
        self.record["input"]["timeoutMs"] = 60000
        self.record["process"].update(status="stopping", runtimeGeneration="original", outputError=None)
        state = {"LoadState": "loaded", "ActiveState": "failed", "Result": "timeout", "ExecMainCode": "2", "ExecMainStatus": "9"}
        with patch.object(helper, "unit_state", return_value=state), patch.object(helper, "cgroup_members", return_value=set()):
            helper.reconcile(self.job, self.record, "original")
        self.assertEqual(self.record["process"]["status"], "exited")
        self.assertFalse(self.record["process"]["timedOut"])
        self.assertEqual(self.record["process"]["signal"], "SIGKILL")

    def test_unsupported_guests_report_missing_containment(self):
        with patch.object(helper.subprocess, "run") as run:
            run.return_value.stdout = b"systemd 249"
            with self.assertRaisesRegex(helper.CommandError, "managed-commands-unsupported"):
                helper.capabilities()


if __name__ == "__main__":
    unittest.main()
