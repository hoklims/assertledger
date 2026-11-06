import gzip
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = pathlib.Path(__file__).resolve().parent


class ReproductionTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="e5-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        run = self.root / "runs/profile-1"
        run.mkdir(parents=True)
        (self.root / "summary.json").write_text(json.dumps([
            {"label": "base-1", "wallMs": 100},
            {"label": "profile-1", "wallMs": 100},
        ]))
        self.spans = run / "spans.redacted.json.gz"
        self.records = [
            {"id": 1, "parent": None, "name": "verifyPreparedCampaign", "start": 10, "end": 90},
            {"id": 2, "parent": 1, "name": "probeNodeTestExecutable", "start": 10, "end": 20},
            {"id": 3, "parent": 1, "name": "executeObservation", "start": 21, "end": 81},
            {"id": 4, "parent": 3, "name": "runBoundedProcess", "start": 22, "end": 70},
            {"id": 5, "parent": 1, "name": "decideEvidence", "start": 82, "end": 86},
        ]
        self.write_spans()
        trace = json.dumps({"phase": "host-snapshot", "durationMs": 1}) + "\n"
        (run / "runtime.jsonl.gz").write_bytes(gzip.compress(trace.encode()))

    def write_spans(self):
        self.spans.write_bytes(gzip.compress(json.dumps({"records": self.records}).encode()))

    def analyze(self):
        return subprocess.run(
            [sys.executable, str(SCRIPTS / "analyze.py"), str(self.root)],
            capture_output=True, text=True, check=False,
        )

    def test_partitions_compressed_spans_without_adding_nested_process_time_twice(self):
        result = self.analyze()
        self.assertEqual(result.returncode, 0, result.stderr)
        profile = json.loads(result.stdout)["profiles"][0]
        self.assertEqual(profile["partitionMs"], {
            "outsidePrepared": 20, "identity": 10, "preflight": 0,
            "observations": 60, "decision": 4, "preparedOther": 6,
        })
        self.assertEqual(profile["observationPartitionMs"]["process"], 48)
        self.assertEqual(profile["observationPartitionMs"]["other"], 12)

    def test_corrupt_capture_produces_no_partition(self):
        self.spans.write_bytes(b"not gzip")
        result = self.analyze()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_overlapping_siblings_produce_no_partition(self):
        self.records[-1]["start"] = 80
        self.write_spans()
        result = self.analyze()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("overlapping siblings", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_nested_output_is_refused_before_any_preparation_write(self):
        output = self.root / "nested"
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / "prepare.py"), str(self.root), str(output), sys.executable],
            capture_output=True, text=True, check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("outside", result.stderr)
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
