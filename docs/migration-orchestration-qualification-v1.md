# Adopt orchestration qualification v1

This release candidate adds a separate capability. It does not change verification requests,
evidence manifests, outcome taxonomies or decision/artifact digest projections of versions 1–4.
Old receipts remain receipts for their original declared test campaign. Their scope is not widened.

For a test-only consumer, existing `verify` and `replay` continue unchanged. To qualify orchestration:

1. Inventory every required suite and guarantee before execution, including omitted/unextractible suites.
2. Choose a named profile and pin tools, inputs, configuration, environment and trusted plan digest.
3. Declare reference, neutral and discriminating fault worlds with exact expected checks.
4. Run `qualify` with explicit unsandboxed authorization and retain plan, receipt and current domain.
5. Replay with externally supplied domain conditions. Check every required obligation is covered.
6. For real CI, separately import the independently observed and signed exact-domain pipeline result.

`QUALIFIED` means all required obligations of that named plan were covered under its validity
conditions. It is not repository-wide correctness, consumer-wide readiness, an approval or merge
permission. `OPEN` keeps unknown, omitted, operational or missing independent evidence visible.

Native Bun qualification uses a separate profile. Existing v4 designated-test and witness-import
paths remain available with their original test scope. Do not reinterpret a v4 test receipt or a helper-only v3 receipt
as native-expect qualification. Matchers, callbacks, preloads, conditions, isolation and runtime
versions outside the new profile's measured forms require new witnesses.

New schema locks are additive and independently checked. Do not regenerate or reseal old artifacts
under a new subject or proof mechanism. Preserve original receipts and execute/admit new evidence
when validity conditions change.

Nonzero command observations now require a fresh canonical nonce-bound completion report with
`facts.commandOutcome: EXPECTED_FAILURE` and `facts.exitCode` matching the actual process exit.
Unattested numeric failures remain operational. Zero command exits retain compatibility without
a report. Adapters must emit completion only after normal end-to-end semantic completion and
refuse child spawn/signal/null-status failures. These trusted-local reports are not authenticated.
Retain `reportNonce` with the report facts, provenance and raw canonical-envelope digest. Replay
reconstructs that envelope, rejects missing or altered reports and reused nonces, and requires
nested command completion facts to agree with collected process facts. Successful command reports
without completion fields remain compatible; if either completion field is present, both must match.
Turbo semantic nonzero completion remains unsupported. Recollect older qualification receipts
that did not retain the nonce; verification v1–v4 artifacts and projections remain unchanged.

Local CI route facts now include full step/stage/parallel ancestry, execution conditions and
manual/automatic triggers. Update externally sealed CI check expectations to that projection and
rerun the campaign; do not reseal earlier receipts. Unsupported execution fields fail collection.
The qualification wire schema major version and existing frozen verification projections remain
unchanged; this collector change invalidates the previous mechanism domain.

Native Node and Bun observations now retain `facts.assertionFailureFiles`: sorted, unique,
repository-relative POSIX paths naming the files that registered the failed assertions. An error
stack in a shared helper does not make that helper the test owner. A fault can satisfy a required
test suite only when an actual assertion owner belongs to that suite and its checked action.
Running another failing file in the same action is insufficient. Missing, contradictory or
noncanonical ownership reports invalidate replay, even when artifact digests are recomputed.
Recollect qualification receipts under the updated mechanism; do not add ownership to old reports.

The native Bun driver exits zero after normal report transport, including a reported assertion
failure. The inner Bun exit remains in the report and must agree with its test outcome. An abnormal
outer exit, missing completion or operational failure cannot establish assertion attribution.
Windows observations preserve declared case and use POSIX paths; ambiguous file aliases are refused.
These changes apply to the separate qualification capability, not frozen verification v1–v4.
