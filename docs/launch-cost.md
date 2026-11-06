# Binary launch cost experiment

[E1](https://github.com/hoklims/assertledger/issues/113) measures the process boundary selected by
accepted [ADR 0002](decisions/0002-complete-rust-migration.md), before R3. It does not implement an
AssertLedger command. The std-only probe accepts `core noop` and returns without business work.
`--echo-argv` is an argument-boundary control. No crate or in-process binding is introduced.

The target triplets come from the approved
[D7 decision](https://github.com/hoklims/assertledger/issues/99#issuecomment-6544602807).
Rust 1.99.1 is admitted by
[D6](https://github.com/hoklims/assertledger/issues/98#issuecomment-6473181859).
These are experiment results, not platform qualification for R1/R2, a latency requirement, a
migration decision, or a product speedup. In particular, an empty Node runtime is not AssertLedger.

## Reproduce from a checkout

Use the repository's pinned pnpm, Node 22.15 or newer, the approved Rust 1.99.1 toolchain on PATH,
and the native system linker/SDK. Install JavaScript dependencies with
`pnpm install --frozen-lockfile`. The driver checks the compiler version and host triplet, Node
architecture, kernel machine and OS before building or measuring. It refuses cross-compilation;
do not run the experiment under emulation and label it native.

```sh
pnpm exec tsx --test tests/launch-cost.test.ts
pnpm exec tsx scripts/benchmark-launch-cost.ts build aarch64-apple-darwin /absolute/scratch/probe
pnpm exec tsx scripts/benchmark-launch-cost.ts controls /absolute/scratch/probe
pnpm exec tsx scripts/benchmark-launch-cost.ts measure /absolute/scratch/probe aarch64-apple-darwin /absolute/scratch/new-results SOURCE_REVISION
pnpm exec tsx scripts/benchmark-launch-cost.ts summarize /absolute/scratch/new-results
```

Substitute the native triplet and use `probe.exe` on Windows. The scratch parent must exist and
the results directory must not exist. Reusing it refuses rather than overwriting evidence.
Reserve a measurement window on shared hosts. Controls and test durations are infrastructure
checks; they are never performance observations.

## Protocol

- A running Node parent reads its monotonic clock immediately before
  `spawn(executable, argv, { shell: false, stdio: ["pipe", "pipe", "pipe"] })` and at entry to `close`.
  It closes stdin immediately and drains both output streams. Elapsed time includes pipes,
  process creation, runtime initialization, scheduling, argument handling and Node notification.
  It does not isolate the OS loader.
- Targets: the optimized Rust probe with `["core", "noop"]`, Node with
  `["--eval", "", "core", "noop"]`, and `/usr/bin/true` with the probe's arguments on Unix.
  Windows has no Unix baseline; no shell is substituted. Its Rust/Node results remain comparable
  only within that host and series.
- One first-observed launch and 20 warmups per target are retained separately. Then six blocks
  of 100 iterations exercise each of the six target-order permutations once. Children run
  sequentially. Windows removes `true` from those orders, giving each pair order three blocks.
  Each target contributes 600 measured observations: 1,863 total launches on Unix, 1,242 on Windows.
- First-observed is not cold startup: controls execute the probe first. No cache eviction,
  affinity, priority adjustment, outlier removal, retry or replacement sample is used.
- Each child has a two-second deadline, capped by the remaining series budget. The current
  driver has a 120-second monotonic series budget; the retained macOS driver used 60 seconds.
  A spawn/stdin error, signal, nonzero exit, unexpected stdout/stderr or timeout refuses the
  series. Only the owned direct child is killed on timeout; it is awaited through `close`.
  These fixed probes do not create descendants. This does not qualify E2 process-tree cleanup.
- JSONL records are written after each timed interval. CPU counters, load average and free
  memory are recorded before/after each block, outside the interval. Other host activity and
  virtualization can affect the result. Windows load average is not a useful load measure;
  use the retained CPU counters. Swap, page faults and continuous thermal state are not measured.
- A successful run retains raw observations, source/executable SHA-256, compiler, Node/OS/CPU
  identity, source revision, telemetry and summary. An interrupted series keeps partial JSONL
  and has no successful summary; caught failures also produce `failure.json`. Build/runner
  failures are visible in CI logs, never observations. An artifact upload alone proves no series.
- Summary replay requires exactly one valid record for every expected phase/target/block/index.
  It rejects duplicates, missing records, failed outcomes and invalid durations. Percentiles use
  linear interpolation at `(n-1)*p`; standard deviation uses `n-1`. Durations are milliseconds.
  The samples can be correlated; no independence-based confidence interval is claimed.

## Retained macOS observation

Data: [`benchmarks/launch-cost/2026-11-06-macos-arm64`](../benchmarks/launch-cost/2026-11-06-macos-arm64).
One coordinated series ran on 2026-11-06, 14:52:24.935–14:52:49.998 UTC (25.063 seconds), on
macOS 27.2 build 26B123, Darwin 27.2.0, Mac16,6 / Apple M4 Max, 16 logical CPUs, 64 GiB RAM,
native arm64, Node 26.13.0. Compiler: Rust 1.99.1 (`58cf8f9c3`, LLVM 23.1.1), Apple clang 21.0.0,
SDK 27.0. Build: `rustc --edition=2024 --target aarch64-apple-darwin -C opt-level=3 -C debuginfo=0
probe.rs -o probe`. No strip was applied. The measured Mach-O was 472,248 bytes and linked
`/usr/lib/libSystem.B.dylib`. Binary SHA-256:
`0d8e7a1b721e64fb46be5b203b6f47d86bccce8939c1607bfbbfa779dcb15bc8`.
The binary is not archived; its source and build arguments are retained, without a claim of
byte-identical rebuilding. Repository context was `66bd40468fe6cff671b686d7a5529bda457a4832`;
the probe did not import repository code.

| Target (600 samples each) | Median | P25–P75 | P95 | P99 | Min–max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Rust minimal probe | 2.847 | 2.689–2.991 | 3.282 | 3.913 | 2.305–4.515 |
| `/usr/bin/true` | 1.817 | 1.686–1.944 | 2.080 | 2.284 | 1.374–2.660 |
| Empty Node | 34.894 | 34.193–35.878 | 38.419 | 43.252 | 32.055–51.497 |

Host CPU busy fraction was 33.0–54.4% across blocks; one-minute load average was 5.720–5.998,
instantaneous free memory 0.730–1.664 GiB. These are observations under contention. Rust block
medians ranged from 2.662 to 3.049 ms. First-observed values were Rust 3.995 ms, true 2.192 ms,
Node 35.353 ms. AC power and no recorded thermal warning were observed before the series;
neither establishes continuous thermal conditions or an idle host.

The original `samples.jsonl` bytes are retained, SHA-256
`396b84c0fb440dc2fd1fee1ce62a6f3f4a002cf4fcff8c4e650b6255a3b1819f`.
`metadata.json` replaces three personal executable paths with `<lab>/probe` or `<node>` and
records the original metadata SHA. Executable identities also replace personal paths. Hostnames,
account paths, approval messages and the private report/archive are not included.
The `sources/*.txt` snapshots preserve the measured driver, boundary control and independent
Python summary source bytes, without reformatting. Their hashes are in the retained metadata;
the current `probe.rs` is the measured source (SHA-256
`7961dd9c4eacbd04e929986feede8168c2bc80207b9b3a39fd879d26c3c0fdbb`). The active TypeScript driver
adds native-host checks, Windows handling and strict replay; its CI source identity is recorded
separately. The original summary includes paired Rust-minus-true differences and block telemetry.
Those differences compare distinct executables; they do not isolate Rust initialization cost.

Replay the raw observations without launching any probe:

```sh
pnpm exec tsx scripts/benchmark-launch-cost.ts summarize benchmarks/launch-cost/2026-11-06-macos-arm64
```

## Matrix and CI

| D7 target | Observation status |
| --- | --- |
| `aarch64-apple-darwin` | Retained macOS 27.2 / Node 26.13.0 series above |
| `x86_64-unknown-linux-gnu` | Pending native CI observation |
| `aarch64-unknown-linux-gnu` | Pending native CI observation |
| `x86_64-pc-windows-msvc` | Pending native CI observation |

The [experiment workflow](../.github/workflows/launch-cost.yml) uses standard `ubuntu-22.04`,
`ubuntu-22.04-arm` and `windows-2022` runners with Node 24. This repository is public. The
[GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
consulted 2026-11-06, lists these native architectures and free standard-runner usage for public
repositories. The catalogue is an offer, not evidence of repository scheduling permission or
successful execution. No paid runner, secret, remote setting or account permission is enabled.
Each PR-triggered series runs once per affected revision and uploads evidence for 14 days;
accepted observations must be retained in Git before artifact expiry. Data/documentation-only
updates do not schedule another measurement series. Normal product CI is unchanged.

The matrix is incomplete until actual runs and their raw data are retained. macOS 14, Node 22,
Windows 11 desktop and WSL links are not exercised by the retained macOS series or the proposed
CI matrix. D7's separate E2/E4 qualifications and OS floor checks remain separate from E1.
