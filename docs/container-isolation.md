# Container isolation

[Back to the reference](reference.md) · [Security policy](../SECURITY.md)

Verification request v2 adds a `container` isolation backend. Every control and candidate
execution then runs in a fresh Linux container created from a digest-pinned image that is already
present on an operator-administered Docker-compatible daemon. `trusted-local` stays available in v1
and v2, remains explicitly `UNSANDBOXED`, and still requires external authorization.

Container isolation is a containment layer around an execution, not a proof that a campaign is
correct. The daemon, its host kernel, the image and the AssertLedger engine remain trusted.

## Select the backend

The Git workflow selects the backend explicitly. Without `--container-image` or
`--allow-unsafe-execution`, `check` stops before reading the repository and names both options:

```sh
assertledger check . --before BEFORE --after AFTER --neutral NEUTRAL --neutral-reason "explicit control reason" --test tests/regression.test.js --base-test tests/base.test.js --out .assertledger/evidence --container-image node@sha256:DIGEST
```

`verify` runs a v2 request whose `isolation.kind` is `container` without
`--allow-unsafe-execution`:

```json
{
  "schemaVersion": "2.0.0",
  "isolation": {
    "kind": "container",
    "image": "node@sha256:DIGEST",
    "environment": [{ "name": "TZ", "value": "UTC" }],
    "limits": {
      "memoryBytes": 1073741824,
      "cpuMillicores": 2000,
      "pids": 256,
      "temporaryDirectoryBytes": 67108864
    }
  }
}
```

The other request fields keep their v1 meaning; `assertledger schema verification-request-v2 --json`
prints the complete contract. `check` uses the limits shown above and a 30-second timeout per
execution.

Combining a container image or request with `--allow-unsafe-execution` fails with
`ISOLATION_MODE_CONFLICT` before any runtime call. Combining `--container-runtime` with a
trusted-local request fails the same way.

The runtime command belongs to the operator, never to the request. It defaults to `["docker"]` and
is passed as a JSON argument array; it is never interpreted by a shell:

```sh
assertledger verify request.json --container-runtime '["docker"]' --json
```

On Windows with Docker Engine inside WSL, use
`--container-runtime '["wsl.exe","-d","Ubuntu","--exec","docker"]'` from a POSIX shell. Shells that
strip inner double quotes from native arguments, such as Windows PowerShell 5.1, need escaped
quotes. The SDK takes the same values through its v2 entry points, which return v2 manifests:

```js
const ledger = new AssertLedger();
await ledger.verifyV2(request, { containerRuntime: { command: ["docker"] } });
await ledger.checkGitRegressionV2({ ...options, container: { image: "node@sha256:DIGEST" } });
```

`verify()` and `checkGitRegression()` keep their v1 contracts and result types.

The MCP `check` and `verify` tools still execute only trusted-local v1 requests.

## Backend checks before execution

AssertLedger queries the runtime before creating a workspace container. Each refusal happens before
any repository code runs and has an [`explain`](diagnostics.md) entry:

| Reason code | Meaning |
| --- | --- |
| `CONTAINER_RUNTIME_COMMAND_INVALID` | The runtime argv is not a JSON array of 1 to 16 non-empty strings. |
| `CONTAINER_RUNTIME_NOT_FOUND` | The runtime executable cannot be started. |
| `CONTAINER_RUNTIME_UNAVAILABLE` | The runtime reports no reachable daemon. |
| `CONTAINER_RUNTIME_PLATFORM_UNSUPPORTED` | The daemon does not run Linux containers. |
| `CONTAINER_IMAGE_REFERENCE_INVALID` | The `check` image is not pinned by `@sha256:`; a v2 request with such an image fails request validation. |
| `CONTAINER_IMAGE_NOT_PRESENT` | The pinned image is absent locally. AssertLedger never pulls. |
| `CONTAINER_IMAGE_DIGEST_MISMATCH` | The local image does not carry the pinned digest. |
| `CONTAINER_IMAGE_PLATFORM_UNSUPPORTED` | The image is not a Linux image. |
| `CONTAINER_CLEANUP_FAILED` | A finished container could not be removed; no result is produced. |

Review an image, then pull it yourself by the same digest, for example
`docker pull node@sha256:DIGEST`. For `node:test`, the engine also probes `node` inside the image
twice and records its path, version and SHA-256 digest, as it does locally.

## Controls applied to every execution

| Boundary | Control |
| --- | --- |
| Files | No host path is mounted. The prepared workspace is streamed as an archive into an anonymous volume; the root file system is read-only; `/tmp` is a `tmpfs` bounded by `temporaryDirectoryBytes`. |
| Result | Only a regular file named `result.json`, no larger than the report bound, is read back as an archive in memory. A link, a renamed entry or a malformed archive yields `INFRA_ERROR`. |
| Identity | User and group `65534`, all capabilities dropped, `no-new-privileges`. |
| Network | `--network=none`: only the loopback interface exists. |
| Environment | The image's own variables, the variables the runtime sets itself such as `HOSTNAME` and `HOME`, the declared `environment` entries and the adapter protocol variables. The host environment is never forwarded. |
| Resources | `pids`, `memoryBytes` with swap disabled, and `cpuMillicores` limits. |
| Time | On timeout the container is killed, which ends every process in its PID namespace, including detached descendants. |
| Output | Standard output and error are bounded by `maximumOutputBytes`; the runtime log driver is disabled. |
| Lifetime | One container per execution, labeled `assertledger.execution`, removed with its volume afterwards. |

A timeout is recorded as `TIMEOUT`. A process stopped by the memory or process limit exits without a
valid report and is recorded as an infrastructure or process failure. Neither can count as target
detection: only an attributed `ASSERTION_FAILURE` kills a target.

## Evidence

A v2 manifest binds the backend facts to the decision digest in
`evidenceContext.execution.backend`: image reference, identifier, OS and architecture; runtime
client and server versions, server OS and architecture, cgroup version and reported security
options; and the controls, declared environment and limits above. The top-level
`isolation` summary records `kind: "container"`, `level: "CONTAINER"` and the runtime argv; it is
covered by the artifact digest. The manifest's `limitations` state the main limits of this backend.

Declared environment values are recorded verbatim. Never place a secret in `isolation.environment`.

Replay validates v1 and v2 manifests. Evidence export, Agentic Test Profiles and benchmarks still
accept only v1 manifests. The v1 request and manifest contracts are unchanged.

## Limits and non-claims

- Containers share the daemon host's kernel; this is not a virtual machine boundary.
- Access to the Docker daemon is equivalent to administrative access on its host. Run it on a host
  without secrets, as you would a CI runner.
- AssertLedger does not bound the writable workspace volume. Storage quotas remain an
  operator-administered daemon setting.
- `/dev/shm` keeps the runtime default size (64 MiB on Docker Engine), charged to the memory limit.
- The image and declared environment values are operator inputs. AssertLedger verifies the image
  digest, not its contents. With no network, the image must already contain every runtime the
  adapter needs.
- An interrupted AssertLedger process can leave a labeled container. Remove it with
  `docker ps --all --filter label=assertledger.execution` followed by `docker rm --force --volumes`.
- Only Linux daemons are supported. The host side is platform-neutral Node.js; the hostile
  scenario suite runs against real Docker Engine on Linux in CI and was run locally against Docker
  Engine in WSL on Windows. macOS hosts are not exercised.

## Real-daemon test suite

`tests/container-isolation-docker.test.ts` runs hostile scenarios against a real daemon: network
egress, root file system writes, host paths, environment leakage, privileges, temporary storage
and process count, a detached descendant after timeout, a result link, a memory limit, an absent
image and an end-to-end `check`. It is skipped unless both variables below are set, and
`ASSERTLEDGER_REQUIRE_CONTAINER_TESTS=1` turns a missing configuration into a failure:

```sh
ASSERTLEDGER_CONTAINER_RUNTIME='["docker"]' ASSERTLEDGER_CONTAINER_IMAGE='node@sha256:DIGEST' pnpm test
```

The suite never pulls; provide the image first.
