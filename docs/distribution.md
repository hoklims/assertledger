# Verify the installed package

Run `pnpm run smoke:package` from a checkout with its locked dependencies installed.
The command builds once, checks the schemas and conformance bundle, packs the distribution and
installs that tarball into a fresh temporary npm consumer whose path contains spaces.
Consumer dependencies are fetched from the public npm registry; lifecycle scripts
and the operator's npm configuration are disabled.

The smoke exercises both installed command aliases (`assertledger`, `testforge`),
both SDK class aliases, the public root and core exports, static init and audit,
and the bundled trusted `node:test` example. The strong test must be selected,
the weak test must be rejected as `WEAK_ORACLE`, and every replay rail must pass.
It also checks the advertised schemas, conformance bundle, integration skill and
runtime files in the tarball and installed package.
It also compiles a TypeScript consumer against the installed root/core exports
using the checkout's pinned compiler and Node type definitions. Consumer imports
resolve from the temporary project; no source-package alias is configured.
Runtime module resolution is confined to that consumer, so a dependency installed
elsewhere on the developer's machine cannot hide an incomplete package manifest.
The existing pinned TypeScript scanner is a production dependency of static repository analysis.

Three fault witnesses remove a runtime file and break runtime and TypeScript
exports. Each must fail for the expected module or type error, then pass after byte-exact
restoration in a fresh process. Raw command results, witnesses, manifest, replay,
the tarball and its SHA-256 are retained under `.testforge/package-smoke/<run-id>`.
Temporary consumers are removed after the run. The retained manifest is replayable;
its original execution paths refer to the removed consumer.

CI runs this smoke on Windows and Linux with Node 22.15.0 and 24 alongside `pnpm check`.
A successful local smoke proves that local tarball on the reported Node version
and operating system. It does not establish npm publication, cross-platform CI
success, hostile-code isolation, or adoption by external users. The example uses
explicitly unsandboxed trusted-local execution.

The installed `check` journey also evaluates a
[real historical correction projected into a node:test fixture](../examples/git-history/README.md).
It requires `VERIFIED` for the strong candidate, `REJECTED` for weak and generic-crash candidates,
two correct target observations each, valid replay, and unchanged source bytes, index and HEAD.
Each case retains its request, manifest and human summary. The upstream source snapshots,
license, commit IDs, Git blob IDs and SHA-256 hashes are bundled and checked before use.
