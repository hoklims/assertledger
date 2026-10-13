# Verification v5: designated Bun tests in their package, with installed links

Verification request and evidence manifest v5, and witness import request v2, let a designated
`bun:test` campaign run the way a pnpm or Bun workspace runs its own tests: in the test's package,
with that package's `bunfig.toml`, through the links an isolated install creates. V1 to v4 schema
bytes, parsers and historical manifests are unchanged and replayable.

## Request

A v5 request is a [v4 request](migration-verification-v4.md) with `schemaVersion: "5.0.0"` and two
groups of new fields. Under `repository`:

- `snapshot`: `repository` copies every file, as v4 does; `test-closure` copies only the static
  module closure of the designated tests, the package, TypeScript and Bun configurations on their
  paths, and the `include` paths;
- `include`: repository-relative files or directories added to a `test-closure` snapshot, for files
  a test reads at run time. It must be empty with `snapshot: "repository"`
  (`REPOSITORY_INCLUDE_REQUIRES_TEST_CLOSURE`), and each entry must exist
  (`REPOSITORY_INCLUDE_MISSING`).

Under the `bun-test-designated` adapter:

- `workingDirectory`: `repository-root`, as v4, or `test-package`: Bun runs in the nearest directory
  above the designated test that holds a `package.json`. Every designated test of a campaign must
  belong to the same package (`DESIGNATED_WORKING_DIRECTORY_MIXED`);
- `isolate`: runs `bun test --isolate`. A control that loads several files then runs one Bun
  process per file;
- `trustedMatchers`: custom matchers the operator declares trusted, as
  `{ "path": "<repository path>", "matchers": ["<name>", …] }`.

A witness import request v2 carries the same `repository` and `adapter` fields and is replayed as a
v5 campaign; see [witness import](witness-import.md).

## Repository links

Explicit `include` directories retain their empty descendants in both the snapshot and execution
workspaces. The v5 repository digest adds a `D\0path\0` entry for each retained empty leaf directory
to the existing sorted file/link sequence. Snapshots without retained empty directories keep the
previous digest projection byte for byte; historical manifests remain replayable. Adding or removing
a retained empty directory changes the repository digest even when no file bytes change.

Package `imports` aliases are resolved in the nearest package scope, including wildcard targets
and all conditional branches conservatively. External, recursive, missing or unsupported alias
targets refuse preparation with `TEST_CLOSURE_PACKAGE_IMPORT_UNSUPPORTED`, rather than silently
omitting runtime code. Extended compiler configurations and implicit JSX dependencies are retained
even in repositories with no links.

A v5 campaign reproduces the links that resolve inside the repository with their relative targets,
and binds each link and its target in the repository digest: every such link for a `repository`
snapshot, those the closure reaches for a `test-closure` snapshot. The closure follows those links,
and also keeps the configuration a `tsconfig` extends and the automatic JSX runtime a `.tsx` or
`.jsx` file imports. A link that leaves the root, dangles or reaches an excluded path still refuses
the campaign when the closure reaches it (`REPOSITORY_LINK_ESCAPES_ROOT`,
`REPOSITORY_LINK_IN_TEST_CLOSURE`); one outside the closure is left out and recorded, at most
10,000 (`REPOSITORY_LINK_LIMIT_EXCEEDED`). When the links found after the copy differ from the
planned ones, the repository changed during the campaign (`REPOSITORY_SNAPSHOT_LINKS_CHANGED`).

`evidenceContext.repository` records `snapshot`, `include`, `preservedLinkCount` and the closure
edges it could not follow statically (`unboundedClosureEdges`). A test-closure snapshot holds no
file read at run time outside the closure and the include paths; the manifest states this limit.

Node on Windows cannot read the links that WSL or a Linux container creates. Run AssertLedger from
Linux or WSL for a checkout installed there.

## Bun configuration and preload order

Bun runs every designated test with a generated configuration: the working directory's
`bunfig.toml`, rewritten so that AssertLedger's preload runs before every repository preload. The
generated file is passed with `--config` and replaces the `--preload` argument of earlier campaigns.
`[test] preload` must be one string or one array of string literals; a configuration AssertLedger
cannot rewrite refuses the campaign (`BUNFIG_TEST_PRELOAD_UNSUPPORTED`). This also applies to v4
designated campaigns, which run at the repository root.

Running first, the preload records the identity of each built-in matcher. A matcher that
`expect.extend` installs or replaces, before or during the test, is not a built-in matcher, so its
failure is never an assertion unless the operator declares it trusted.

## Trusted matchers

A declared matcher is trusted only when a module at or below its declared `path` installs it with
`expect.extend` under a declared name. The identity installed is recorded: a later extension under
the same name, from anywhere, is no longer trusted. A failure of a trusted matcher, including a
usage error reported in the matcher message form, counts as an assertion. Each path must exist in
the snapshot (`TRUSTED_MATCHER_PATH_MISSING`); for an installed package, name the directory the
`expect.extend` call resolves to, for example
`node_modules/.pnpm/<package>@<version>/node_modules/<package>`. The declaration is part of the
request and of the decision digest.

Bun derives a custom matcher's first message line from its parameters after the received value,
for example `expect(received).toHaveTextContent(checkWith, options = { normalizeWhitespace: !0 })`
for jest-dom 7.0.1. Record the expected line from an observed red run.

## Preflight

The designated preflight adds probes for each new rule: a built-in replaced inside the test and in a
preload, a custom matcher installed by a preload, a declared trusted matcher, another name from the
same source, and an isolated load and run. Each must produce its expected outcome, or the campaign
stops before any world runs.

## Not covered

Tests written for `node:test` and run by Bun, and oracles that are shell commands, are not
designated Bun tests. The 1,000 base-test limit of the other adapters is unchanged.
