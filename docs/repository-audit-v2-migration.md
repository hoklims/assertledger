# Repository audit v2

Audit now emits `schemaVersion: "2.0.0"`. The npm package version is unchanged.
The strict v1 schema, `RepositoryAuditSchema`, `parseRepositoryAudit`, and
`repositoryAuditJsonSchema()` remain available unchanged for historical artifacts.
Use `RepositoryAuditV2Schema`, `parseRepositoryAuditV2`, and
`repositoryAuditV2JsonSchema()` for current audit output. The SDK schema selector
`repository-audit` retains v1; `repository-audit-v2` selects v2.

V2 adds `appliedExcludes: { source, entries }`. Entries are sorted, unique portable
entry names, including the defaults `.git`, `.testforge`, and `node_modules`.
With a verification request, source is `request` and entries derive exclusively
from `request.repository.exclude` plus defaults, exactly as campaign copying does.
Configuration never removes additional files from a campaign audit.
Without a request, a valid `assertledger.config.json` supplies source `config`;
otherwise source is `defaults`. CLI explicit requests and automatic
`assertledger.request.json` discovery follow the same rule.

The initial and final inventories reuse one snapshot of the exclusion list.
`repositoryBytes`, file facts, digest, and `cost.materializationBytes` describe
that inventory. Symlinks remain forbidden wherever that inventory includes them.
An inventory symlink refusal carries the same `appliedExcludes` disclosure in
`RepositoryAuditInventoryError`. Init and doctor can continue proposing audit.

This changes the audited inventory and may change its digest, byte count, and
campaign cost projection compared with v1. Campaign execution and its manifest
and decision digest projections are unchanged. Consumers validating audit JSON
must select the v2 schema; do not strip disclosure and relabel current output as v1.
