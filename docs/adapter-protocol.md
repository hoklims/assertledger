# Test adapters

Adapters translate a test runner's behavior into TestForge's normalized observation taxonomy. They
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

For each execution, TestForge invokes the executable with an argument array equivalent to:

```text
--test
--test-reporter=<TestForge reporter URL>
--test-reporter-destination=<bounded result file>
--
<baseTestFiles...>
<candidateFiles...>
```

The engine adds a TestForge-owned `node:test` reporter and destination to the command and uses
`shell: false`. The reporter consumes runtime events, counts dequeued tests, normalizes each event's
file path, and compares it with the resolved candidate file set. It also separates candidate from
non-candidate failures and walks error cause chains for `ERR_ASSERTION` and `SyntaxError`.

The child receives the configured environment allowlist plus
`TESTFORGE_NODE_CANDIDATE_FILES`, a JSON array of resolved candidate paths used by the reporter.
Allowlist entries cannot be `NODE_OPTIONS` or begin with `TESTFORGE_` or `NODE_TEST_`, compared
case-insensitively.

The engine admits `ASSERTION_FAILURE` only when every candidate failure contains an error-chain item
whose `code` equals Node.js `ERR_ASSERTION`, no non-candidate test failed, and at least one candidate
test was discovered. Assertion libraries that do not expose this code are not admitted as assertion
evidence. Candidate `SyntaxError` chains become `COMPILE_FAILURE`; other failures become
`PROCESS_CRASH`. A missing or malformed report, or a report larger than 64 KiB, becomes
`INFRA_ERROR`.

To preserve reporter custody and a complete execution plan, `extraArguments` must be absent or an
empty array. TestForge inserts `--` before all base-test and candidate paths so path tokens cannot be
parsed as Node.js options.

Before execution, TestForge probes the requested executable, resolves the reported `process.execPath`
to a file real path, then probes that resolved file again. Both probes must report the same supported
Node.js version (22.15 or newer). The manifest records the requested executable, resolved path,
version, and executable SHA-256 digest.

File-based runtime attribution is stronger than source scanning, but it is not authenticated. The
Node.js runner, reporter events, candidate code, dependencies, and host remain trusted inputs.

## Structured command adapter protocol v1

The `testforge-command` adapter lets any framework participate without moving gate logic into the
integration.

Configure an executable and an argument array:

```json
{
  "kind": "testforge-command",
  "executable": "node",
  "arguments": ["tools/testforge-reporter.mjs"],
  "protocolVersion": "1.0.0"
}
```

### Invocation

TestForge spawns the command with `shell: false` in a fresh execution workspace. The child receives
only environment variables named in `isolation.environmentAllowlist`, plus two reserved variables
injected by TestForge:

- `TESTFORGE_RESULT_FILE`: absolute path where the adapter must write one UTF-8 JSON result;
- `TESTFORGE_CANDIDATE_FILES`: JSON array of candidate file paths, empty for a control run.

TestForge does not expose the world ID or expected outcome through reserved variables. The adapter
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
- `PASS` requires process exit code `0`;
- every non-`PASS` report requires a non-zero process exit code;
- the report file must not exceed the fixed 64 KiB structured-report limit;
- a missing, malformed, oversized, or process-contradictory report becomes `INFRA_ERROR`;
- only attributed `ASSERTION_FAILURE` can kill a target in policy v1.

The 64 KiB report limit is independent of `maximumOutputBytes`, which caps each execution's captured
stdout and stderr. A small log budget therefore does not truncate controlled report evidence.

The adapter is trusted to report discovery, attribution, and outcome accurately. TestForge binds the
configured executable and arguments, protocol version, and normalized observations into manifest
integrity data. Reproducible deployments should pin the adapter and its resolved dependencies and
record verifiable provenance outside the free-form provenance label when authenticity matters.
