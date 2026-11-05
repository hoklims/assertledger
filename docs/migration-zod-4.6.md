# Migration to Zod 4.6.7

The runtime validator moves from Zod 4.4.3 to 4.6.7. This is an explicit public-contract
migration: published JSON schema bytes and some invalid-input diagnostics change. Existing
schema identifiers, request versions, policy versions and digest projections remain unchanged.

String length bounds now count Unicode code points, as JSON Schema does, instead of JavaScript
UTF-16 code units. For example, a path containing 512 emoji passes a 512-character boundary;
513 emoji fails. Combining characters and ZWJ sequences can contain several code points.
Repository and overlay byte budgets still apply separately.

An oversized array is rejected before its elements are parsed. A command with 101 invalid
arguments therefore reports the collection size error without one error per argument. Application
error codes remain the same; consumers must not depend on the complete validator diagnostic text.

JSON schema consumers must follow local `$ref` pointers. A schema with root metadata `id` now
places its object definition under `$defs`, with an escaped JSON Pointer at the root. Simple
nullable unions may use a `type` array instead of `anyOf`. Fixed tuples now explicitly declare
`items: false`, `minItems` and `maxItems`; these describe the length already enforced at runtime.

MCP object output schemas use an independent Zod clone without the canonical root metadata ID.
This keeps their root object visible to the pinned MCP SDK's legacy output codec, which does
not follow `$ref` to determine whether an output is an object. MCP structured results retain
their existing shape; the published schema documents keep their canonical IDs and root references.

Generated schema artifacts and their conformance digest inventories are refreshed together through
the documented [maintainer regeneration procedure](conformance-v1.md#maintainer-regeneration).
The conformance input/expected-output fixtures and locked public decision, artifact, profile and
benchmark digests are retained. The existing conformance and historical replay checks remain the
compatibility oracles; regeneration alone does not establish replay compatibility.
