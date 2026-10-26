# ADR 0004: Attribute Bun candidates to native `expect` matchers

Status: accepted

## Decision

`assertledger/bun` and its `assertSame` helper disappear. Before they do, a separate additive 2.x
release migrates the Bun candidate attribution contract to Bun's native `expect` matchers, on the
mechanism the designated mode already uses.

The admitted matchers are the built-in matchers of the designated mode (v4, extended in v5, on
Bun 1.4.2), excluding the snapshot family and excluding custom matchers, trusted or not.

## Rationale

In the v3 candidate profile, only `assertSame` produces an attributed error: the engine installs
the helper in each workspace and the preload intercepts it. The designated mode already attributes
Bun's built-in `expect` matchers. One attribution rule is simpler to qualify and to port to Rust
than two.

A snapshot cannot serve as evidence in a disposable workspace: it either always passes by writing
its file, or fails everywhere.

## Consequences

- The migration release introduces verification request and evidence manifest v6. A v6 manifest no
  longer binds a helper digest. Versions v1–v5, their schema bytes, and the existing schema lock do
  not change.
- The preflight gains two negative witnesses: a snapshot matcher and a custom matcher must each be
  refused.
- The v3 candidate corpus is rewritten from `assertSame(a, b)` to `expect(a).toBe(b)`. Whether Bun's
  `toBe` follows `Object.is` (NaN, +0/-0, objects) is not documented and must be confirmed by an
  experiment before the profile is qualified.
- 3.0.0 refuses Bun v3 requests with a stable code and stops executing the v3 profile. How 3.0.0
  treats designated tests that import `assertledger/bun` is decided separately. Existing v3
  manifests remain replayable.
