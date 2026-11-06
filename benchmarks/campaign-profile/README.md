# Campaign duration profile — E5

A small local campaign took **2,542.890 ms median** with the unmodified producer and native
tracing. In the median profiled run, process boundaries occupied **2,183.838 ms (84.7%)** of
wall time and `decideEvidence` occupied **4.892 ms (0.19%)**. Process time includes the child
runtime, runner, collection, tests and OS waits; it is **not the cost of `spawn` alone**.
These measurements predict no Rust speedup and authorize no optimization or migration.

This is the reproducible duration profile requested by [issue #114](https://github.com/hoklims/assertledger/issues/114),
before R3. [Accepted ADR 0002](../../docs/decisions/0002-complete-rust-migration.md) establishes
the process boundary for migration without promising performance. The existing
[container measurements](../../docs/container-runtime-performance.md) cover a different witness
on Windows/Docker WSL; their numbers cannot be combined with this local profile.

## Witness and measurements

Source: **`66bd40468fe6cff671b686d7a5529bda457a4832`**. The witness is that revision's
`examples/node-test/request.json`: three repository files / 285 bytes, three worlds
(reference, target, neutral), two candidates (strong, weak), two attempts. Each campaign has
six controls and twelve candidate observations. It exposes fixed costs of short Node tests,
not large repositories, long tests, Bun designated mode, Docker or v5 closure planning.

Eight campaigns ran serially on 2026-11-06, 14:58:48.854–14:59:10.597 UTC. The measurement slot
was coordinated after the other performance lane finished; background host activity remained.
One warmup per producer preceded three interleaved pairs: B1/P1, P2/B2, B3/P3. No retries.
B is the intact build with native tracing; P is the same build plus the span instrumentation below.

| Producer | Warmup | Run 1 | Run 2 | Run 3 | Median | Min–max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| B | 2549.277 | 2524.976 | 2542.890 | 2556.544 | 2542.890 | 2524.976–2556.544 |
| P | 2591.217 | 2581.807 | 2558.306 | 2579.652 | 2579.652 | 2558.306–2581.807 |

All durations are milliseconds. Warmups are excluded from statistics. The observed difference
between medians is **+36.762 ms / +1.45%**. Three pairs cannot distinguish instrumentation
perturbation from load drift; no duration is corrected by subtracting this difference. Both
producers enable native tracing, so the cost of native tracing alone is unmeasured.

The following is a non-overlapping partition of **P3**, the median profiled campaign. It does
not sum independently selected phase medians.

| Boundary | ms | % wall |
| --- | ---: | ---: |
| Outside `verifyPreparedCampaign`: CLI startup/loading, trace setup/flush, serialization, exit | 204.610 | 7.93 |
| Node identity: two probes and executable hash | 164.046 | 6.36 |
| `node:test` qualification: two probes | 218.383 | 8.47 |
| 18 observations, including workspaces and cleanup | 1973.709 | 76.51 |
| `decideEvidence`: parsing, gates, selection, initial seal | 4.892 | 0.19 |
| Other preparation: inventory, snapshot, digest, final seal, campaign cleanup | 14.012 | 0.54 |

Inside the observations line: processes 1889.445 ms, copies 44.185 ms, overlays 7.132 ms,
report reading 4.715 ms, cleanup 21.886 ms, remainder 6.347 ms. These nested times are never
added again to wall time. The executable hash takes 83.065 ms inside Node identity.
The 22 process spans comprise 18 observations plus two identity probes and two qualification
probes. Expected qualification failures never earn target credit. `decideEvidence` does not
cover every pure computation in the CLI: final artifact sealing occurs outside it.

Native P3 tracing reports 3.619 ms for the snapshot and 44.824 ms for workspace copies.
Its slightly different boundaries provide a cross-check, not additional wall time. Native ISO
start timestamps have millisecond precision and are not merged with high-resolution spans.

## Instrumentation and validity

[`instrument.mjs`](instrument.mjs) wraps 20 functions in three **private compiled modules**;
[`recorder.mjs`](recorder.mjs) uses `performance.now()` and `AsyncLocalStorage` parent IDs.
Wrappers retain function bodies, return values and thrown errors, and close spans in `finally`.
Instrumentation refuses absent or ambiguous function boundaries; `node --check` validates each
modified module. It is tied to the recorded compiler output, not a general JavaScript parser.
The exact function inventory is in [the data](2026-11-06/instrumentation.json).

At the source SHA, the principal boundaries are `src/engine/index.ts`:
`runBoundedProcess` (502), `probeNodeTestExecutable` (5031), `executeObservation` (6020),
qualification (6756), snapshot (6798), execution loops (6907), final seal (7248);
`src/engine/adapters/node-test-runtime.ts:240` and `src/core/index.ts:1079`.
The analysis checks parent containment and non-overlapping siblings before deriving residuals
and interval unions. Summing nested process wrappers would double-count them.

All eight captured campaigns returned `VERIFIED`, selected `strong`, and produced 18 observations:
16 `PASS` and two attributed `ASSERTION_FAILURE` outcomes on the strong target. There were no
observation timeouts or infrastructure failures, and stderr was empty. Each native trace has
one snapshot and 18 copies; each profiled campaign has 22 completed process spans, 18 observation
spans and one decision. All eight original manifests passed schema, decision digest, artifact
digest and decision semantics replay checks, outside the timer.

The comparison removes only `artifactDigest` and observation `durationMs`/`stdoutDigest`/
`stderrDigest`. It **retains `decisionDigest`** and all other fields. Every original comparison
projection hashes to `8b27ef77fe7c10646b604b76248acf055aabec31d69ab31d45061643f73fa27e`;
all decision digests are `sha256:9c8f0f7a41feabd1ae7ea88a325e656bf22af10d1671877d0349c70b9041ae1b`.
These are benchmark comparison rules, not a change to AssertLedger's digest projections.

## Published data and privacy

[Summary](2026-11-06/summary.json), [derived partitions](2026-11-06/analysis.json),
[environment](2026-11-06/environment.json) and [provenance](2026-11-06/provenance.json) are readable
JSON. [`2026-11-06/runs/`](2026-11-06/runs) retains all eight outputs, native traces, load samples,
replays and the four span captures; large captures are individual gzip files with zero gzip mtime.
[`files.json`](2026-11-06/files.json) gives published byte sizes/SHA-256 values and original capture
SHA-256 values. The private archive's 67 entries were checked before extracting this subset.
Setup/check logs and the private report are excluded; they are not needed to recompute durations.

Machine paths are replaced with `<NODE_EXECUTABLE>` and `<TASK>` in the request and captures;
PATH is omitted from the environment record. Timing, outcomes, original sealed digests and
replay results are unchanged. **`stdout.redacted.json.gz` is an expurgated capture, not a
replayable sealed manifest**: its two executable identity values have changed. No capture has
been resealed. Original replay results describe the original bytes, whose hashes are retained,
not these public copies. A fresh reproduction produces its own raw, replayable manifests in a
private output directory. The public native traces and load samples are unchanged raw data;
span captures change only process metadata paths.

Producer, dependency, witness, request and Node fingerprints before/after the series are in
[`identities-before.json`](2026-11-06/identities-before.json) and
[`identities-after.json`](2026-11-06/identities-after.json). They match. Full producer/dependency
trees are not archived; rebuilding the source and lockfile does not promise identical build bytes
on another machine.

## Recompute without another campaign

Python 3 can inspect the retained evidence without launching the CLI or test processes:

```sh
python3 benchmarks/campaign-profile/test_reproduction.py
python3 benchmarks/campaign-profile/analyze.py benchmarks/campaign-profile/2026-11-06
```

The native Python tests exercise partitioning and failure paths separately from `pnpm check`.
The analyzer prints JSON containing the four profiled partitions and min/median/max wall times.
Compare `profiles` with the stored `analysis.json`; timings are calculated from captured spans
and `summary.json`, not copied from the table. Use Python's `gzip` module or `gzip -dc` to read
individual captures. The analyzer accepts both compressed public data and fresh uncompressed runs.

## Reproduce a new series

**Reserve a performance slot with the other measurement lanes before running a new series.**
Nothing below is part of the default repository check. Use only the known example: `trusted-local`
is explicitly **UNSANDBOXED**. Do not run this on untrusted code or a credential-bearing host.

Requirements: Git, Python 3, Node 24.22.1 for the reference runtime and pnpm 11.1.2. The scripts
use POSIX symlinks; this reproduction was exercised only on macOS arm64. Build from a fresh
source archive in a short external directory, outside any workspace ancestor of the measured
repository. Keep dependencies, binaries and temporary files fixed through the series.
For example, set `REPO`, `LAB`, `NODE` and `PNPM` to absolute operator-owned paths, with `LAB`
a fresh short directory outside `REPO` and its ancestors. Use the native pnpm executable if a
local shim does not invoke the pinned package manager. No global installation is required.

```sh
mkdir -p "$LAB/source" "$LAB/tmp"
git -C "$REPO" archive 66bd40468fe6cff671b686d7a5529bda457a4832 | tar -x -C "$LAB/source"
export PATH="$(dirname "$NODE"):$(dirname "$PNPM"):$PATH"
export TMPDIR="$LAB/tmp"
( cd "$LAB/source" && "$PNPM" install --frozen-lockfile --store-dir "$LAB/store" && "$PNPM" run build )
python3 "$REPO/benchmarks/campaign-profile/prepare.py" "$LAB/source" "$LAB/campaign" "$NODE"
"$NODE" "$LAB/campaign/run.mjs" "$LAB/campaign"
python3 "$LAB/campaign/analyze.py" "$LAB/campaign" > "$LAB/analysis.json"
```

Preparation alone does **not** measure a campaign. It copies the build into B and P, copies the
example repository, substitutes only repository/Node paths in the request, instruments P and
checks its syntax. Dependencies remain linked to the private source build; do not rebuild or
modify that source during measurements. The output must be fresh and external; an existing run
directory is refused. The historical preparation kept these files inside its task worktree;
the public preparation deliberately moves them outside to avoid ancestor-workspace interference.

The runner issues argv arrays with `shell: false`:
`node <B-or-P>/dist/cli.js verify <task>/request.json --allow-unsafe-execution`, followed by
`node <B>/dist/cli.js replay <run>/stdout.json`. Wall time covers CLI launch through process
close, including trace writes; installation, build, preparation, replay and repository checks
are outside the timer. A 500 ms sampler records host CPU counters, load averages and free memory.
Failed commands, stderr, invalid replay, semantic divergence, missing trace/span coverage or
changed input fingerprints stop the series without retry. Partial outputs remain for diagnosis;
start from a fresh task after correction. New timings, paths and volatile digests will differ.

## Environment and limits

Recorded host: macOS 27.2 (26B123), Darwin 27.2.0 arm64, Apple M4 Max / Mac16,6, 16 logical CPUs,
64 GiB RAM, Node 24.22.1, native pnpm 11.1.2, TypeScript 7.0.2 and Zod 4.6.7 from the lockfile.
CPU busy fractions over the six measured runs range from 18.65% to 37.44%; one-minute load averages
range from 4.237 to 4.458. The host was not idle, background processes were not identified,
and free memory is not a memory-pressure measurement. Caches were warm; three repetitions
provide neither a broad workload model nor a confidence interval.

The historical `pnpm check` failed: 1,154 pass / 78 fail / one skip out of 1,233 tests.
It used a rebuilt Bun 1.4.4 with a revision different from the admitted pin, a temporary directory
inside the source tree and a pnpm shim. Not every failure was individually diagnosed. These
failures are not campaign results or release qualification; this delivery does not weaken any pin
or test. Current delivery checks belong to the pull request, not to these historical measurements.

No Linux, Windows, Node 22, Docker or distributed package performance was measured here.
The repository CI matrix covers Linux/Windows/macOS and Node 22/24 correctness, which is separate
from performance evidence. This result is a measured budget for this small local witness.
Measuring R3's replay/core operations and process boundary is still necessary to evaluate R3;
this campaign is no prediction of a Rust gain.
