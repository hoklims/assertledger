# Private holdout split

Keep holdout `*.case.json` files local and uncommitted. The evaluator exposes only aggregate H1-H4
support, opposition, and insufficiency counts for this split. Never publish per-case holdout output.
Pair each case with its canonical provenance sidecar. Invalid provenance remains a generic holdout
corpus failure and must not reveal identifiers, signers, or counts.
