# Roadmap

This roadmap separates implemented v0.1 behavior from possible future work. It makes no delivery or
compatibility promise.

## Shipped in v0.1

- deterministic repository analysis;
- four versioned public JSON Schemas;
- reference, target, and neutral overlay worlds;
- one campaign snapshot and disposable execution workspaces;
- built-in `node:test` runtime reporter and structured-command adapter;
- deterministic gates, candidate selection, reason codes, and evidence run links;
- decision and artifact integrity digests;
- JSON CLI, TypeScript SDK, MCP v2 stdio server, and integration skill;
- `trusted-local`, explicitly recorded as `UNSANDBOXED`.

## Candidate next steps

1. Add an isolation backend backed by an independently administered container or VM boundary.
2. Add framework reporters beyond `node:test` that derive discovery and attribution from runtime
   events.
3. Publish cross-runtime conformance fixtures for canonicalization, decisions, and both digests.
4. Add optional signatures or external attestations for provenance authenticity.
5. Add adapters only when their outcome mapping has adversarial contract tests.
6. Extend provenance to cover executed dependencies, structured-command binary identities, and
   effective environment inputs without leaking secrets.

## Explicitly out of scope for v0.1

- hostile-code containment;
- automatic trust in agent-supplied worlds or policy;
- proof of program correctness or complete fault detection;
- proof that a test will never become flaky;
- SLSA conformance or authenticated provenance.
