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
