# Adopt orchestration qualification v1

This release candidate adds a separate capability. It does not change verification requests,
evidence manifests, outcome taxonomies or decision/artifact digest projections of versions 1–3.
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

Native Bun expectations use a new profile. Do not reinterpret an existing helper-only v3 receipt
as native-expect qualification. Matchers, callbacks, preloads, conditions, isolation and runtime
versions outside the new profile's measured forms require new witnesses.

New schema locks are additive and independently checked. Do not regenerate or reseal old artifacts
under a new subject or proof mechanism. Preserve original receipts and execute/admit new evidence
when validity conditions change.
