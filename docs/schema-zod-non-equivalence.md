# JSON Schema and Zod: measured non-equivalence

The 211-case corpus for [E3, issue #118](https://github.com/hoklims/assertledger/issues/118)
disproves equal acceptance by the published JSON Schemas and Zod 4.6.7. There are **19 refinement
witnesses** accepted by JSON Schema and rejected by Zod. Another **16 witnesses** pass both schemas
but fail a public parser's semantic checks. Two digest mutations pass parsing and fail replay.
These are different validation layers, not failures to repair by weakening the current contracts.

[Accepted ADR 0002](decisions/0002-complete-rust-migration.md) keeps Zod canonical until a separately
decided transition. This corpus neither decides D3 nor qualifies a Rust validator. It measures 16
of the 56 published schema types, not every input or every semantic rule.

## Frozen inputs and observations

[The corpus](../tests/schema-zod-corpus/corpus.json.gz) contains all 211 concrete JSON inputs,
case IDs, families, schema filenames and origins. It reuses the historical manifests v1–v5,
qualification receipts, requests and plans from the [replay corpus](../tests/replay-corpus/corpus.json).
The three synthetic controls cover allocation, trust-policy shape and replay-result consistency;
the synthetic public keys do not establish cryptographic trust.

[Raw observations](../tests/schema-zod-corpus/results.json.gz) retain the original acceptances,
parser errors, validator diagnostics, replay flags and environment metadata.
[The schema inventory](../tests/schema-zod-corpus/schema-inventory.json) records the 56 schema hashes
and export/parser mapping used in that measurement; it is provenance, not a new schema lock.
These fixtures are gzip-compressed JSON, without changes to their decompressed bytes.

The source measurement used commit `66bd40468fe6cff671b686d7a5529bda457a4832`, Darwin arm64,
Node 24.22.1, Zod 4.6.7 and Ajv 8.17.1. The original investigation also observed identical per-case
results and diagnostics on Node 22.22.0 on that host. The following hashes identify the decompressed
source artifacts, not a claim about an unexecuted platform:

| Artifact | SHA-256 |
| --- | --- |
| `corpus.json` | `d3951c300a33b80e9797fcfeef5cf6e8f5b13a3d50e8194aa0ca627b49b20193` |
| `results.json` | `c8606bc7788eafb340d55183a5de196804729ed68d750dc7963aae60fdfb9ccc` |
| `schema-inventory.json` | `9ab76d5dde61688329a0a783037fa154ced34f1bab4564859dfdd3152973f395` |

## Native reproduction

After `pnpm install --frozen-lockfile`, run from the repository root:

```sh
pnpm exec tsx --test tests/schema-zod.test.ts
```

This test runs in the existing `pnpm check` CI path on Node 22/24 and Linux, Windows and macOS.
It compiles all 56 on-disk draft 2020-12 schemas with Ajv 8.17.1, then exercises the 211 inputs
against their schema, Zod export, public parser where one exists, and replay where recorded.
It asserts each layer's frozen acceptance separately. The expected result is the observed
divergence, not equality between validators. Parser refusals require the recorded error class
and business code, or the specific semantic error message for qualification plans; an unrelated
exception fails the test. Schema compilation, fixture loading and unexpected replay errors fail
the run. Input immutability is checked after each layer. No commands from fixtures are executed.

Ajv is a pinned development dependency, explicitly approved for this corpus and CI. Its options
are `strict`, `allowUnionTypes`, `allErrors`, `unicodeRegExp` and `validateFormats` enabled, with
`coerceTypes`, `useDefaults` and `removeAdditional` disabled. No custom business formats,
remote schema loading, coercion, default insertion or property stripping are configured.

To emit the inputs and full raw measurements again, choose an output directory outside the checkout:

```sh
E3_OUTPUT="$(mktemp -d)"
pnpm exec tsx tests/schema-zod-corpus/reproduce.mjs "$PWD" "$E3_OUTPUT"
```

[The reproducer](../tests/schema-zod-corpus/reproduce.mjs) reuses the investigation's deterministic
generator, with style adjustments, an explicit output-directory argument and project dependency resolution.
It verifies the historical document hashes before constructing mutations. It emits `corpus.json`,
`results.json` and `schema-inventory.json`; it does not update the compressed expectations. The
new results record the current commit/runtime, so their metadata and file hash may differ from
the source measurement. Compare per-case results separately from that metadata. Do not replace
expectations merely to make a changed acceptance pass: contract changes require their own review.

## Observed acceptance

Numbers are accepted / exercised. A dash means that layer has no associated function in this
measurement, not that acceptance was inferred.

| Family | Cases | JSON Schema | Zod | Parser | Replay valid |
| --- | ---: | ---: | ---: | ---: | ---: |
| Historical documents | 22 | 22/22 | 22/22 | 18/18 | 22/22 |
| Historical requests | 10 | 10/10 | 10/10 | 6/6 | — |
| Historical plans | 4 | 4/4 | 4/4 | 4/4 | — |
| Synthetic controls | 3 | 3/3 | 3/3 | 3/3 | — |
| Structural rejects | 120 | 0/120 | 0/120 | 0/96 | — |
| Post-parse checks | 15 | 15/15 | 15/15 | 0/15 | — |
| Unicode length | 8 | 5/8 | 5/8 | 5/8 | — |
| Numeric bounds/budget | 7 | 2/7 | 2/7 | 1/7 | — |
| Structural acceptance | 1 | 1/1 | 1/1 | 1/1 | — |
| Relative-path refinement | 11 | 11/11 | 0/11 | 0/11 | — |
| Tool-identity refinement | 2 | 2/2 | 0/2 | 0/2 | — |
| Environment refinement | 3 | 3/3 | 0/3 | 0/3 | — |
| Runtime-identity refinement | 1 | 1/1 | 0/1 | — | — |
| Nested refinements | 2 | 2/2 | 0/2 | — | — |
| Replay-only mutations | 2 | 2/2 | 2/2 | 2/2 | 0/2 |

There are 32 JSON Schema/parser differences where a parser exists: 16 refinement witnesses and
16 post-parse witnesses. Three refinement witnesses exercise exports without standalone parsers.
No inverse divergence was observed in this corpus.

## The 19 refinement witnesses

The refinements live in [qualification contracts](../src/contracts/qualification.ts). JSON Schema
exports retain the structural string constraints, not these predicates.

| Field / family | Witness values or mutation | Count |
| --- | --- | ---: |
| Plan `allowedCandidatePaths` | `../escape`, `/absolute`, `a\b`, `C:/a`, `a//b`, `./a`, `a/../b`, `a.`, `NUL.txt`, `con/a`, `a` + NUL + `b` | 11 |
| Tool `identityPath` | `identity`, `/tmp/e3` + newline + `identity` | 2 |
| Action environment key | `HOME`, `NODE_OPTIONS`, `ASSERTLEDGER_E3` | 3 |
| Receipt runtime executable | `relative` | 1 |
| Execution request candidate file | `../escape` | 1 |
| Receipt's nested plan path | `../escape` | 1 |

The environment values and paths are parsed as data only. In particular, no reserved environment
key is applied to a process and no path-traversal file is written.

## The 16 post-parse witnesses

These cases pass both JSON Schema and Zod. Their additional checks remain necessary in the
[contract parsers](../src/contracts/index.ts) and `parseQualificationPlan`.
IDs below are the suffixes of the corresponding base ID in the frozen corpus.

| Base | Case suffix | Refusal |
| --- | --- | --- |
| `evidence-v1-request` | `duplicate-world` | `DUPLICATE_WORLD_ID` |
| `evidence-v1-request` | `duplicate-candidate` | `DUPLICATE_CANDIDATE_ID` |
| `evidence-v1-request` | `target-weight-zero` | `TARGET_WEIGHT_REQUIRED` |
| `evidence-v1-request` | `missing-neutral` | `NEUTRAL_WORLD_REQUIRED` |
| `evidence-v1-request` | `execution-budget` | `EXECUTION_BUDGET_EXCEEDED` |
| `evidence-v1-request` | `utf8-byte-budget` | `WORLD_OVERLAY_BYTES_EXCEEDED` |
| `evidence-v1-request` | `short-executions` | `EXECUTION_BUDGET_EXCEEDED` |
| `qualification-2.1.0-node-test-plan` | `unknown-action` | `Unknown obligation reference` |
| `qualification-2.1.0-node-test-plan` | `case-insensitive-tool` | `Duplicate tool` |
| `allocation-request` | `case-collision` | `AGENTIC_CORPUS_ALLOCATION_REQUEST_INVALID` |
| `allocation-request` | `empty-holdout` | `AGENTIC_CORPUS_ALLOCATION_REQUEST_INVALID` |
| `trust-policy` | `duplicate-role` | `AGENTIC_CORPUS_TRUST_POLICY_INVALID` |
| `trust-policy` | `duplicate-key` | `AGENTIC_CORPUS_TRUST_POLICY_INVALID` |
| `trust-policy` | `duplicate-author` | `AGENTIC_CORPUS_TRUST_POLICY_INVALID` |
| `replay-result` | `inconsistent` | `REPLAY_RESULT_INCONSISTENT` |
| `evidence-v1` | `unknown-world-reference` | `EVIDENCE_MANIFEST_INCONSISTENT` |

The UTF-8 witness contains only one nonempty overlay: `é` occupies two bytes and exceeds a
one-byte budget. The numeric `short-executions` case permits 17 executions while 18 are required;
18 is also exercised as an accepted control. Tool and allocation collisions compare business
identities case-insensitively; uniqueness of whole JSON objects would not express those checks.

## Historical replay and limits

All 22 historical documents replay successfully through the existing pure replay functions, with
the complete frozen flag objects asserted. The `wrong-decision-digest` and `wrong-artifact-digest`
mutations on `evidence-v1` remain parseable but fail the integrity/semantic flags recorded in the
raw observations. Parsing alone does not establish digest binding. These tests replay stored
evidence; they do not rerun campaigns or authenticate producers.

The Unicode cases agree on the tested code-point boundaries, including astral and combining
characters; see the [Zod 4.6 migration note](migration-zod-4.6.md). They do not establish grapheme
semantics or another validator's behavior. Large integers here are rejected by the chosen field's
business bound; no claim is made about a future Rust numeric parser.

E3's equality hypothesis is false on this corpus. The reproducible witnesses answer the question
without a contract migration. D3's representation/admission decision and a replay against an
actually approved Rust validator remain separate work; other `partial` families in the
[SDK surface map](sdk-surface-map.md) are not covered by these 16 exercised schema types.
