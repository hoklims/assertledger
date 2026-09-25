# Runtime doctor

AssertLedger's default doctor is static. It reads repository metadata and configuration without
starting an executable:

```text
assertledger doctor .
assertledger doctor . --json
```

Use runtime doctor only after reviewing the repository and creating its current
`assertledger.config.json` and `assertledger.lock.json` files:

```text
assertledger doctor . --runtime --allow-unsafe-execution
assertledger doctor . --runtime --allow-unsafe-execution --json
```

Runtime doctor is explicitly **UNSANDBOXED trusted-local**. The authorization flag is required to
start processes; it does not create a sandbox. Omitting it returns a stable `BLOCKED` result before
configuration inspection or executable probes. Unknown flags, repeated flags, and using
`--allow-unsafe-execution` without `--runtime` are usage errors.

## What it checks

Version 1.0 supports the generated official `node:test` adapter. Version 2.0 supports the
generated official `bun:test` adapter on the qualified Bun 1.4.2 revision. Both fail closed for
other frameworks and operator-supplied adapters. In order, they check:

1. explicit trusted-local authorization;
2. a current AssertLedger configuration and evidence lock;
3. the supported generated adapter;
4. a stable Node.js executable at version 22.15 or newer, or the exact Bun 1.4.2 revision;
5. availability of the runner's built-in test module;
6. permission to create, write, and clean up an operating-system temporary workspace;
7. controlled reporter discovery, liveness, and attribution probes.

The final probes use disposable synthetic tests. One assertion failure must be attributed to the
candidate; a generic throw with a nested assertion cause must remain a process crash and must not
be attributed. The Bun probes also check its owned `assertSame` helper against a plain throw,
a caught assertion, an operand error, and a native `expect` failure. Malformed reporter output,
missing discovery, cleanup failure, timeout, or process
failure blocks readiness. AssertLedger does not write to the repository during runtime doctor.

## Result contract

The SDK exposes the same strict additive contract:

```ts
import { AssertLedger, parseVersionedRuntimeDoctorResult } from "assertledger";

const result = await new AssertLedger().doctorRuntime(repositoryRoot, {
  allowUnsafeExecution: true,
});
parseVersionedRuntimeDoctorResult(result);
```

`schemaVersion` is `1.0.0` for Node and `2.0.0` for Bun. Each check has `PASS`, `BLOCKED`, or `LIMITATION`, a stable reason code
when relevant, a concise summary, and a safe next action. The top-level status is `READY` only when
every supported runtime boundary passes. JSON results contain no subprocess output, environment
values, credentials, or repository source.

Runtime doctor always records a limitation: it does not run the repository's tests, evaluate a
candidate, or prove campaign evidence. `READY` means the supported synthetic runtime boundary is
operational. It is not a test-health or regression-verification verdict. Run an explicitly
authorized `check` or `verify` workflow for evidence.

The CLI exits with `0` for `READY`, `3` for `BLOCKED`, and `64` for malformed arguments.
