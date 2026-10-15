"""Focused tests of retained byte ranges and guest receipt failure handling."""
import base64
import importlib.util
from pathlib import Path
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
