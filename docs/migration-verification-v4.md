# Verification v4: designated Bun tests, closure-scoped links and declared isolation

Verification request and evidence manifest v4 add three things a v3 campaign cannot express. V1 to
v3 schema bytes, parsers, adapters and historical manifests are unchanged and replayable; every
refusal they apply still applies to them.

## Existing Bun tests, run by name

The `bun-test-designated` adapter verifies an existing `bun:test` test instead of a new candidate
file. A candidate names the test and, optionally, the first line of the failure it must produce:

```json
{
  "id": "gate-routing",
  "test": { "file": "tools/gates.test.ts", "path": ["gate routing", "keeps docs"] },
  "expectedFailure": "error: expect(received).toContain(expected)"
}
```

`path` is the describe path ending with the test name. The adapter is declared as
`{ "kind": "bun-test-designated", "executable": "bun", "testTimeoutMs": null }`; `testTimeoutMs`
sets Bun's per-test timeout (`bun test --timeout`) and must be shorter than
`timeoutMsPerExecution`. `null` keeps Bun's default of 5 seconds.

Each run executes only that test, selected by an anchored, escaped `--test-name-pattern`. The
taxonomy is the one every adapter applies:

- red is only an assertion failure attributed to the designated test: a failure thrown inside it by
  a `bun:test` built-in matcher, in Bun's matcher message form, or by `assertSame`; with an expected
  line, its first message line must be equal to it;
- a timeout is never red, including a test that Bun timed out and whose callback threw a matcher
  failure afterwards; nor is a crash, a hook failure, a collection or compile error, a custom matcher,
  a matcher usage error, a forged message, or a test that is not found (`NO_TEST_DISCOVERED`);
- repeated runs that diverge make the candidate `UNSTABLE`.

Controls load every designated file without running a test. They show that each world evaluates the
file and its imports and still registers the designated test exactly once. The designated test file
must not be rewritten by any world (`DESIGNATED_TEST_OVERLAID`).

Every campaign first runs the designated preflight: fixed probes, including a synchronous test that
overruns its timeout and then fails a matcher, must each produce their expected outcome, or the
campaign stops.

## Repository links judged against the executed tests

A v4 campaign collects the repository's links instead of refusing the first one. A link that leaves
the repository root (`REPOSITORY_LINK_ESCAPES_ROOT`) or lies on the module closure of a test the
adapter executes (`REPOSITORY_LINK_IN_TEST_CLOSURE`) refuses the campaign, and the error names its
path. When a test's imports are computed or absolute, the closure is unbounded and any link refuses
the campaign (`TEST_CLOSURE_UNBOUNDED`). The others are left out of the snapshot and listed, sorted,
in `evidenceContext.repository.omittedLinks`, which the decision digest covers.

The closure follows literal `import`, `export … from`, `import()`, `require()` and `mock.module()`
specifiers, `tsconfig`/`jsconfig` paths, workspace packages, including their installed
`node_modules` entry, declared dependencies of installed packages, and `bunfig.toml` test preloads.
It does not cover files a test reads at run time; that limitation is recorded in the manifest.

`doctor` applies the same rule to the tests the framework would discover, and reports the closure
as non-blocking when it is unbounded. A link through which a runner could discover a test, named as
a test itself or a directory holding one, is in the closure. `analyze`, `audit` and v1 to v3
campaigns still refuse any link.

## Snapshot options

`repository.includeDependencies` keeps `node_modules` in the snapshot and its digest as found;
AssertLedger neither installs nor verifies it. `repository.git` is `excluded`, the snapshot without
Git metadata, or `synthesized`: the snapshot is committed once into a fresh repository with a fixed
identity and date and no hooks, template or global configuration, honoring its own `.gitignore`.
The tree identity and Git version are recorded in `evidenceContext.repository.git`. The source
repository's own `.git` and history never enter the snapshot.

## Declared isolation

`isolation` is one of:

- `container`: a fresh container per execution from a digest-pinned local image, through the
  operator's runtime argv, for example the native WSL2 engine
  `["wsl.exe","-d","Ubuntu","--exec","docker"]`. The designated adapter runs there; `bun-test`
  with candidate files is still refused in a container (`BUN_TEST_CONTAINER_UNSUPPORTED`).
- `trusted-local`: unsandboxed, level `UNSANDBOXED`.
- `windows-native`: unsandboxed on a Windows host for tests that only run natively there, level
  `WINDOWS_NATIVE_UNSANDBOXED`. It is never implied: the request declares the kind, the operator
  acknowledges it (`--allow-windows-native-execution`), and it is refused on any other host
  (`WINDOWS_NATIVE_HOST_REQUIRED`).

The level is in `isolation.level` of every manifest and in every witness summary, and the decision
digest binds it.

## Compatibility

`verify` and the SDK's `verifyV4` accept v4 requests; `replay` accepts v1 to v4 manifests. The v4
request, v4 manifest and witness import request schemas are added to the post-conformance schema
lock; the frozen v1 bundle and its root digest are unchanged. To replay a recorded red/green
witness, see [witness import](witness-import.md).
