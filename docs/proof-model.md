# Evidence and decision model

TestForge uses “proof” to mean recorded operational evidence, not mathematical verification of a
program.

## What `VERIFIED` means

For the repository digest scope, worlds, adapter configuration, policy, attempts, and execution
metadata recorded in the manifest, every selected candidate:

1. stayed within configured candidate roots and size budgets;
2. ran from the campaign snapshot in a fresh execution workspace;
3. produced complete, stable, attributed candidate observations;
4. passed every reference and neutral world;
5. produced attributed assertion failures for every required target and met the weighted threshold;
6. was selected by the published deterministic ordering.

This statement applies only to the recorded attempts and worlds. It does not generalize to
unexecuted states, future environments, or faults outside the supplied targets.

## Outcome taxonomy

| Outcome | Meaning | Can kill a target in v1? |
| --- | --- | --- |
| `PASS` | Runner completed successfully | No |
| `ASSERTION_FAILURE` | Adapter attributed an assertion failure to the candidate | Yes |
| `COLLECTION_FAILURE` | Runner could not collect tests | No |
| `COMPILE_FAILURE` | Code could not compile or load | No |
| `PROCESS_CRASH` | Runner failed without an admitted assertion | No |
| `TIMEOUT` | Execution exceeded its time budget | No |
| `INFRA_ERROR` | Runner, adapter, report, or host failed | No |
| `NO_TEST_DISCOVERED` | Adapter found no candidate test | No |

Only an attributed `ASSERTION_FAILURE` kills a target in policy v1. A caller cannot configure
timeouts, crashes, compilation failures, or collection failures as accepted target outcomes.

## Candidate gates

The core evaluates gates in this order and records a status, evidence run IDs, and reason codes for
each gate:

| Gate | Condition |
| --- | --- |
| `COMPLETENESS` | Every world has exactly the required attempts |
| `STABILITY` | Normalized outcomes agree across attempts |
| `DISCOVERY` | Every candidate run reports at least one attributed candidate test |
| `REFERENCE` | All reference observations pass |
| `NEUTRAL` | All neutral observations pass |
| `TARGET_STRENGTH` | Required targets are killed and the weighted threshold is met |

A failed prerequisite leaves later dependent gates as `NOT_RUN`. Repetition measures observed
stability; a successful retry never erases a contradictory attempt.

Candidate statuses are:

- `ELIGIBLE`: every gate needed by policy passed;
- `WEAK_ORACLE`: reference and neutral evidence passed, but target strength did not;
- `INVALID`: discovery, reference, or neutral evidence failed;
- `UNSTABLE`: complete attempts produced different normalized outcomes;
- `INCONCLUSIVE`: required observations were missing or execution produced `TIMEOUT` or
  `INFRA_ERROR`.

## Campaign statuses

- `VERIFIED`: at least one eligible candidate was selected.
- `REJECTED`: evidence was complete and conclusive, but no candidate was eligible.
- `INCONCLUSIVE`: controls were invalid, or at least one candidate was unstable or inconclusive.
- `ENGINE_ERROR`: the core could not normalize the supplied evidence safely.

## Controls and attribution

Every world runs without a candidate before candidate runs. A valid control is complete, stable,
`PASS`, reports zero candidate tests, and reports no candidate attribution. One invalid control makes
the campaign `INCONCLUSIVE`.

Attribution comes from the adapter and remains part of the trusted computing base. The built-in
`node:test` adapter consumes runner events and associates them with resolved candidate file paths;
the structured-command adapter trusts its strict runtime report. See
[adapter-protocol.md](adapter-protocol.md).

## Decision and artifact digests

The manifest carries two SHA-256 integrity values with different scopes:

- `decisionDigest` binds decision-relevant normalized evidence: schema and policy versions,
  repository digest, evidence context and world provenance, candidate assessments, gates,
  decision-relevant observations, and the final selection. It excludes observation duration, process
  exit code, and stdout/stderr digests.
- `artifactDigest` binds the complete emitted manifest except `artifactDigest` itself. It therefore
  detects changes to operational observation fields and disclosure metadata that do not alter the
  decision digest.

`TestForge.replay()` validates the manifest contract, recomputes both digests, and recomputes
candidate assessments and the final decision from the recorded normalized evidence. Its result
includes `schemaValid`, `decisionDigestValid`, `artifactDigestValid`, and
`decisionSemanticsValid`; `valid` requires all four rails. Replay does not rerun tests, prove that
observations were truthful, authenticate the producer, or replace a signed external attestation.

The manifest alone is not a self-contained reproduction bundle. It stores candidate and world
digests rather than their file bodies, stdout/stderr digests rather than raw logs, and environment
allowlist names rather than effective values. The built-in `node:test` adapter records its resolved
executable real path, version, and SHA-256 digest; the structured-command adapter records only its
configured command. Preserve the original request, repository snapshot, dependencies, missing
executable identities, and raw logs separately when independent audit matters.

## Explicit non-claims

TestForge does not prove:

- absence of bugs or complete fault detection;
- universal oracle quality;
- absence of flakiness beyond observed attempts;
- semantic relevance or correctness of operator-supplied worlds;
- resistance to a candidate designed to recognize the worlds;
- containment of hostile code under `trusted-local`;
- provenance authenticity without a separate signed attestation.
