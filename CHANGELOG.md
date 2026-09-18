# Changelog

## 1.1.0 — 2026-09-18

AssertLedger can run a qualification campaign in fresh Linux containers instead of on the host.
Version 2 of the verification request and evidence manifest adds this `container` backend beside
v1, which is unchanged. Replay-valid evidence can also be exported to external consumers.

- Container isolation through `check --container-image NAME@sha256:DIGEST`, with an optional
  `--container-runtime` JSON argv, and through `verify` for v2 requests.
- Each probe, preflight and observation runs in a fresh container with no host mount, no network,
  a read-only root filesystem, dropped capabilities, a non-root user and resource limits.
- The backend is probed before any execution: a missing runtime, an unreachable or non-Linux daemon,
  or an absent or differently identified image stops with a cataloged diagnostic; nothing is pulled.
- Verification request and evidence manifest v2 contracts; v2 manifests bind the execution backend
  to the decision digest. `assertledger schema` prints both v2 schemas; the SDK adds `verifyV2()`,
  `checkGitRegressionV2()` and v2 parsers.
- Evidence export: CLI `provider`, `export` and `export-replay`, matching SDK methods and read-only
  MCP tools. Unrecorded data stays `UNKNOWN` or `NOT_RECORDED`, and tampered or re-digested exports
  fail replay.
- `dist/build-info.json` records the source revision of the build.
- Agentic Test Profile v1 CLI exit codes are documented; the copyable profile-manifest example now
  exits like `assertledger profile` instead of returning 2 for every non-qualified status.
- The CI checks job also runs on macOS; Linux CI runs hostile container scenarios against a real
  Docker Engine.

Compatibility: v1 schema bytes, the conformance-v1 lock, decision and artifact digest projections,
outcomes, gates and reason-code semantics are unchanged; v1 requests still produce v1 manifests
that replay as before. SDK `verify()` and `checkGitRegression()` keep their 1.0.0 inputs, results
and types. A request declaring `schemaVersion: "2.0.0"`, previously refused with
`SCHEMA_VERSION_UNSUPPORTED`, is now validated as v2 by CLI `verify`, `verifyV2()` and
`verifyCampaign()`. Container failures use new `CONTAINER_*` and `ISOLATION_MODE_CONFLICT` reason
codes with CLI exit code 4. The six new schemas are locked additively in
`conformance/schema-extensions.json`. New MCP tools also have legacy `testforge_*` names.

Scope: `trusted-local` stays explicitly `UNSANDBOXED` and still requires `--allow-unsafe-execution`.
Containers share the daemon host's kernel, and the daemon, the image and the engine remain trusted.
Only Linux daemons are supported, images must already be present, and AssertLedger does not bound
the workspace volume. MCP, evidence export, Agentic Test Profiles and benchmarks accept only v1.

## 1.0.0 — 2026-09-08

AssertLedger qualifies a committed JavaScript `node:test` regression against a declared buggy
revision, its correction and a neutral control. The same candidate bytes run in all three worlds;
only attributed assertion failures can count as detection. Evidence can be replayed without a model.

- High-level Git qualification through CLI, SDK and operator-enabled MCP.
- Static doctor plus explicitly authorized runtime probes for Node, discovery, reporter and attribution.
- Versioned reason-code explanations with matching CLI, SDK and MCP results.
- Project-local Codex and Claude Code configuration and skills, generic MCP descriptor, safe removal.
- English and French getting-started guides and a reproducible historical bug example.
- Fresh-consumer package checks on Windows/Linux and Node 22.15/24.
- Static discovery keeps progressing when context-free scanning encounters a zero-width token.

Compatibility: legacy `testforge` CLI/MCP names and the `TestForge` SDK alias remain available.
Existing wire major versions, schema identities and manifest digest projections are preserved.
Runtime doctor and diagnostic guidance are additive contracts; neither changes existing evidence.
Client connection preview now includes both configuration and skill content. Existing differing
configuration files are refused. Unsafe managed paths return `INIT_MANAGED_PATH_UNSAFE`.

Scope: trusted-local execution is explicitly unsandboxed. The Git workflow supports committed,
dependency-free JavaScript and stable file topology. Other test frameworks, dependency transport,
hostile-code isolation and empirical performance or adoption claims retain separate qualification.
