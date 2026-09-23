# Timeouts and infrastructure errors no longer fail discovery

A candidate run that ends in `TIMEOUT` or `INFRA_ERROR` never reached a verdict. It can neither
prove nor disprove that the candidate test was discovered and attributed. The core now classifies
such a candidate as `INCONCLUSIVE` instead of `INVALID`. This resolves an ambiguity of the
[proof model](proof-model.md), which listed the case both under `INVALID` (discovery failed) and
under `INCONCLUSIVE` (`TIMEOUT` or `INFRA_ERROR`); the core applied the first.

## What changed

The engine reports every `TIMEOUT` and `INFRA_ERROR` observation with `attributed: false` and,
normally, `candidateTestsDiscovered: 0`. The `DISCOVERY` gate requires every candidate run to report
an attributed candidate test, so those runs made it fail, and the candidate became `INVALID` before
the core looked at execution outcomes. A candidate that hangs on the faulty code was reported as a
broken test, and the campaign as `REJECTED`.

Once completeness and stability hold, `DISCOVERY` now distinguishes the runs that fail it:

| Runs that fail discovery | Before | After |
| --- | --- | --- |
| None | `DISCOVERY` passed | unchanged |
| At least one completed run (`PASS`, `ASSERTION_FAILURE`, compile, collection, crash or no-test outcome) | `INVALID`, `CANDIDATE_DISCOVERY_INVALID` | unchanged |
| Only `TIMEOUT` or `INFRA_ERROR` runs | `INVALID`, `CANDIDATE_DISCOVERY_INVALID` | `INCONCLUSIVE`, `CANDIDATE_EXECUTION_INCONCLUSIVE` |

In the last case the `DISCOVERY` gate is `FAILED` with reason `CANDIDATE_EXECUTION_INCONCLUSIVE`,
and `REFERENCE`, `NEUTRAL` and `TARGET_STRENGTH` stay `NOT_RUN` with `PREREQUISITE_GATE_FAILED`, as
after any failed prerequisite. The candidate kills nothing: a red reference or neutral world, or a
target its other runs killed, is not recorded as a failed gate or a kill, whereas a timeout reported
with an attributed candidate test, a core input the engine does not produce, still lets those gates
run. Once its attempts are complete and agree, a completed run that disproves discovery still makes
the candidate `INVALID`, whatever else timed out; missing attempts still make it `INCONCLUSIVE` and
attempts that disagree `UNSTABLE` first. Inconclusive execution still takes precedence over a red
reference or neutral world, as it already did for timeouts that passed discovery.

## Observable effects

For a campaign where a candidate falls in the last row:

- candidate status `INVALID` becomes `INCONCLUSIVE`, with the reason codes above, whatever the
  campaign decision, including in the candidate list of evidence exports built from the manifest
  and in the evidence status profile v1 reports for that candidate;
- when no other candidate is selected, the campaign decision `REJECTED` / `NO_ELIGIBLE_CANDIDATE`
  becomes `INCONCLUSIVE` / `CANDIDATE_EVIDENCE_INCONCLUSIVE`, and the CLI exit code of `verify` and
  `check` becomes `3` instead of `2`; in that case the evidence export reason code becomes
  `CANDIDATE_EVIDENCE_INCONCLUSIVE` instead of `CANDIDATE_EVIDENCE_INVALID`. A campaign with a
  selected candidate stays `VERIFIED`,
  invalid controls keep their precedence (`CONTROL_EVIDENCE_INVALID`), and a campaign that another
  unstable or inconclusive candidate already made `INCONCLUSIVE` keeps its decision;
- the `decisionDigest` and `artifactDigest` values of the manifest change. The digest projections
  do not.

The core does not look at where those outcomes come from. They include a candidate that hangs on a
target world and a structured-command adapter that dies without a report, writes a malformed report
or reports `INFRA_ERROR` itself (each witnessed below), as well as other engine paths such as a run
that ends without an exit code and without a valid report (for the structured-command adapter, with
any report but `PASS`), a `node:test` run without a valid report, a contradictory report, a process
that fails to start or a container execution failure. A candidate that makes its own run end in
`INFRA_ERROR`, for example by forcing a zero exit code despite failing tests, is therefore
inconclusive rather than invalid. None of them can be selected: only an `ELIGIBLE` candidate is, so
no `VERIFIED` decision changes.

## Replay of existing manifests

Replay recomputes the decision from the recorded observations, and no field distinguishes the
decision semantics before and after this change (`policyVersion` stays `1.0.0`). Therefore:

- a manifest sealed before this change, with at least one candidate in the last row above, no
  longer replays: `decisionDigestValid` and `artifactDigestValid` stay `true`,
  `decisionSemanticsValid` and `valid` become `false`. This holds per candidate, not per decision:
  a `VERIFIED` manifest with such a neighbouring candidate is affected too, and so are the evidence
  exports, profiles and benchmarks built from it;
- a manifest sealed after this change with such a candidate fails replay the same way under a
  verifier that predates it (1.1.0 and earlier).

Re-decide affected manifests from their observations with the release that includes this change,
and replay them with a verifier of that release or a later one. Manifests without a candidate in
the last row replay as before.

## Compatibility decision

`CONTRIBUTING.md` asks for a schema-version discussion before a contract-breaking change. This
change keeps `schemaVersion` and `policyVersion` unchanged:

- the previous decision contradicted the proof model's own rule that `TIMEOUT` and `INFRA_ERROR`
  are inconclusive. Campaign requests declare `policyVersion`, and the core accepts only `1.0.0`;
  versioning would make the core accept a second version that requests opt into, while every
  request that does not opt in would keep the misclassification;
- replay fails closed: an affected manifest never replays as valid under the other semantics, so no
  verdict is silently reinterpreted, and every other manifest replays unchanged.

The cost of this choice: `policyVersion` `1.0.0` no longer names a single decision function, so
archived manifests of the affected case, including `VERIFIED` ones with an affected neighbour, stop
replaying; and a candidate can turn its own `INVALID` status into `INCONCLUSIVE` by ending its run
in `INFRA_ERROR`, which can turn the campaign decision from `REJECTED` into `INCONCLUSIVE` (exit
code 3 instead of 2), never into a selection.

The alternative is a `policyVersion` bump under which `1.0.0` manifests keep replaying with the old
rule. Choosing it would replace this section and the replay section above.

## What does not change

No schema version, manifest field, gate order, digest projection, adapter protocol, diagnostic
catalogue entry or unsafe-execution permission changes, and no reason code is added or removed;
`CANDIDATE_EXECUTION_INCONCLUSIVE` can now appear on the `DISCOVERY` gate. Its explanation already
asks to fix the timeout or infrastructure failure and rerun; the campaign explanation of
`CANDIDATE_EVIDENCE_INCONCLUSIVE` still speaks of unstable or incomplete evidence, as it did for
timeouts after discovery. The conformance v1 bundle and its lock are unchanged: every candidate run
in its fixtures reports an attributed candidate test, so none reaches the new case. The self-hosted
core campaign keeps its mutation anchors and its existing-test snapshot.

## Compatibility witnesses

- `tests/core-inconclusive-discovery.test.ts` fails against the previous core for `TIMEOUT` and
  `INFRA_ERROR` runs as the engine reports them, a candidate that hangs everywhere, a hung neighbour
  of an eligible candidate, and a red reference with a timed-out target. It also pins, to the values
  the previous core produced for the same host-independent fixtures, the decision digests of the
  inputs whose verdict must not change (a completed run that disproves discovery beside a `TIMEOUT`
  or an `INFRA_ERROR`, unattributed assertion, compile, collection and crash outcomes, a completed
  crash reported without an exit code, no test discovered, diverging timeouts, a timed-out control,
  an attributed timeout), and shows that a manifest sealed before this change, rebuilt with both of
  its digests, fails replay only on decision semantics. The reverse direction was observed by
  replaying a manifest of this change with the previous core, which the repository tests cannot
  import.
- `tests/engine.test.ts` runs a real `node:test` candidate that hangs on the target world for every
  attempt, and a structured-command adapter that dies without a report, writes a malformed report
  or reports `INFRA_ERROR` on the target. All four fail against the previous core and pass now.
