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

The static inventory walks the filesystem, not the Git index, and never follows or copies a
symbolic link: a link inside it returns `CONFLICT` with `UNSUPPORTED_REPOSITORY_SYMLINK` and writes
nothing. It always skips entries named `.git`, `.testforge`, and `node_modules`, at any depth.
When a local-only entry holds a link that no campaign needs, the operator can declare its name:

```sh
assertledger doctor . --exclude .claude --exclude .omx --json
assertledger init . --exclude .claude --exclude .omx --json
```

Each `--exclude` value is one portable entry name without separators; every file or directory with
that name is skipped at any depth. Anything else returns `CONFLICT` with
`INVALID_REPOSITORY_EXCLUDE`. The declared names are written to `repository.exclude` beside the
defaults. `init` and `doctor` without `--exclude`, `analyze` and runtime doctor's configuration check
then reuse that list from a valid `assertledger.config.json`; an unreadable or invalid file leaves
only the defaults, which widens the inventory. A configured entry that contains a separator matches
nothing, as in a verification request. An explicit list, including an empty MCP `exclude` array,
replaces the configured one, so a different declaration never silently widens or narrows the
inventory: it fails closed, for example with `CONFIG_CONFLICT`, or with
`UNSUPPORTED_REPOSITORY_SYMLINK` when a narrower list exposes a link again. Links outside the declared names stay fail-closed.

The configured list governs only these static diagnostics and the evidence digests of
`assertledger.lock.json`; it produces no campaign evidence. `audit`, a campaign's repository copy and
its manifest `repositoryDigest` keep their own exclusions: the defaults, plus the verification
request's `repository.exclude` for a campaign. `audit` therefore still refuses a linked local-only
entry, and a request must declare the same names to leave it out of its copy; a committed
configuration can never remove files from campaign evidence. Declaring a name is an operator decision
recorded in a reviewable file, not a sandbox.

Files at or below the managed `candidateRoots` are deliberately excluded from framework inference,
evidence, built-in control tests, and repository-change comparison. Candidate generation therefore
cannot silently redefine initialization facts or invalidate an otherwise unchanged lock.

The built-in ready adapters are `node-test` and `bun-test`. Bun initialization writes v2 config,
lock, and result contracts; Node initialization stays v1. Bun's static plan does not qualify the
installed runtime. Run runtime doctor and use a v3 verification request before claiming campaign
evidence. Pytest, Vitest, and Jest can be detected, but initialization returns `BLOCKED` with
`OFFICIAL_ADAPTER_UNAVAILABLE` unless the operator supplies an existing structured adapter
configuration:

```sh
assertledger init . --adapter-config integrations/my-adapter.json --json
```

The adapter document is parsed through the public adapter contract and is operator-owned. Its
executable is recorded as argv but is not resolved or executed by `init`. This is not an official
adapter endorsement and does not reduce the later `trusted-local` execution boundary.
`node-test` adapters are accepted only for `node:test`; `bun-test` adapters are accepted only for
`bun:test`. Pytest, Vitest, and Jest require an operator-owned `testforge-command` adapter.

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

The public v1 and v2 initialization contracts contain no timestamps, absolute repository roots, environment
values, worlds, or candidates. The lock binds normalized detections and sorted evidence digests; it
does not authenticate the detector, repository, adapter, or later execution evidence.
