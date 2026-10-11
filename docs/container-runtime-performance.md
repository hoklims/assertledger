# Container runtime performance

[Container isolation](container-isolation.md) describes the security controls. This page describes
operator diagnostics and a reproducible timing procedure. Runtime diagnostics do not enter the
manifest or its decision inputs.

## Trace runtime calls

Set `ASSERTLEDGER_RUNTIME_TRACE` to a **new JSONL file** whose parent already exists, outside the
witness repository and the evidence output directory. Each record includes its phase, duration,
container and available execution context: probe, world, candidate and attempt. Upload records add
the compressed byte count and whether immutable archive bytes were reused. `runtimeInvocations`
counts operator-runtime processes; an HTTP control operation on the existing stdio connection
records zero.

The trace also records host snapshot and workspace-copy durations. These phases are distinct from
runtime calls; upload duration includes producing and transmitting the archive. Phase totals can
overlap other work and are not a replacement for elapsed wall time.

Trace writes run in a worker with a bounded queue. An unsafe destination, a failed write or a full
queue emits `ASSERTLEDGER_RUNTIME_TRACE_UNSAFE_DESTINATION`,
`ASSERTLEDGER_RUNTIME_TRACE_WRITE_FAILED` or `ASSERTLEDGER_RUNTIME_TRACE_DROPPED` on stderr. These
warnings preserve the execution result. Existing files are never overwritten. Discard an incomplete
trace when comparing performance.

## Select the transport

`check`, `verify` and `import-witness` accept `--container-transport` for container execution:

| Mode | Behavior |
| --- | --- |
| `auto` (default) | Qualify the runtime and pinned image, then try one `system dial-stdio` connection. If qualification of that connection fails before execution, use the CLI transport. |
| `cli` | Invoke the operator's runtime argv for every lifecycle operation. |
| `stdio` | Require the qualified stdio connection; fail with `CONTAINER_STDIO_UNAVAILABLE` if it cannot be established. |

Both optimized modes retain the attached `start` subprocess and its existing output and deadline
controls. Create, upload, inspect, result download and removal use the same daemon over stdio. No
WSL-specific shell, TCP endpoint or Docker Desktop is required. The operator's argv still chooses
the runtime. Once an execution has started, an uncertain control exchange refuses the result;
only killing or removing that owned container may fall back to the CLI for cleanup.

Uploads use gzip archives. After the full preflight, one campaign can retain up to 32 MiB of immutable
compressed archive bytes for identical snapshot/world/candidate/assets. Reuse checks the stored
size and digest; a changed key or corrupt entry regenerates the archive. An oversized archive is
streamed without retention. Assembly can temporarily require another 32 MiB, plus stream buffers.
Every attempt still receives a fresh host workspace and a fresh anonymous container volume.

This reuse stores input bytes, not preflight results. All identity probes, qualification probes,
load controls and requested attempts still run. Execution concurrency remains unchanged.

## Reproduce a comparison

Use a digest-pinned image already present on the same daemon and a witness that verifies with both
producers. Keep the witness repository, runtime argv, image, Node version, execution limits and
background workload fixed. Record ambient load rather than assuming that consecutive runs have
equal conditions. Windows load averages are unavailable; the script also samples CPU activity and
free memory every 30 seconds.

The dependency-free script accepts a built package directory, witness, image, runtime argv,
repetition count and fresh external output directory. Its help is executable:

```sh
node scripts/benchmark-container-runtime.mjs --help
```

Run the script once per producer, using `--repetitions 3`. Supply the baseline's `results.json` with
`--compare` for the second series. `--transport` is optional; omit it for an older CLI. The baseline
must contain the trace-only instrumentation, because uninstrumented 2.0.2 cannot emit phase records.
This instrumentation must preserve the original container execution mechanics.

The [historical trace patch](../benchmarks/container-runtime/2026-10-11/baseline-trace.patch)
reproduces the measured baseline from an extracted `assertledger@2.0.2` tarball. Apply it to that
external built producer and use the benchmark script's external trace sink. The accompanying
[producer identity](../benchmarks/container-runtime/2026-10-11/baseline-producer.json) binds the
tarball and the three instrumented runtime modules; every other JavaScript module is unchanged.
Use `git -c core.autocrlf=false apply PATH_TO_PATCH` in the extracted producer directory to preserve
the recorded module bytes on Windows.

The script snapshots `dist`, `integrations`, `package.json` and resolved `node_modules` before the
timer. It preserves pnpm package locations, relocates dependency links into the snapshot and refuses
links outside that dependency tree. It checks isolated CLI startup, hashes the files and links,
records Node and dependency identities, and verifies the snapshot again after the series. Each serial run
uses a fresh trace and evidence directory, imports the witness, then replays the resulting manifest.
Wall time covers the import, including trace setup and flushing; replay is outside the timer.

Every run must return `VERIFIED` and replay `valid: true`. Semantic comparison preserves the full
manifest, including outcomes, attribution, discovery counts, expected failure text, repository
facts and execution limits. It excludes only top-level `artifactDigest`/`decisionDigest` and each
observation's `durationMs`/`stdoutDigest`/`stderrDigest`. These are execution-varying fields, not a
changed digest projection in AssertLedger. Raw manifests, traces, stdout, stderr and load samples
remain in the output directory. A refused import, invalid replay, changed semantic field or
incomplete trace stops the series instead of silently retrying.

## Reference witness measurements

Measured on Windows 11 with Docker Engine in WSL Ubuntu, runtime argv
`["wsl.exe","-d","Ubuntu","--exec","docker"]`, and
`oven/bun@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895`.
The witness has three attempts and an explicit null neutral control. Its SHA-256 is
`6c84a9135649990f751251e356e202fd3fa92efdd1fe3546282d7bc7ca47e1f9`.

| Series | Run 1 | Run 2 | Run 3 | Median | Min–max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline: trace only, original transport | 500.207 s | 419.722 s | 408.214 s | 419.722 s | 408.214–500.207 s |
| Final: gzip + stdio + immutable archive reuse | 134.180 s | 127.971 s | 130.577 s | 130.577 s | 127.971–134.180 s |

The measured median is **3.214× faster**, a **68.9% reduction**. Heavy background work was stopped
before all six accepted runs. Runtime, image, repository, witness, attempts and deadlines remained
fixed; ambient CPU samples are retained rather than assuming perfectly identical machine load.
The [measurement data](../benchmarks/container-runtime/2026-10-11/measurements.json) includes every
run, producer fingerprints, phase totals, load samples, artifact identities and comparison rules.
Six compressed JSONL traces beside that file preserve the individual calls. Their compressed
manifests and replay outputs retain the exact captured bytes; decompress a manifest and run
`assertledger replay PATH_TO_MANIFEST --json` to check it independently.

CPU samples span 49.6–69.2% before and 52.9–68.8% after. The minimum remaining attached-start
budget is 28.372 s before and 28.252 s after, including the shorter identity/probe budgets. No
deadline was raised. The median phase totals below cover an entire witness; independently computed
phase medians need not sum to the median wall time.

| Phase | Calls | Before | After |
| --- | ---: | ---: | ---: |
| Runtime version | 1 | 0.596 s | 0.574 s |
| Daemon info | 1 | 0.536 s | 0.761 s |
| Image inspection | 1 | 0.610 s | 0.482 s |
| Stdio qualification | 1 after | — | 0.708 s |
| Create | 36 | 28.981 s | 1.970 s |
| Upload, including archive generation | 36 | 228.882 s | 31.744 s |
| Attached start | 36 | 29.110 s | 28.005 s |
| State inspection | 36 | 22.462 s | 0.066 s |
| Result download | 34 | 22.728 s | 0.304 s |
| Remove with volumes | 36 | 28.288 s | 4.964 s |
| Host snapshot | 1 | 2.976 s | 2.120 s |
| Fresh host workspace copy | 18 | 41.600 s | 42.844 s |
| Stdio close | 1 after | — | 0.006 s |

Every accepted run created 36 containers and returned `VERIFIED`, with a valid
replay. The containers comprise two Bun identity probes, 16 designated preflight probes, nine world
load controls and nine designated test executions. There were 217 logical runtime calls. The stdio
producer reduced physical runtime launches from 217 to 40: three backend checks, one control connection
and 36 attached starts. Eighteen uploads contain the repository workspace; small probe uploads are
additional.

Baseline upload totals were 683,834,368 bytes per run; the final producer uploaded 196,445,293
compressed bytes. It still transfers an archive to every fresh container. Sixteen of the eighteen
repository uploads reuse immutable bytes; two distinct input plans are assembled. No preflight-result
cache or execution concurrency was introduced. All twenty-one exploratory and accepted manifests
have identical semantic fields, with eighteen observations each, and replay `valid: true`.

Exploration is retained losslessly in `historical-measurements.json.gz`, with summaries in the data.
The initial baseline was 548.765/394.230/413.646 s;
the gzip + stdio pilot was 338.070/322.213/319.321 s. Its upload median remained 227.924 s, so the
archive-production cost motivated input-byte reuse. An initial final-producer series then took
1171.072/348.450/124.746 s while heavy work stopped midway; it is excluded from the accepted timing
comparison. A later trace-only comparison measured 439.125/440.098/398.508 s before and
136.797/131.565/122.806 s after. These older runs did not freeze or fingerprint dependencies and
record Node, so the accepted comparison above was repeated using the complete producer snapshot.
An initial dependency-copy attempt failed isolated CLI loading before creating any container;
its output was retained and excluded from timing. Copying pnpm packages by dereferencing their
links had changed Node's transitive dependency resolution; the snapshot now preserves those locations.

The public script passed syntax, format, lint and help checks, plus two synthetic two-run series
with valid replay and semantic comparison. Its smoke also rejected existing output, output inside
the repository and changed discovery counts. All six accepted measurements used the exact executor
retained in `rigorous-benchmark-executor.mjs.gz`. Its fingerprint and the complete dependency/Node
identities are in the data. The public script adds a guard against output inside dependencies;
dependency copying and isolated startup happen outside the timer. Both frozen producer trees and
the witness passed their final integrity checks.
