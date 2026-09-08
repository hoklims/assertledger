# Repository validation precedes runtime probing

The engine now checks the source repository's file and byte budgets before probing an adapter
runtime, running the `node:test` preflight, or creating the campaign directory. It still checks
the copied snapshot against the same budgets before executing a campaign.

Previously, an over-budget repository could return a runtime error first. A slow runtime preflight
could therefore mask `REPOSITORY_BYTES_BUDGET_EXCEEDED` with an engine error. The CLI now reliably
returns the existing repository-budget reason code and validation exit code `4` when that source
budget fails, including when the configured Node executable is unavailable.

For callers that submit several invalid inputs, error precedence changes: after request parsing
and repository-root resolution, source inventory and repository-budget errors precede runtime
probe errors. Callers should correct the reported repository problem before retrying runtime
qualification. With valid repository budgets, the existing runtime checks still apply.

No schema versions, error codes, manifest fields, gate semantics, digest projections, or unsafe
execution permissions change. Existing manifests retain their replay contract.

Compatibility witnesses in `tests/integration.test.ts` combine each invalid repository budget with
an unavailable Node executable. Both fail against the old ordering and pass with repository
validation first. The ordinary runtime and campaign tests cover valid-budget execution.

## Qualification output budgets

Both executable identity probes and both runtime preflight probes now propagate the caller's
`maximumOutputBytes`, capped by the existing internal 64 KiB ceiling. Previously these processes
always used 64 KiB, even when the caller requested less. Controlled reporter files retain their
independent fixed bound; this correction concerns captured stdout and stderr.

A runtime installed at a long path can exceed a small capture budget when reporting its identity.
That case now returns the existing `NODE_TEST_EXECUTABLE_PROBE_FAILED` validation error instead of
continuing with output captured beyond the requested limit. Increase the request budget explicitly
when needed. No schema, digest, or decision semantics change. Runtime tests include a real copied
Node executable at a long path and a runner witness for both the lower caller cap and upper safety cap.
