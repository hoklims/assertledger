# AssertLedger self-hosted core campaign

This campaign challenges AssertLedger's deterministic core with four operator-owned mutations:
dependent-gate ordering, the exact target-weight boundary, contradictory-attempt stability, and
duration exclusion from the decision digest. A behavior-equivalent neutral rewrite controls for
source-shape coupling. The candidate set contains four diagnostic slices, one composite candidate,
and two intentionally unrelated zero-kill candidates.

The builder accepts an external operator plan only after verifying its exact SHA-256 digest. Create
the plan outside the candidate-generation step with this exact shape (use an absolute repository
root and preserve the target order shown here):

```json
{
  "schemaVersion": "1.0.0",
  "campaignId": "assertledger-self-hosted-core-v1",
  "repositoryRoot": "E:\\testforge",
  "targetIds": [
    "target-dependent-gate-order",
    "target-threshold-strict-greater",
    "target-stability-completeness-only",
    "target-duration-in-decision-digest"
  ],
  "requiredAttempts": 2,
  "minimumTargetWeightPermille": 1000,
  "maximumSelectedCandidates": 4
}
```

Freeze its digest, build the deterministic artifacts, then explicitly authorize the unsafe local
backend:

```text
tsx benchmarks/self-hosted-core/builder.ts operator-plan.json sha256:<digest> evidence
assertledger verify evidence/request.json --allow-unsafe-execution --json > evidence/manifest.json
assertledger replay evidence/manifest.json --json
```

The request has six worlds, seven candidates, two attempts, and an exact maximum of 96 executions.
The structured adapter runs either the separate liveness control or only the candidate files using
`process.execPath`, `--import tsx`, and `--test`, with `shell: false`. The builder binds the
canonical host `node_modules` path into `request.json`; the adapter mounts it as a directory symlink
(a junction on Windows) when the disposable workspace has no dependency directory. This keeps
dependencies out of repository copies while making the host dependency explicit and auditable. The
adapter admits target evidence only when the existing built AssertLedger reporter attributes every
candidate failure to `ERR_ASSERTION`.

Limitations: `trusted-local` is explicitly **UNSANDBOXED** and must not receive hostile code. The
adapter, its host dependency junction, and its built reporter are part of the trusted computing base
and are not independently authenticated. The request is therefore host-bound. Replay checks the
manifest's integrity and deterministic semantics; it does not make the campaign a standalone
reproduction bundle, validate the semantic adequacy of the operator's mutations, or establish
non-flakiness beyond the two declared attempts.

## Existing-test inventory campaign

`existing-tests-builder.ts` is a separate, additive campaign that measures every current literal
`it(...)` case in `tests/core.test.ts` independently against the same reference, neutral rewrite,
and four 250-permille target mutations. The original seven-candidate campaign above remains fixed
at 96 executions.

The current source snapshot contains **36** literal cases. An earlier planning note mentioned 33;
the builder intentionally follows and freezes the real checkout rather than silently dropping three
tests. TypeScript's installed AST API extracts the catalogue. Non-literal titles, duplicate titles,
ID collisions, syntax errors, and any drift from the frozen count fail the build.

`RESULT-existing-tests-v1.md` is explicitly excluded from the repository snapshot because it is an
output of this campaign. This prevents the measured report from changing the repository digest it
reports; the executable builder, adapter, source, tests, and all other documentation remain bound.

Each candidate contains two digest-bound files: a faithful copy of `tests/core.test.ts` whose only
change is the relative import needed at the candidate depth, and `selection.json`, which binds the
stable candidate ID, literal title, exact escaped `--test-name-pattern`, source path, and source
SHA-256. The adapter accepts evidence only when exactly one selected candidate test executes. Zero
matches, multiple matches, a reported test name different from the bound title, malformed metadata,
source-digest mismatch, syntax errors, generic crashes, and infrastructure failures cannot become
attributed `ASSERTION_FAILURE` outcomes.

Freeze a distinct operator plan before building:

```json
{
  "schemaVersion": "1.0.0",
  "campaignId": "assertledger-self-hosted-core-existing-tests-v1",
  "repositoryRoot": "E:\\testforge",
  "sourceTestCount": 36,
  "targetIds": [
    "target-dependent-gate-order",
    "target-threshold-strict-greater",
    "target-stability-completeness-only",
    "target-duration-in-decision-digest"
  ],
  "requiredAttempts": 2,
  "minimumTargetWeightPermille": 250,
  "maximumSelectedCandidates": 36
}
```

```text
tsx benchmarks/self-hosted-core/existing-tests-builder.ts operator-plan.json sha256:<digest> evidence
assertledger verify evidence/request.json --allow-unsafe-execution --json > evidence/manifest.json
assertledger replay evidence/manifest.json --json
```

This request contains 36 candidates, six worlds, two attempts, and an exact maximum of 444
executions. The selection ceiling permits every independently useful existing test to survive the
deterministic set-cover selection if it passes every required gate. The 250-permille threshold records
one-of-four strength, but does not override the stricter required-target rule: because all four target
worlds are required, a candidate is eligible only when it kills all four. A replay-valid `REJECTED`
manifest is therefore an expected and useful inventory result when the current suite has partial but
no complete mutation coverage. See [`RESULT-existing-tests-v1.md`](RESULT-existing-tests-v1.md) for
the first measured output. As with the original campaign, `trusted-local` is explicitly unsandboxed
and the host-bound adapter remains inside the trusted computing base.
