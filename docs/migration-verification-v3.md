# Verification v3 and Bun test migration

Verification request and evidence manifest v3 add the built-in `bun-test` adapter. V1 and v2
schema bytes, adapter unions, and historical manifests remain unchanged and replayable. V3 keeps
the v2 execution-backend record and accepts `node-test` and `testforge-command` as before.
`bun-test` requires `trusted-local`; a v3 Bun request with container isolation is refused before
execution.

`assertledger init` writes repository initialization config, lock, and result v2 for a detected
`bun:test` repository with one or more base test files. Existing Node initialization remains v1.
If a repository contains multiple test frameworks, select `--framework bun:test` explicitly.
Local-only linked entries still need explicit `--exclude NAME` declarations. Static initialization
does not execute tests or qualify the installed Bun binary. Run the unsafe runtime doctor, then
a v3 campaign with operator-supplied worlds and candidates.

New Bun candidate tests use `assertSame` from `assertledger/bun`. Existing `bun:test` tests can
remain as base controls. Their native `expect` failures block a campaign as operational failures;
they are not assertion evidence. The helper compares only with `Object.is`, so use an explicit
scalar or boolean observation when structural equality is needed. Calculation errors occur before
the helper and remain ordinary errors. The helper is installed from the package into each
disposable workspace; no adapter implementation is required in the consumer repository.

The Bun runtime profile pins version `1.4.2` and revision
`744846f844374847c902b5e7fd59b4342a51ef99`. New manifests bind the resolved executable
digest, Bun revision, driver digest, preload digest, helper digest, command shape,
and fresh runtime preflight. They may have new decision and artifact digests because v3 evidence
has a new schema identity. No old manifest is resealed. The v3 schemas are added to the
post-conformance schema lock; the frozen v1 bundle and its root digest are unchanged.

The v1 provider/export contracts still describe v1 manifests only. Consumers of v3 Bun evidence
should parse and replay the v3 manifest directly; they must not project it through the v1 export
contract. Windows, Linux, and macOS support is claimed only for the exact Bun version on which
the corresponding CI campaign gate passes.
