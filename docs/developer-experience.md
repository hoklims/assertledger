# Developer entry points

AssertLedger can inspect repository readiness without running candidate code:

```text
assertledger doctor .
assertledger doctor . --json
```

The JSON form is the existing repository initialization result. `WOULD_CREATE` means the static
configuration can be planned; it does not mean worlds, candidates, campaign evidence, or an MCP
client connection are ready. `BLOCKED` exits with code 3 and `CONFLICT` with code 4.

After installing and building AssertLedger, generate a project-local Codex MCP descriptor:

```text
assertledger connect . --client codex
assertledger connect . --client codex --write
```

The first command prints the exact `.codex/config.toml` snippet. `--write` creates that file only
when it is absent, accepts byte-identical content as unchanged, and refuses to overwrite different
operator-owned content. It never changes global configuration, authentication, hooks, or trust.
Codex project trust and client restart or reload remain explicit user actions.

Use `--write` in a trusted local repository whose directory tree stays stable during the operation.
Existing symlinks and junctions at the configuration path are refused. This check does not provide
filesystem isolation against another process swapping directories concurrently; the default
print-only command creates no files.

The generated server command uses the current Node executable, the installed compiled CLI entry,
and `mcp --root` with the repository's real path. The server is read-only by default. Candidate
execution remains unavailable unless an operator separately starts it with
`--allow-unsafe-execution`; that mode is explicitly UNSANDBOXED trusted-local.
