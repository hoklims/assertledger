# AssertLedger contributor instructions

AssertLedger judges evidence. Changes to outcomes, gates, canonicalization, schemas, exit codes,
or manifest digests are public contract changes.

## Architecture boundaries

- `src/contracts`: versioned wire contracts and validation.
- `src/core`: pure deterministic decision logic. No filesystem, process, network, clock, or random
  input.
- `src/engine`: repository analysis, disposable workspaces, process execution, adapters, and
  budgets.
- `src/sdk`, `src/cli.ts`, `src/mcp`: thin integration facades. They must not reimplement gates.

## Required workflow

1. Add or update a failing behavioral test before changing a public contract.
2. Never count timeout, compilation, collection, process, or infrastructure errors as target kills.
3. Keep commands as executable plus argument arrays; never introduce shell-string execution.
4. Preserve `trusted-local` as explicitly unsandboxed.
5. Run `pnpm check` before claiming completion.

Do not change schema major versions or decision- or artifact-digest projections silently. Add a
migration note and compatibility tests for any such change.
