# Migrating from TestForge to AssertLedger

AssertLedger is a rename, not a protocol break. The evidence model, gates, decision semantics, and
every wire-level identifier described in [proof-model.md](proof-model.md) and
[conformance-v1.md](conformance-v1.md) are unchanged. Existing integrations continue to work without
modification during the compatibility window; there is no forced migration date.

## What changed

- The preferred public name is **AssertLedger**; the npm package is `assertledger`.
- The preferred SDK entry point is the `AssertLedger` class.
- The preferred CLI binary is `assertledger`.
- The preferred MCP server name and tool prefix is `assertledger`.

## What did not change

Nothing at the wire level. The following identifiers are frozen for replay and interoperability
compatibility and are **not** renamed by this migration:

| Identifier | Value | Where |
| --- | --- | --- |
| Schema `$id` domain | `https://testforge.dev/schemas/...` | every published JSON Schema |
| H3 payload schema domain | `https://testforge.dev/payloads/...` | `src/contracts/index.ts` |
| Structured-command adapter kind | `"testforge-command"` | verification request/manifest `adapter.kind` |
| Reserved environment prefix | `TESTFORGE_*` | `RESERVED_ENVIRONMENT_VARIABLE` allowlist rejection |
| Corpus allocation canonicalization domain | `"TESTFORGE_AGENTIC_CORPUS_CASE_V1"` | `src/contracts/index.ts` |
| Observation taxonomy domain | `"TESTFORGE_OBSERVATION_V1"` | `src/contracts/index.ts` |
| H3 structured-result protocol | `"TESTFORGE_H3_STRUCTURED_RESULT_V1"` | `src/contracts/index.ts` |
| Evidence context engine name | `"testforge"` | `evidenceContext.engine.name` in every manifest |
| Repository-digest exclusion directory | `.testforge` | repository analyzer default excludes |
| All published schema bytes and conformance bundle digests | unchanged | `schemas/`, `conformance/v1/` |

Changing any of these would be a public contract change requiring a major version and a documented
compatibility break under [AGENTS.md](../AGENTS.md). This migration deliberately does not do that.

## Compatibility surface

| Surface | Preferred | Legacy (still supported) |
| --- | --- | --- |
| npm package | `assertledger` | — (package was renamed; `testforge` was never published) |
| CLI binary | `assertledger` | `testforge` — installed alongside, identical `dist/cli.js` entrypoint |
| SDK class | `AssertLedger` | `TestForge` — a `class TestForge extends AssertLedger {}` subclass with an identical surface |
| MCP server name | `assertledger` | reported server name; no separate legacy server identity |
| MCP tool names | `assertledger_*` | `testforge_*` — every tool is registered twice with the exact same handler and tool configuration; every pair except the variable schema-document lookup also shares one output-schema object |
| MCP factory function | `createAssertLedgerServer` | `createTestForgeServer` — a direct alias (`export const createTestForgeServer = createAssertLedgerServer`), not a reimplementation |

Every alias pair calls the identical underlying function. None of the facades (`src/sdk`, `src/cli.ts`,
`src/mcp`) reimplement a gate, a schema, or a digest computation for either name.

## What operators and integrators should do

- New integrations: use the `assertledger` package/binary, the `AssertLedger` SDK class, and the
  `assertledger_*` MCP tool names.
- Existing integrations: no action is required. `testforge`, `TestForge`, and `testforge_*` continue
  to resolve to the same code.
- Do not expect a new schema version, a new adapter kind, or a new reserved environment prefix. None
  was introduced by this rename.

## What is deliberately not covered by this migration

- No npm publish, GitHub repository rename, domain change, or release under the new name — those are
  external delivery actions outside this compatibility slice.
- No change to the `conformance/v1/` bundle or `schemas/*.json` bytes.
- No removal date for the `testforge`/`TestForge`/`testforge_*` aliases has been set.
