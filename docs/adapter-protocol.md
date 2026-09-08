# Test adapters

Adapters translate a test runner's behavior into AssertLedger's normalized observation taxonomy. They
do not decide candidate eligibility, target credit, campaign status, or selection.

## Built-in `node:test` adapter

Configure the built-in adapter in a verification request:

```json
{
  "kind": "node-test",
  "executable": "node",
  "baseTestFiles": ["tests/base.test.js"]
}
```

For each execution, AssertLedger invokes the executable with an argument array equivalent to:

```text
--test
--test-reporter=<AssertLedger reporter URL>
--test-reporter-destination=<bounded result file>
--
<baseTestFiles...>
<candidateFiles...>
```

The engine adds an AssertLedger-owned `node:test` reporter and destination to the command and uses
`shell: false`. The reporter consumes runtime events, counts dequeued tests, normalizes each event's
file path, and compares it with the resolved candidate file set. It also separates candidate from
non-candidate failures. Assertion attribution is intentionally shallow: only an immediate
`data.details.error.cause.code === "ERR_ASSERTION"` under Node's structured
`failureType === "testCodeFailure"` wrapper is accepted. Nested causes are never traversed.

The child receives the configured environment allowlist plus
`TESTFORGE_NODE_CANDIDATE_FILES`, a JSON array of resolved candidate paths used by the reporter.
Allowlist entries cannot be `NODE_OPTIONS` or begin with `TESTFORGE_` or `NODE_TEST_`, compared
case-insensitively.

The engine admits `ASSERTION_FAILURE` only when every candidate failure has that immediate Node.js
assertion cause, no non-candidate test failed, and at least one candidate test was discovered.
Assertion libraries that do not expose this code are not admitted as assertion evidence. A generic
error whose nested cause is an `AssertionError` is deliberately rejected. On supported Node 22
runtimes, structured reporter events do not preserve a faithful `SyntaxError` identity for parse,
import, or load failures. Those failures therefore remain non-attributed `PROCESS_CRASH`, as do all
other non-assertion failures. The official profile declares both `detectsCompileFailure: false` and
`detectsCollectionFailure: false`; it never infers either outcome from stderr, messages, or stacks. A
missing or malformed report, or a report larger than 64 KiB, becomes `INFRA_ERROR`.

To preserve reporter custody and a complete execution plan, `extraArguments` must be absent or an
empty array. AssertLedger inserts `--` before all base-test and candidate paths so path tokens cannot be
parsed as Node.js options.

Before execution, AssertLedger probes the requested executable, resolves the reported `process.execPath`
to a file real path, then probes that resolved file again. Both probes must report the same supported
Node.js version (22.15 or newer). The manifest records the requested executable, resolved path,
version, and executable SHA-256 digest.

Executable and runtime qualification probes cap captured stdout and stderr at the smaller of
`maximumOutputBytes` and 64 KiB. A truncated executable identity report fails closed with
`NODE_TEST_EXECUTABLE_PROBE_FAILED`; increase the explicit capture budget if a long runtime path
cannot fit. Controlled reporter files retain their separate 64 KiB limit.

Before creating a campaign workspace, AssertLedger also runs an uncached runtime preflight against
that resolved executable and the exact bundled reporter. It uses the engine's central bounded
process runner, including its process-tree termination and `shell: false` guarantees. Each probe
respects `timeoutMsPerExecution`, capped at 5 seconds, and includes one passing
non-candidate control plus one candidate test. The report must contain exactly two discovered tests,
one candidate discovery, one candidate failure, zero non-candidate failures, zero syntax claims, and
a non-zero exit. The direct Node assertion must classify as attributed `ASSERTION_FAILURE`; a generic
error carrying a nested assertion cause must remain non-attributed `PROCESS_CRASH`. A missing,
malformed, contradictory, or timed-out probe fails closed with
`NODE_TEST_PROFILE_PREFLIGHT_FAILED`; no candidate execution starts. Successful evidence records
these deterministic facts without a timestamp under
`evidenceContext.adapter.configuration.runtimePreflight`.

File-based runtime attribution is stronger than source scanning, but it is not authenticated. The
Node.js runner, reporter events, candidate code, dependencies, and host remain trusted inputs.

## Structured command adapter protocol v1

The legacy wire identifier `testforge-command` lets any framework participate without moving gate logic into the
integration.

Configure an executable and an argument array:

```json
{
  "kind": "testforge-command",
  "executable": "node",
  "arguments": ["tools/assertledger-reporter.mjs"],
  "protocolVersion": "1.0.0"
}
```

### Invocation

AssertLedger spawns the command with `shell: false` in a fresh execution workspace. The child receives
only environment variables named in `isolation.environmentAllowlist`, plus two reserved variables
injected by AssertLedger:

- `TESTFORGE_RESULT_FILE`: absolute path where the adapter must write one UTF-8 JSON result;
- `TESTFORGE_CANDIDATE_FILES`: JSON array of candidate file paths, empty for a control run.

AssertLedger does not expose the world ID or expected outcome through reserved variables. The adapter
can still inspect the workspace and infer changes. This omission discourages accidental gaming; it
does not defend against hostile code.

### Result contract

The adapter must write this strict JSON shape to `TESTFORGE_RESULT_FILE`:

```json
{
  "protocolVersion": "1.0.0",
  "outcome": "ASSERTION_FAILURE",
  "testsDiscovered": 12,
  "candidateTestsDiscovered": 1,
  "attributed": true
}
```

Rules:

- `protocolVersion` must equal `1.0.0`;
- `outcome` must be one of the documented normalized outcomes;
- both counts must be non-negative integers;
- `candidateTestsDiscovered` must not exceed `testsDiscovered`;
- a control must report `candidateTestsDiscovered: 0` and `attributed: false` to pass control gates;
- `attributed: true` is only valid when `outcome` is `PASS` or `ASSERTION_FAILURE` and
  `candidateTestsDiscovered` is at least `1`; every other `outcome`/`attributed: true` combination,
  including a zero candidate-discovery count, is rejected;
- `PASS` requires process exit code `0`;
- every non-`PASS` report requires a non-zero process exit code;
- `TIMEOUT` is engine-authoritative: an adapter process that finishes and writes `TIMEOUT` produces
  `INFRA_ERROR`; only expiry of the configured engine deadline produces a timeout observation;
- the report file must not exceed the fixed 64 KiB structured-report limit;
- a missing, malformed, oversized, attribution-contradictory, or process-contradictory report becomes
  `INFRA_ERROR`;
- only attributed `ASSERTION_FAILURE` can kill a target in policy v1.

### Protocol v1 compatibility note

This validation is a fail-closed correction within protocol `1.0.0`, not a new wire shape. Conforming
v1 adapters require no migration. Adapters that previously emitted `attributed: true` without a
discovered candidate test, attributed an operational outcome, or self-declared `TIMEOUT` must stop
doing so; those contradictory reports now become `INFRA_ERROR`.

New node:test manifests also record an official profile version, capabilities, the SHA-256 digest of
the bundled reporter, and deterministic `runtimePreflight` evidence. The shallow assertion rule and
the corrected `detectsCompileFailure: false` capability change the reporter/profile metadata, so new
campaign decision and artifact digests change because the evidence context is decision-bound. Legacy
v1 manifests without this optional metadata remain schema-valid and replayable; they are not silently
resealed.

The 64 KiB report limit is independent of `maximumOutputBytes`, which caps each execution's captured
stdout and stderr. A small log budget therefore does not truncate controlled report evidence.

The adapter is trusted to report discovery, attribution, and outcome accurately. AssertLedger binds the
configured executable and arguments, protocol version, and normalized observations into manifest
integrity data. Reproducible deployments should pin the adapter and its resolved dependencies and
record verifiable provenance outside the free-form provenance label when authenticity matters.

### H3 structured-result consistency

The separate `TESTFORGE_H3_STRUCTURED_RESULT_V1` replay path binds each canonical result to its run
receipt. `PASS` requires a zero exit code without timeout; `PROCESS_CRASH` requires a null exit code
without timeout; `TIMEOUT` requires the timeout flag; and `ASSERTION_FAILURE`, `COMPILE_FAILURE`,
`COLLECTION_FAILURE`, `INFRA_ERROR`, and `NO_TEST_DISCOVERED` require a nonzero, non-null exit code
without timeout. A mismatch is invalid structured evidence and cannot become an H3 detection or a
merely insufficient run.

## Strict phase-aware benchmark mode

`benchmark-acquire` reuses the same executable and argument array with `shell: false`, but injects
a distinct contract: `TESTFORGE_BENCHMARK_RESULT_FILE`, `TESTFORGE_CANDIDATE_FILES`,
`TESTFORGE_BENCHMARK_CACHE_DIR`, `TESTFORGE_BENCHMARK_REGIME`,
`TESTFORGE_BENCHMARK_ROLE`, and `TESTFORGE_BENCHMARK_ORDINAL`.

Successful reports use protocol `1.0.0`, outcome `PASS`, positive candidate discovery with
attribution, nullable non-negative CPU microseconds, and exactly ordered `STARTUP`,
`COMPILE_OR_COLLECTION`, and `EXECUTION` safe-integer microseconds. AssertLedger measures
`PREPARATION` around the fresh repository copy plus REFERENCE and candidate overlays.
`STARTUP` is adapter-observed initialization, not operating-system spawn latency.

Missing, malformed, contradictory, timed-out, non-PASS, or overflowing reports become
`INCOMPLETE` runs with null timings. They never count as target kills and cannot alter the source
decision. The phase adapter belongs to the trusted computing base and may ignore the supplied cache
directory.

The runnable
[`structured-phase-adapter-fixture.mjs`](../examples/agentic-benchmark/structured-phase-adapter-fixture.mjs)
demonstrates both wire modes with illustrative fixed durations. Real adapters must measure their
own boundaries. `node-test` is deliberately unsupported because Node 22 and 24 expose no faithful
public compilation/collection timing boundary.
