# Repository audit v1

`assertledger audit` inventories a repository without executing tests, adapters, candidates, or
campaigns. Its output is descriptive: it contains no score, note, quality label, coverage claim, or
verification verdict.

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
