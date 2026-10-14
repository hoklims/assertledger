# Session Spec — rust-migration

## Goal
Create a pull request implementing the complete Rust migration with compatible npm and JavaScript SDK facades.

## Scope
- Rust owns deterministic decisions, contracts, orchestration, qualification, planning and evaluation.
- Keep npm exports, CLI/MCP protocols, Node/Bun target reporters, and existing JSON schemas.
- No merge, registry publication or deployment was requested.

## Constraints
- Base: ecdffeee071435087afddfa2ad180e31faef1c12; preserve existing doctor/Bun PRs.
- Preserve schema versions, digests, classification, isolation disclosures and executable/argument commands.
- One mutator per worktree; native specialists have bounded ownership.

## Tasks
- [x] Inventory runtime and public contracts; user selected npm/SDK compatibility.
- [ ] Establish baseline and frozen parity oracle; implement native layers and facades.
- [ ] Verify Rust, existing suite, packaged distribution and independent proof scrutiny.
- [ ] Commit, push, create and attach PR; read back exact head and CI status.

## Dependencies
- Native interface design precedes facade cutover; frozen parity precedes accepted core replacement.

## Done means
- All production logic is Rust; facades retain public behavior; required checks pass on exact candidate.
- PR accurately states completed migration and any measured limits.

## Not-done risks
- Callbacks/Maps/error types across native boundary; UTF-16 ordering and ECMAScript numbers.
- Node/Bun attribution, process trees, container isolation, schema refinements and all historical versions.
