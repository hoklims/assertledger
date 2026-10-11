# Bun preflight refusal diagnostics

The Bun preflight acceptance predicates and the successful probe protocol (`1.0.0`) are
unchanged. A failed controlled probe still refuses the campaign with exit code 4 and the
stable error message `BUN_TEST_PROFILE_PREFLIGHT_FAILED`. It never becomes a target kill.

For `verify` and `import-witness`, stderr now names the profile and probe and prints the
expected and observed outcome, attribution, total discovery count and candidate discovery
count. With `--json`, stdout additionally contains a refusal diagnostic, validated by
`BunPreflightRefusalSchema`, instead of the formerly empty stdout. Consumers must branch on
the exit code before treating stdout as a campaign manifest.

The new diagnostic has `schemaVersion: "1.0.0"`, `status: "REFUSED"`, `code`, `profile`,
`probe`, `failure`, `expected`, `observed`, `process` and `detail`. The failure is
`REPORT_MISMATCH`, `REPORT_UNAVAILABLE` or `EXECUTION_ERROR`. Both result objects name
`outcome`, `attributed`, `testsDiscovered` and `candidateTestsDiscovered`. If no valid
driver report exists, all observed fields are null: they do not mean zero tests or a
passing probe. Available process facts remain separate (`outcome`, `exitCode`, `signal`,
`timedOut`, `durationMs`); execution errors without a process have `process: null`.

The existing explanation catalogue and successful manifests keep their schemas, versions,
canonicalization and digest projections. All backends share the same diagnostic handling;
the ordinary file-candidate Bun profile remains unsupported in containers.

`import-witness` validates an existing output path before execution but creates the new
output directory only after verification succeeds. A refused preflight makes no write to
`--out`. Exclusive creation still protects concurrent imports, and cleanup only owns the
directory successfully reserved by that import. The manifest is still written last.

No preflight cache or container-call batching is introduced. These diagnostics establish
which probe and transport result failed before any performance optimization is measured.
