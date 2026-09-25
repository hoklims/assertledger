# Developer entry points

AssertLedger can inspect repository readiness without running candidate code:

```text
assertledger doctor .
assertledger doctor . --json
```

The JSON form is the existing repository initialization result. `WOULD_CREATE` means the static
configuration can be planned; it does not mean worlds, candidates, campaign evidence, or an MCP
client connection are ready. `BLOCKED` exits with code 3 and `CONFLICT` with code 4.

For a single onboarding preflight, compose static initialization and the client connection:

```text
assertledger setup . --client codex --dry-run --json
assertledger setup . --client codex --write --json
assertledger setup . --client claude-code --write --json
```

`setup` previews when neither `--dry-run` nor `--write` is supplied. It checks every managed init
and connection target before writing any of them. A blocked initialization or any conflict leaves
the full managed set unchanged during preflight. If a connection conflict appears after init,
rollback removes only files created by this invocation whose bytes still match the plan. A changed
or regenerated file is preserved and yields `PARTIAL_FAILURE`, with the unresolved paths in JSON.
Exit codes are 3 for blocked readiness, 4 for a fully rolled-back conflict, 5 for partial failure or
unexpected I/O, and 64 for invalid CLI usage.

`setup --write` has no cross-process filesystem lock and requires a stable trusted repository tree.
A concurrent edit can be overwritten while an existing lock file is regenerated, or removed if it
replaces a managed file after the rollback byte check but before unlink. Stop concurrent writers
before setup; this stability requirement is a reported limitation, not a concurrency guarantee.

To confirm the installed engine can run its packaged example, execute:

```text
assertledger demo --allow-unsafe-execution --json
```

The authorization applies only to a copy of the shipped fixture in a disposable temporary
directory. The result is explicitly scoped to `SHIPPED_FIXTURE_ONLY`; it is not evidence about the
user repository and does not change that repository. Its `status` preserves the exact decision:
`VERIFIED`, `REJECTED`, `INCONCLUSIVE`, or `ENGINE_ERROR`. Exit codes match `verify`: 0, 2, 3, or 5.

After installing and building AssertLedger, generate a project-local Codex MCP descriptor:

```text
assertledger connect . --client codex
assertledger connect . --client codex --write
```

The first command previews `.codex/config.toml` and the packaged project skill. `--write` creates
absent files, accepts byte-identical content as unchanged, and refuses to overwrite different
operator-owned content. It never changes global configuration, authentication, hooks, or trust.
Codex project trust and client restart or reload remain explicit user actions.

Use `--write` in a trusted local repository whose directory tree stays stable during the operation.
Existing symlinks and junctions at the configuration path are refused. This check does not provide
filesystem isolation against another process swapping directories concurrently; the default
print-only command creates no files.

The [client guide](client-connections.md) also covers Claude Code, a generic MCP descriptor and
`disconnect`. Removal affects only byte-identical managed files; modified files cause a conflict.

The generated server command uses the current Node executable, the installed compiled CLI entry,
and `mcp --root` with the repository's real path. The server is read-only by default. Candidate
execution remains unavailable unless an operator separately starts it with
`--allow-unsafe-execution`; that mode is explicitly UNSANDBOXED trusted-local.

On a connected read-only server, agents may call `assertledger_doctor` (or the legacy
`testforge_doctor` alias) with `{ "root": "..." }`, plus optional `"exclude"` entry names that follow
the `--exclude` rules; an empty array replaces the configured list (see
[repository initialization](repository-init.md)). It returns the
same static repository initialization result as `assertledger doctor . --json`, after enforcing the
server's allowed-root boundary. The tool writes no configuration and does not execute repository
code. It reports configuration readiness only; dynamic dependency, reporter, permission and liveness
diagnostics remain outside this static check.

Use the separate [runtime doctor](runtime-doctor.md) after initialization to run controlled probes
with explicit authorization. [Reason-code explanations](diagnostics.md) remain available without
execution permission through the CLI, SDK and MCP.

`init` and every static doctor entry point require `assertledger.config.json` and
`assertledger.lock.json` to be regular files when they already exist. A symlink, dangling symlink,
directory or other file type returns `CONFLICT` with `INIT_MANAGED_PATH_UNSAFE` before its content is
read. Repositories that previously linked either managed file must replace the link with an
operator-owned regular file. This check assumes the trusted repository tree remains stable during
the operation; it is not a defense against a hostile concurrent path swap.
