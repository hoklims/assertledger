import gzip
import json
import pathlib
import statistics
import sys

root = pathlib.Path(sys.argv[1]).resolve()


def read_capture(path):
    if path.exists():
        return path.read_text()
    redacted = path.with_name(path.stem + ".redacted" + path.suffix + ".gz")
    compressed = redacted if redacted.exists() else pathlib.Path(str(path) + ".gz")
    return gzip.decompress(compressed.read_bytes()).decode()


def interval_union_duration(intervals):
    duration = 0
    end = None
    for start, stop in sorted(intervals):
        if end is None or start > end:
            duration += stop - start
            end = stop
        else:
            duration += max(0, stop - end)
            end = max(end, stop)
    return duration


summary = json.loads(read_capture(root / "summary.json"))
profiles = []
for row in summary:
    if not row["label"].startswith("profile"):
        continue
    run = root / "runs" / row["label"]
    records = json.loads(read_capture(run / "spans.json"))["records"]
    by_id = {record["id"]: record for record in records}

    def total(name):
        return sum(record["end"] - record["start"] for record in records if record["name"] == name)

    def belongs(record, name):
        while record["parent"] is not None:
            record = by_id[record["parent"]]
            if record["name"] == name:
                return True
        return False

    def inside(name, parent):
        return sum(
            record["end"] - record["start"]
            for record in records
            if record["name"] == name and belongs(record, parent)
        )

    for record in records:
        if record["parent"] is not None:
            parent = by_id[record["parent"]]
            assert parent["start"] <= record["start"] <= record["end"] <= parent["end"]
    for parent in records:
        children = [
            (record["start"], record["end"])
            for record in records
            if record["parent"] == parent["id"]
        ]
        duration_sum = sum(stop - start for start, stop in children)
        assert abs(duration_sum - interval_union_duration(children)) < 0.0001, "overlapping siblings"

    native = [json.loads(line) for line in read_capture(run / "runtime.jsonl").splitlines()]
    partition = {
        "outsidePrepared": row["wallMs"] - total("verifyPreparedCampaign"),
        "identity": total("probeNodeTestExecutable"),
        "preflight": total("runNodeTestRuntimePreflight"),
        "observations": total("executeObservation"),
        "decision": total("decideEvidence"),
    }
    partition["preparedOther"] = row["wallMs"] - sum(partition.values())
    observations = {
        "process": inside("runBoundedProcess", "executeObservation"),
        "copy": inside("copyRepository", "executeObservation"),
        "overlay": inside("applyFiles", "executeObservation"),
        "reportRead": inside("readNodeTestReport", "executeObservation"),
        "cleanup": inside("removeTemporaryDirectory", "executeObservation"),
    }
    observations["other"] = total("executeObservation") - sum(observations.values())
    profiles.append({
        "label": row["label"],
        "wallMs": row["wallMs"],
        "partitionMs": partition,
        "observationPartitionMs": observations,
        "allProcessMs": total("runBoundedProcess"),
        "nodeExecutableHashMs": inside("sha256File", "probeNodeTestExecutable"),
        "nativeMs": {
            name: sum(record["durationMs"] for record in native if record["phase"] == name)
            for name in ["host-snapshot", "host-workspace-copy"]
        },
        "counts": {
            name: sum(record["name"] == name for record in records)
            for name in sorted(set(record["name"] for record in records))
        },
    })

wall = {}
for variant in ["base", "profile"]:
    values = [
        row["wallMs"] for row in summary
        if row["label"].startswith(variant) and "warm" not in row["label"]
    ]
    wall[variant] = {"min": min(values), "median": statistics.median(values), "max": max(values)}
print(json.dumps({"profiles": profiles, "wallMs": wall}, indent=2))
