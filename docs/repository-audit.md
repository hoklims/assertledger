# Repository audit

`assertledger audit` inventories a repository without executing tests, adapters, candidates, or
campaigns. Its output is descriptive: it contains no score, note, quality label, coverage claim, or
verification verdict.

Current output uses [audit v2](repository-audit-v2-migration.md), which preserves the factual
measurements and adds `appliedExcludes: { source, entries }`. With a verification request, its
exclusions plus defaults filter the inventory; configuration adds no
exclusions. Without a request, audit uses a valid initialization configuration, otherwise defaults.
Both inventories reuse the same exclusion snapshot. Historical v1 artifacts remain readable with
the unchanged v1 parser and schema.

In a Git worktree, audit selects tracked files and non-ignored untracked files using
`git -c core.precomposeUnicode=false ls-files --cached --others --exclude-standard -z`,
then applies the exclusions above. Disabling Git's macOS name precomposition for this listing
preserves disk spellings: admitted non-NFC names retain the existing portable-path refusal rather
than being silently omitted. Ignore patterns are evaluated against these literal spellings.
Git's nested `.gitignore`, `.git/info/exclude`, and global ignore rules apply to untracked files;
tracked files remain included even if an ignore rule matches them. Audit reads current disk bytes,
including staged and unstaged edits, and omits deleted files. It does not recurse into submodules.
Included symlinks, including directory links, still refuse the inventory. Filenames retain their
spelling and must satisfy the existing portable-path rules.

Outside a Git worktree, when Git is unavailable, or with `--no-git`, audit retains the disk inventory;
ignore rules do not apply. Once a Git inventory is selected, a failed index listing refuses with
`GIT_INDEX_UNAVAILABLE` instead of silently widening the inventory. Both inventories requery Git.

An ignored local index cache such as `.semctx/semctx.db` can be created, rebuilt, or removed without
changing the Git audit's `repositoryDigest`, `fileCount`, or byte-based cost estimate. For comparable
proof epochs, preserve the working-tree content, ignore rules, and explicit exclusions: an audit
digest is not solely a commit identifier. Campaign copying and manifest digest projections remain
unchanged and can still include ignored caches unless explicitly excluded in the request; audit
costs describe its own inventory rather than the campaign's complete disk copy.

```sh
assertledger audit . --json
assertledger audit . --verification-request request.json --json
assertledger audit . --emit-verification-request --no-git | assertledger verify - --allow-unsafe-execution
```

The command discovers `assertledger.request.json` at the audited root unless
`--verification-request` is supplied. A request is emitted only after v1 validation and exact
repository-root binding. Emitted requests always have
`acknowledgedUnsafeExecution: false`; the receiving `verify` command owns the explicit unsafe
authorization. Exit code `3` means no request was available for `--emit-verification-request`, and
exit code `4` means the supplied or discovered request was invalid.

## Signals and limits

JavaScript and TypeScript files use the TypeScript lexical scanner. Decision points count `if`,
loop, `catch`, `case`, conditional, `&&`, `||`, and `??` tokens. Declared exports and test-root
identifier occurrences produce `noObservedTestReference`; this name deliberately does not claim
coverage. Test association is conservative: source and `.test`/`.spec` files must share a basename.
Weak assertion shapes are syntactic occurrences of truthiness-only, constant-boolean equality,
definedness-only (`toBeDefined`), type-only (`typeof` asserted against a type name), and
non-throw-only forms. Unsupported languages report `supported: false` and nullable measurements.

Git history is optional. The 90-day window is anchored to the commit timestamp of `HEAD`, never the
wall clock, and is capped at 1,000 commits. Correction commits are messages containing the explicit
words `fix`, `bug`, `repair`, `hotfix`, or `regression` (case-insensitive). Missing, shallow, failed,
or truncated history is represented by nulls and reason codes, not invented zeroes.

Modules use `PATH_PREFIX_V1` (the first two path segments when available). Their contiguous order is
the descending factual tuple: decision points, exports with no observed test reference, correction
commits, commits in the window, sources newer than associated tests, weak assertion occurrences;
the POSIX path prefix breaks ties. The tuple is not a score.

Campaign bounds use decimal BigInt strings. For candidates `C`, worlds `W`, attempts `A`, repository
bytes `R`, total world-overlay bytes `OW`, total candidate bytes `OC`, timeout `T`, and output limit
`O`:

- executions = `(C + 1) * W * A`
- controls = `W * A`; candidate executions = `C * W * A`
- overlay bytes = `A * ((C + 1) * OW + W * OC)`
- materialization bytes = `R * (executions + 1) + overlay bytes`
- timeout limit = `executions * T`
- captured stream limit = `executions * O * 2`

Two complete inventories bind the audit. A digest change aborts with
`REPOSITORY_CHANGED_DURING_AUDIT`.
