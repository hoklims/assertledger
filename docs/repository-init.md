# Repository initialization

`assertledger init` performs a static, provider-neutral repository detection pass and manages exactly
two root files: `assertledger.config.json` and `assertledger.lock.json`. It never runs a test command,
adapter, candidate, or campaign, and it never edits package manifests, lockfiles, CI configuration,
or tests.

```sh
assertledger init . --dry-run --json
assertledger init . --json
assertledger audit . --json
```

The dry run emits the exact canonical bytes and SHA-256 digests that a subsequent write plans to
use. Writes use a same-directory temporary file followed by an atomic rename. A second run returns
`UNCHANGED` without rewriting matching files. A missing lock or a stale, structurally valid lock
bound to the same config can be recovered; invalid files and config-binding conflicts fail closed
without a `--force` mode.

Detection is conservative. Package-manager declarations and root lockfiles must converge. Multiple
plausible test frameworks, composite shell scripts, contradictory overrides, and invalid explicit
adapter configurations return `CONFLICT`. Multiple CI providers are only sorted evidence and do not
block initialization.

Files at or below the managed `candidateRoots` are deliberately excluded from framework inference,
evidence, built-in control tests, and repository-change comparison. Candidate generation therefore
cannot silently redefine initialization facts or invalidate an otherwise unchanged lock.

The built-in ready adapter is currently `node-test`. Bun, pytest, Vitest, and Jest can be detected,
but initialization returns `BLOCKED` with `OFFICIAL_ADAPTER_UNAVAILABLE` unless the operator supplies
an existing structured adapter configuration:

```sh
assertledger init . --adapter-config integrations/my-adapter.json --json
```

The adapter document is parsed through the public adapter contract and is operator-owned. Its
executable is recorded as argv but is not resolved or executed by `init`. This is not an official
adapter endorsement and does not reduce the later `trusted-local` execution boundary.
`node-test` adapters are accepted only for the `node:test` framework; every other framework requires
an operator-owned `testforge-command` adapter.

All detections and evidence digests come from one byte snapshot. Immediately before returning or
writing managed files, initialization rechecks the in-scope inventory and every evidence byte. A
change returns `CONFLICT` with `REPOSITORY_CHANGED_DURING_INIT` and writes nothing.

Initialization deliberately does not generate a verification request. Both `worlds` and
`candidates` remain required operator or harness inputs because repository detection cannot infer
valid semantic faults, neutral transformations, or oracle expectations. The next command is
`assertledger audit . --json`; that audit may report `VERIFICATION_REQUEST_UNAVAILABLE` until the
harness supplies those inputs.

Exit codes are `0` for `CREATED`, `UNCHANGED`, or `WOULD_CREATE`; `3` for `BLOCKED`; `4` for
ambiguity, invalid overrides, conflicts, or contract validation; `5` for unexpected I/O; and `64`
for CLI usage errors.

The public `repository-init-config.v1`, `repository-init-lock.v1`, and
`repository-init-result.v1` contracts contain no timestamps, absolute repository roots, environment
values, worlds, or candidates. The lock binds normalized detections and sorted evidence digests; it
does not authenticate the detector, repository, adapter, or later execution evidence.
