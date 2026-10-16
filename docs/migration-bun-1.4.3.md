# Qualified Bun runtime moves to 1.4.3

The built-in Bun adapters qualify exactly one runtime. It moves from Bun 1.4.2 (revision
`744846f844374847c902b5e7fd59b4342a51ef99`, `bun --revision` prints `1.4.2+744846f84`) to
Bun 1.4.3 (revision `c6da4a4d3010e5553438c60f6bd76d981976867c`, `bun --revision` prints
`1.4.3+c6da4a4d3`). There is no range: 1.4.2 is no longer accepted.

This applies to the `bun-test` adapter (verification v3), the designated `bun-test-designated`
adapter (verification v4 and v5, including the container and Windows-native backends), witness
import v1 and v2, `doctor --runtime` for `bun:test`, and the `bun-native` qualification
collector.

## What a different Bun now does

A Bun that is not exactly 1.4.3 is refused before any campaign executes. It is never a target
kill and never evidence:

- `verify` and `import-witness` exit 4 with `BUN_TEST_VERSION_UNSUPPORTED`; `explain` now names
  Bun 1.4.3 as the next action.
- `doctor --runtime` reports `RUNTIME_BUN_VERSION_UNSUPPORTED`.
- The `bun-native` collector reports `INFRA_ERROR`.
- In a container, the same gate runs on the image's Bun, so the image must contain exactly Bun
  1.4.3. Pin it by digest. The `oven/bun` digest recorded in
  [container-runtime-performance.md](container-runtime-performance.md) is a dated 1.4.2
  measurement and is unchanged.

## Digests

No schema version, schema byte, digest projection, outcome, gate, exit code, reason code,
conformance bundle or schema lock changed. What changed is the evidence a Bun campaign records:

- `adapter.version`, `bunVersion` and `bunRevision` name 1.4.3, and the executable digest is that
  of the resolved 1.4.3 binary.
- `driverDigest` changes: the driver carries the new revision literal.
- `preloadDigest` changes: only a comment naming the runtime was edited. The matcher allowlist is
  the same 86 names, and was compared with the matcher surface of both runtimes.
- `helperDigest` is unchanged.

The decision and artifact digests of a new campaign therefore differ from those of the same
campaign sealed under 1.4.2, as a Node upgrade changes `node-test` evidence. Do not compare them.

`bun-test` keeps profile version `1.2.0` and `bun-test-designated` keeps `1.0.0`. They name the
capability contract (transport and attribution), which did not change; the runtime is recorded
next to them. The `bun-native` collector contract stays `1.0.0`: replay compares every sealed
adapter version with the current one by equality, so raising it would reject every receipt that
predates this move.

## Existing evidence

Manifests sealed under Bun 1.4.2 still parse and replay: replay recomputes digests and decision
semantics from the recorded evidence and never consults the current pin. They attest Bun 1.4.2
only. They are not resealed and must not be presented as 1.4.3 evidence. The twelve tracked
container-runtime benchmark manifests are replayed against their recorded digests by
`tests/bun-pin-compat.test.ts`.

A stored witness (v1 or v2) records no Bun identity: importing it re-executes the campaign and
seals a new manifest under 1.4.3.

Qualification receipts collected with the 1.4.2 collector still replay on their own bytes. The
mechanism digest covers the `bun-native` collector and its driver, so they do not validate in the
new mechanism domain; collect new evidence instead of resealing them. The public orchestration
profile is generated for the new runtime under
`public-turbo-orchestration-2.11.7-bun-1.4.3`; see
[migration-orchestration-qualification-v1.md](migration-orchestration-qualification-v1.md).

## Behavior between the two runtimes

For the adapters, 1.4.3 behaves like 1.4.2: the JUnit shape, exit codes, stderr markers, hook,
timeout and syntax-error handling are identical on the controlled fixtures, `expect()` exposes the
same matcher surface, and `expect.extend` still installs a different function under a reused
built-in name. Two upstream fixes can change what a repository's own tests conclude, not how an
assertion is attributed: `expect.not.any()` on a primitive and an asymmetric matcher meeting an
array hole now fail where 1.4.2 passed or crashed.

## Upgrade

Install Bun 1.4.3, run `doctor --runtime --allow-unsafe-execution`, and rerun campaigns that must
be evidence for the new runtime. Linux and macOS support is claimed only for the platforms on
which the CI matrix, which now installs 1.4.3 on all three systems, passes.
