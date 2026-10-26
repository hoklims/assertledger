# CLI and MCP goldens

Frozen observations of the public process boundary: argv, standard input, exit code, standard
output and standard error of the CLI, and the messages of the MCP stdio server. They are the
differential oracles required by [ADR 0002](../../docs/decisions/0002-complete-rust-migration.md):
a command moves to another implementation only when these goldens stay unchanged.

- `cases.json` declares every case as data. It never refers to source modules.
- `cli/<id>.json` records `exitCode`, `stdout` and `stderr`. Streams are compared byte for byte.
- `mcp/<id>.json` records the negotiated protocol version, the server identity and one response per
  call. Messages are compared as parsed JSON; text content inside them is compared byte for byte.

Each case runs `dist/cli.js` as a child process, in a fresh temporary copy of its fixture, with an
environment reduced to `PATH`, the home directory, the temporary directory and `SystemRoot`.

## Normalizations

Only these values are replaced before comparison, at any JSON escaping depth:

| Placeholder | Replaced value | Why it varies |
| --- | --- | --- |
| `<FIXTURE>`, `<PACKAGE>`, `<NODE>` | Absolute paths of the case working directory, the package root and the Node executable; separators become `/` | Machine and platform |
| `<VERSION>` | The package version in `assertledger <version>` and in an `assertledger` name/version pair | Release number |
| `<SOURCE_REVISION>` | The `sourceRevision` object of the provider manifest | Build checkout |
| `<PROVIDER_MANIFEST_DIGEST>` | `manifestDigest` in an output that contains `sourceRevision` | Digest of the two values above |

The provider manifest digest is therefore not frozen here. Error details are frozen as observed;
whether they stay contractual is decided separately (issue D5).

## Updating

`pnpm goldens:update` rewrites every golden from the current build. A rewritten golden is a changed
oracle: review each diff and justify it in the pull request.
