# Agentic Benchmark Artifact v1

The Agentic Benchmark Artifact is a deterministic, self-contained cost-evidence document for
agentic test loops. It records cold and warm measurements separately and publishes phase-level
wall time plus optional CPU time. It is deliberately separate from the evidence manifest and the
Agentic Test Profile.

## Safety boundary

A benchmark can neither create nor remove a `VERIFIED` decision. Creation requires a replay-valid
source manifest whose decision is already `VERIFIED`, a required reference world, and selected
`ELIGIBLE` candidates. Failed or incomplete benchmark runs remain visible and never enter
quantiles.

The artifact proves deterministic aggregation and binding of declared measurements. It does not
authenticate the machine, tools, cache reset, phase reporter, or raw timings. Those remain producer
and attestation responsibilities.

## Acquisition from a fresh campaign

`assertledger benchmark-acquire request.json --allow-unsafe-execution --json` embeds a Verification
Request v1, the fixed Benchmark v1 policy and protocol, a required REFERENCE world, resource
declarations, and phase-adapter/dependency identity paths.

AssertLedger creates one immutable acquisition snapshot. A normal isolated verification campaign runs
from it. Benchmark processes start only when the fresh manifest is replay-valid and `VERIFIED`, and
only for source-selected `ELIGIBLE` candidates. Every timing run uses a fresh workspace and process.
Each COLD run receives a unique empty cache directory; each candidate receives a private, initially
empty WARM directory retained across its warmups and measurements.

The result embeds the untouched source manifest, a nullable Benchmark Artifact v1, snapshot,
executable, argument, adapter-identity and dependency digests, the cache policy, and canonical
request/result digests. Timing failures cannot rewrite the embedded decision or its source digests.

`benchmark-acquire-replay` recomputes the result digest and independently checks schema validity,
source-manifest replay, exact source/artifact binding, artifact replay, context/fingerprint binding,
and exact status precedence and reason codes. Re-digesting a modified status, context, source, or
artifact does not make the acquisition result valid.

The phase-adapter fingerprint binds the declared identity-file path together with the adapter
arguments and identity digest. Changing only `identityFilePath` and recomputing `resultDigest`
therefore fails context replay.

`SOURCE_NOT_VERIFIED` results intentionally have no Benchmark Artifact or fingerprint. Their source
manifest, status semantics, and result digest can replay independently, but adapter/dependency
identity digests have no independent anchor. `contextBindingValid` and aggregate `valid` are
therefore false. This does not change or invalidate the embedded source campaign decision; it avoids
claiming identity authentication that the null-artifact result cannot provide.

The acquisition schemas are additive. Existing hand-authored Benchmark Request/Artifact v1 flows
remain compatible. There is no automatic migration because acquisition requires unsafe-execution
authority and explicit identity paths.

## Fixed protocol

Version 1 uses:

- a monotonic clock;
- safe-integer microseconds;
- nearest-rank quantiles without interpolation;
- four ordered phases: `PREPARATION`, `STARTUP`, `COMPILE_OR_COLLECTION`, and `EXECUTION`;
- cold runs in a fresh workspace and process after resetting declared caches; and
- warm runs in a fresh workspace and process while retaining declared caches, after at least one
  recorded warmup.

"Declared caches" excludes implicit operating-system caches. AssertLedger never claims to purge or
control them.

## Fingerprint and comparison scope

The request declares an opaque portable `environmentId`, OS and CPU descriptors, optional resource
limits, tool digests, dependency graph digest, and phase-reporter digest. Hostnames, serial numbers,
absolute paths, and environment values are outside the contract.

The artifact binds a `comparisonScopeDigest` over the environment fingerprint, protocol, source
decision, and required reference world. Two artifacts are comparable only when this digest is
identical. Matching labels or apparently similar machines are not enough.

## Run plan

The policy declares exact counts for cold measurements, warmups, and warm measurements. Ordinals
are contiguous per candidate, regime, and role. A complete run must pass and its total must equal
the exact sum of all four phases. An incomplete run preserves its non-pass outcome with null timing.

For each candidate and regime, the artifact reports:

- `MEASURED`, `INSUFFICIENT_SAMPLES`, or `OBSERVED_RUN_FAILURE`;
- planned, recorded, accepted, failed, and warmup counts;
- min, p50, p95, and max for total wall time and every phase; and
- CPU availability as `UNAVAILABLE`, `PARTIAL`, or `COMPLETE`.

CPU quantiles exist only when every accepted measurement has CPU time. Missing CPU evidence is not
converted to zero.

## Interfaces

```sh
assertledger benchmark benchmark-request.json --json
assertledger benchmark-replay benchmark-artifact.json --json
```

The SDK exposes `AssertLedger.benchmark()` and `AssertLedger.replayBenchmark()`. The read-only MCP server
exposes the preferred `assertledger_benchmark` and `assertledger_benchmark_replay` tools alongside the
legacy `testforge_benchmark` and `testforge_benchmark_replay` aliases.

Exit code `0` means every regime is `MEASURED`; `2` means at least one observed run failure; `3`
means timing evidence is insufficient; `4` means invalid input or replay.

The built-in `node:test` reporter does not currently emit trustworthy phase markers. AssertLedger can
therefore consume a correctly attributed request from an external phase reporter, but it does not
yet acquire this artifact automatically from `node:test`. Unsupported acquisition must fail closed;
it must never synthesize phases from the existing process wall time.

## Replay rails

Replay independently checks schema validity, source replay, source binding, policy, protocol and
fingerprint digests, comparison scope, artifact digest, and recomputed summary semantics. A replay-
valid artifact may still contain insufficient samples or observed failures.
