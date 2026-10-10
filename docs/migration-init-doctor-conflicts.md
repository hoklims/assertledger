# Structured initialization conflicts

Static `doctor`, `init --dry-run` and `init` now return their existing versioned JSON result with
`status: "CONFLICT"` and exit code 4 when the derived inventory exceeds a schema limit. They do not
truncate the inventory or install managed files for a conflicting plan.

| Reason code | Existing limit |
| --- | --- |
| `BASE_TEST_FILES_LIMIT_EXCEEDED` | 1,000 selected base test files for either built-in adapter |
| `INIT_EVIDENCE_PATH_LIMIT_EXCEEDED` | 1,024 characters per repository-relative evidence path |
| `INIT_FILE_CONTENT_LIMIT_EXCEEDED` | 16,777,216 characters per generated config or lock content |

These are new reason codes, accepted by the existing init v1/v2 schemas. Previously these inputs
escaped as config, lock or result validation exceptions, leaving CLI stdout empty. The result,
config and lock schemas, their digest projections, and the adapter limits remain unchanged.
The valid 1,000-file boundary still produces a complete initialization plan.

`explain` now covers every static initialization reason and its named contract errors. For
`FRAMEWORK_AMBIGUOUS`, inspect test imports, dependencies and scripts, then select a detected runner
with `--framework`. The existing strict result schemas have no field for a list of detected
frameworks or limit/count metadata; this change does not add those fields to frozen versions.

Regression tests exercise all three CLI entry points on synthetic 1,001-test Bun and Node
repositories, the valid 1,000-test boundary, an oversized evidence path, and a canonical lock above
the planned-file limit. macOS cannot construct a repository path above 1,024 characters and reports
an explicit skip for that single fixture after `ENAMETOOLONG`; Windows/Linux execute it. The lock-size
fixture uses shorter paths and more entries so it runs on all three systems. The same behavioral
tests fail with attributed assertions on the 1.5.0 source baseline.
Catalogue coverage tests enumerate the initialization codes, require `known: true` and actionable
guidance, and detect newly introduced codes in the static initialization source.

The correction preserves campaign outcome taxonomy, symbolic-link policy, `.gitignore` handling
and release authority. Its initialization schemas remain unchanged; the audit producer migration
is published separately as part of AssertLedger 2.0.0.
