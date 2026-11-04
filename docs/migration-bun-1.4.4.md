# Qualified Bun runtime moves to 1.4.4

The built-in Bun adapters qualify exactly one runtime. It moves from Bun 1.4.2 (revision
`744846f844374847c902b5e7fd59b4342a51ef99`, `bun --revision` prints `1.4.2+744846f84`) to
Bun 1.4.4 (revision `38afee6c84fcf48c0edb2466aa4b27d287a59c30`, `bun --revision` prints
`1.4.4+38afee6c8`). This is the identity of the official release binaries installed by CI.
There is no range: neither 1.4.2 nor 1.4.3 is accepted. A different revision is also refused even
when its reported version is 1.4.4; the version label alone does not qualify a rebuilt binary.

This applies to the `bun-test` adapter (verification v3), the designated `bun-test-designated`
adapter (verification v4 and v5, including the container and Windows-native backends), witness
import v1 and v2, `doctor --runtime` for `bun:test`, and the `bun-native` qualification
collector.

## What a different Bun now does

A Bun that is not exactly 1.4.4 is refused before any campaign executes. It is never a target
kill and never evidence:

- `verify` and `import-witness` exit 4 with `BUN_TEST_VERSION_UNSUPPORTED`; `explain` now names
  Bun 1.4.4 as the next action.
- `doctor --runtime` reports `RUNTIME_BUN_VERSION_UNSUPPORTED`.
- The `bun-native` collector reports `INFRA_ERROR`.
- In a container, the same gate runs on the image's Bun, so the image must contain exactly Bun
  1.4.4. Pin it by digest. The `oven/bun` digest recorded in
  [container-runtime-performance.md](container-runtime-performance.md) is a dated 1.4.2
  measurement and is unchanged.

## Digests

No schema version, schema byte, digest projection, outcome, gate, exit code, reason code,
conformance bundle or schema lock changed. What changed is the evidence a Bun campaign records:

- `adapter.version`, `bunVersion` and `bunRevision` name 1.4.4, and the executable digest is that
  of the resolved 1.4.4 binary.
- `driverDigest` changes: the driver carries the new revision literal.
- `preloadDigest` changes: only a comment naming the runtime was edited. The matcher allowlist is
  the same 86 names, and was compared with the matcher surface of both runtimes.
- `helperDigest` is unchanged.

The decision and artifact digests of a new campaign therefore differ from those of the same
campaign sealed under 1.4.2 because the recorded Bun identity and bundled adapter bytes changed.
These digests identify different evidence contexts. The Node runtime pin did not change.

`bun-test` keeps profile version `1.2.0` and `bun-test-designated` keeps `1.0.0`. They name the
capability contract (transport and attribution), which did not change; the runtime is recorded
next to them. The `bun-native` collector contract stays `1.0.0`: replay compares every sealed
adapter version with the current one by equality, so raising it would reject every receipt that
predates this move.

## Existing evidence

Manifests sealed under Bun 1.4.2 still parse and replay: replay recomputes digests and decision
semantics from the recorded evidence and never consults the current pin. They attest Bun 1.4.2
only. They are not resealed and must not be presented as 1.4.4 evidence. The twelve tracked
container-runtime benchmark manifests are replayed against their recorded digests by
`tests/bun-pin-compat.test.ts`.

A stored witness (v1 or v2) records no Bun identity: importing it re-executes the campaign and
seals a new manifest under 1.4.4.

Qualification receipts collected with the 1.4.2 collector still replay on their own bytes. The
mechanism digest covers the `bun-native` collector and its driver, so they do not validate in the
new mechanism domain; collect new evidence instead of resealing them. The public orchestration
profile is generated for the new runtime under
`public-turbo-orchestration-2.11.7-bun-1.4.4`; see
[migration-orchestration-qualification-v1.md](migration-orchestration-qualification-v1.md).

## Behavior between the two runtimes

The existing adapter fixtures exercise JUnit transport, attribution, hooks, timeouts,
collection and syntax errors on Bun 1.4.4. Qualification is bounded by those fixtures and the
platforms on which the CI matrix succeeds; it does not establish equivalent behavior for every
repository test. The 86-name matcher allowlist matches the native matcher surface inspected on
1.4.4, and custom replacements remain outside built-in attribution. See the upstream
[Bun 1.4.4 release notes](https://bun.sh/blog/bun-v1.4.4) for runtime changes.

## Upgrade

Install Bun 1.4.4, run `doctor --runtime --allow-unsafe-execution`, and rerun campaigns that must
be evidence for the new runtime. Windows, Linux and macOS support is claimed only where the CI matrix installing Bun 1.4.4 passes.
