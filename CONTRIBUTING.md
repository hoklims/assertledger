# Contributing

AssertLedger accepts small, reviewable changes backed by observable behavior.

Use Node.js 22.15 or newer and pnpm 11.

`pnpm test` and `pnpm test:coverage` build the package through their explicit pretest lifecycle
scripts, enabled in `pnpm-workspace.yaml`. This supplies the compiled reporter even in a fresh
checkout. `pnpm check` includes that same build and test path.

1. Read `AGENTS.md`, `docs/architecture.md`, and `docs/proof-model.md`.
2. Install the pinned toolchain with `pnpm install --frozen-lockfile`.
3. Add a failing test for public behavior changes.
4. Keep deterministic decision logic in `src/core`; keep I/O in `src/engine`.
5. Run `pnpm generate:schemas` after changing any wire contract, and include all resulting files in
   `schemas/` in the review.
6. Run `pnpm check` and include the relevant evidence in the pull request.

Test and coverage runs execute at most two test files concurrently. Many suites launch real child
processes; bounded concurrency keeps their unchanged execution deadlines meaningful on shared hosts.

Commits should follow Conventional Commits. Contract-breaking changes require a schema-version and
migration discussion before implementation.

The following surfaces are public contracts: request schemas, normalized outcomes, candidate and
campaign statuses, gate ordering, reason codes, CLI exit codes, canonicalization, decision-digest
scope, artifact-digest scope, adapter protocols, and MCP tool schemas. Add compatibility tests and a
migration note before changing any of them.

Do not run `trusted-local` campaigns on untrusted contributions or credential-bearing CI runners.
The normal `pnpm check` gate does not require a user-supplied unsafe campaign.
