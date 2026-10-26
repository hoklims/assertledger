# Replay corpus

Real evidence manifests v1 to v5 and qualification receipts, each produced by the published
version that introduced its contract. ADR 0002 makes them differential oracles: every later
implementation, in any language, must replay each one with the same decision, the same digests
and the same output.

`tests/replay-corpus.test.ts` checks, for every entry of `corpus.json`:

- the document bytes still hash to the recorded `sha256`;
- its `schemaVersion`, decision, `decisionDigest` and `artifactDigest` are the producer's;
- `dist/cli.js replay -` or `qualification-replay -`, given the document on stdin, exits 0 with
  empty stderr and prints exactly the recorded result.

## Entries

| Entries | Contract | Producer |
| --- | --- | --- |
| `evidence-v1` | manifest 1.0.0, `node:test` | `assertledger@1.0.0` |
| `evidence-v2` | manifest 2.0.0, `node:test` | `assertledger@1.1.0` |
| `evidence-v3` | manifest 3.0.0, `bun-test` | `assertledger@1.2.0` |
| `evidence-v4` | manifest 4.0.0, `bun-test-designated` | `assertledger@1.5.0` |
| `evidence-v5` | manifest 5.0.0, `bun-test-designated` | `assertledger@2.1.0` |
| `qualification-1.5.0-*` | receipt 1.0.0, `node-test` and `command` adapters | `assertledger@1.5.0` |
| `qualification-2.1.0-*` | receipt 1.0.0, same plans | `assertledger@2.1.0` |
| `evidence-v4-container-*` | manifest 4.0.0, container backend | the 12 runs of `benchmarks/container-runtime/2026-10-11`, read in place |

The documents in `documents/` were produced on Windows x64 with Node 22.23.2 and Bun 1.4.2, in
trusted-local mode (`verify` or `qualify` with `--allow-unsafe-execution`), from the inputs kept in
`inputs/<id>/`. Each `request.json` there is the request as run, with its root rewritten to the
relative directory beside it; the root is not sealed in any document. The v3 to v5 manifests seal
the resolved Bun executable path, a machine path, because it is part of the producer's evidence.

`replayedBy` lists the published versions, from the producer onwards, whose replay gave this exact
result when the corpus was frozen, plus `recorded` for the replay stored with a benchmark run. That
cross-version check ran once, with the packages installed from npm; CI replays only the current
build.

## Changing the corpus

Never edit, re-encode or reformat a document: Biome and TypeScript skip this directory and Git does
not normalize it. A new contract version adds entries produced by the version that introduces it.
A test failure here means the current build no longer replays a historical document as it was
decided; fix the build, not the corpus.
