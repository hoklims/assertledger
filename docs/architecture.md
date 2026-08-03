# Architecture

TestForge separates proposal, integration, orchestration, and decision authority. The separation
keeps model-specific behavior out of the evidence policy and process I/O out of the deterministic
core.

## Four layers

| Layer | Responsibilities | Must not do |
| --- | --- | --- |
| Agent or harness | Analyze context, propose candidate test files, submit requests | Decide that its own tests are valid |
| Integration facade | Translate Skill, MCP, JSON CLI, or SDK calls into shared use cases | Reimplement gates or selection |
| TestForge orchestrator | Snapshot repositories, enforce budgets, create workspaces, run adapters, normalize observations | Grant target credit outside the core |
| Deterministic core | Canonicalize evidence, evaluate gates, select candidates, seal manifests | Read files, spawn processes, use the network, clock, randomness, or a model |

Dependencies point downward:

```text
agent or harness
       │
       ▼
facade: skill / MCP / CLI / SDK
       │
       ▼
orchestrator: repository / execution / adapters / budgets
       │
       ▼
core: contracts / gates / selection / digests
```

The concrete source boundaries are `src/contracts`, `src/core`, `src/engine`, and the thin
`src/sdk`, `src/cli.ts`, and `src/mcp` facades. `src/contracts` and `src/core` form the deterministic
core layer: contracts own the versioned wire request, and core owns decision authority.

## Campaign data flow

```text
versioned request
  ├─ repository root and exclusions
  ├─ operator-owned worlds and provenance
  ├─ candidate test overlays
  ├─ adapter configuration
  ├─ trusted-local authorization and environment allowlist
  └─ policy and budgets
          │
          ▼
single repository snapshot and repository digest
          │
          ├─ control × world × attempt
          └─ candidate × world × attempt
                    │
                    ▼
fresh workspace per execution
world overlay → candidate overlay → adapter process
                    │
                    ▼
normalized observations
                    │
                    ▼
pure gate evaluation → deterministic selection → sealed manifest
```

The engine copies the source repository once into a campaign snapshot. Every execution receives a
fresh copy of that snapshot. World overlays apply first; candidate overlays apply second. Candidate
files must remain under a configured `candidateRoots` path.

The request separates budget scopes:

- campaign-wide: `maximumCandidates`, `maximumWorlds`, `maximumExecutions`,
  `maximumRepositoryFiles`, `maximumRepositoryBytes`, `maximumWorldOverlayBytes`, and
  `maximumTotalCandidateBytes`;
- per candidate: `maximumCandidateBytes`;
- per execution: `timeoutMsPerExecution` and `maximumOutputBytes`, applied separately to captured
  stdout and stderr.

Local timeout enforcement and process-tree termination are best effort host operations, not
containment.

## Worlds and controls

- `REFERENCE`: code the operator expects to be correct; an eligible candidate must pass it.
- `TARGET`: code containing an operator-declared fault; a strong candidate must produce an attributed
  assertion failure according to policy.
- `NEUTRAL`: an operator-declared irrelevant or equivalent variation; an eligible candidate must
  continue to pass it.

The engine runs every world without a candidate. All controls must complete, remain stable, report
`PASS`, discover no candidate tests, and claim no candidate attribution. Invalid controls make the
campaign `INCONCLUSIVE`; a candidate cannot receive credit for a world that was already broken.

TestForge does not generate mutants in v0.1. Mutant generators may produce operator-reviewed target
worlds, but they never gain decision authority.

## Determinism boundary

Process execution is not deterministic by construction. Scheduling, timing, caches, filesystem
behavior, dependencies, and the host can change observed runs. TestForge guarantees a narrower
invariant:

```text
same versioned policy + same normalized evidence = same decision
```

The core sorts decision inputs before evaluation and excludes declared host-volatile observation
fields from the decision digest. It does not make nondeterministic executions deterministic. Repeat
attempts reveal only instability observed within the configured attempt budget.

## Selection

The core removes ineligible candidates, then selects candidates by deterministic marginal target
coverage. Ties use candidate size, content digest, and identifier, in that order. Runtime is not a
tie-breaker because it depends on the host.

## Provenance and integrity

The evidence context binds the engine identity, adapter configuration, achieved isolation level,
environment allowlist names, budgets, candidate roots, and each world's provenance and overlay
digest to the decision. It does not record effective environment values. For `node:test`, the engine
probes the requested executable, resolves its real path, probes the resolved file again, and records
the matching Node.js version plus the executable's SHA-256 digest. The structured-command adapter
records its configured command but does not resolve or hash it.

The repository digest covers regular files visited by the analyzer. The analyzer omits `.git`,
`.testforge`, `node_modules`, and operator-excluded path segments. It rejects any encountered
symbolic link instead of silently excluding it. Candidate contents and world overlays have separate
digests. Preserve the snapshot and resolved dependency identities for stronger provenance.

The decision digest covers decision-relevant evidence. The artifact digest covers the emitted
manifest, including operational fields and disclosure metadata. Both are integrity checks, not
signatures; neither authenticates the producer. See [proof-model.md](proof-model.md).

The emitted manifest contains normalized observations and stdout/stderr digests, not raw process
output, candidate or world file bodies, or a repository archive. A self-contained audit bundle must
preserve those inputs and logs beside the manifest.

## Extension points

- Built-in adapters translate framework behavior into normalized observations.
- The structured-command protocol supports external test-framework reporters.
- A future isolation backend may replace `trusted-local` without changing gate ownership.
- A future native orchestrator may replace the Node.js engine only after passing shared schema,
  canonicalization, decision, and digest conformance fixtures.
