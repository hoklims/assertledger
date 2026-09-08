# Agentic Test Profile corpus

This scaffold accumulates evidence for hypotheses H1-H4. It is not an optimization loop and it
does not alter AssertLedger's deterministic `VERIFIED` verdict.

- `public/` contains reviewable `*.case.json` evidence that may be evaluated with per-case feedback.
- `private/` is the physically separate holdout. Only aggregate H1-H4 counts may leave that split.

Each case must have a canonical paired `*.provenance.json`. The evaluator also requires an
externally pinned trust policy and expected policy digest; source IDs are never self-authenticating.

The evaluator remains `NOT_READY` until it validates at least 20 cases from at least three sources,
including non-empty public and private splits and evaluable evidence for every hypothesis.
Unsigned legacy cases remain parseable but cannot satisfy readiness. See
`docs/agentic-corpus-provenance.md` for the migration and non-claims.
