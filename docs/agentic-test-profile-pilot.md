# Agentic Test Profile pilot

This pilot exercises the implemented profile against two real AssertLedger campaigns from
`dofus-battlebot`. It is compatibility and local repeatability evidence, not a benchmark of broad
fault-detection effectiveness.

## Frozen inputs

| Campaign | Source artifact digest | Observations | Attempts | Source decision |
| --- | --- | ---: | ---: | --- |
| `recover-v1` | `sha256:e696766ae1effc96203d2077cf51e9e7f731f708dad1f0c94b9c6a9876d1cca9` | 90 | 3 | `VERIFIED` |
| `recover-v2` | `sha256:ed03d03d2892d7b945ef0af0506bb44ccb84eff73ea7f99a990335312137ba9f` | 90 | 3 | `VERIFIED` |

Both campaigns contain one reference world, four required target worlds, one required neutral
world, and four candidate tests. They use the unsandboxed trusted-local backend.

## Policy

Both manifests were profiled with three local lanes: `instant` at 2,000 ms, `loop` at 10,000 ms,
and `gate` at 60,000 ms. The minimum timing sample count was three.

## Results

| Campaign | Profile | Qualified candidate | Target weight | Reference p95 | Pareto | Replay |
| --- | --- | --- | ---: | ---: | --- | --- |
| `recover-v1` | `QUALIFIED` | `boundary-complete` | 1000/1000 | 159 ms | yes | valid |
| `recover-v2` | `QUALIFIED` | `boundary-complete` | 1000/1000 | 165 ms | yes | valid |

Every lane selected the same one-candidate portfolio. The other candidates remained
`NOT_QUALIFIED`, including a fast candidate that killed all targets but failed the reference gate.
This is the intended non-compensation behavior: speed and mutant kills do not rescue an invalid
oracle.

## Reproduction

After `pnpm build`, run the packaged example against either manifest:

```sh
node examples/agentic-profile/profile-manifest.mjs /path/to/manifest.json campaign/profile-id
```

Replay the emitted JSON with `assertledger profile-replay`.

## What this pilot establishes

- existing v1 evidence manifests remain accepted without migration;
- the profile derives the same qualitative decision across two independently sealed campaigns;
- local timing evidence is sufficient for the declared policy;
- report replay validates source evidence, policy digest, report digest, and recomputed semantics;
- an invalid fast candidate cannot enter the Pareto frontier or a selected portfolio.

## What remains unproven

The campaigns exercise the same repository behavior, candidate family, and target portfolio. They
do not establish H1 through H4, compare against a coverage-guided baseline, estimate confidence
intervals, or test a hidden holdout. They also do not separate cold, warm, collection, compilation,
and execution phases. A public sweet-spot claim remains blocked on a broader versioned corpus.
