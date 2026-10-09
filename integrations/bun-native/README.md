# Native Bun collection profile 1.0.0

This profile is separate from the frozen helper-only Bun adapter. It requires
Bun 1.4.2, revision 744846f844374847c902b5e7fd59b4342a51ef99.
The outer Node process runs the driver with argument arrays and a bounded process
tree; the driver loads the signed-pipe preload and checks complete JUnit evidence.

The qualified forms are TypeScript tests importing `bun:test`, `test`, `it`,
`describe`, async functions, helper-module imports, `test.each`, native `expect`
matchers and `not`/`resolves`/`rejects` chains. The qualified matcher names are
`toBe`, `toEqual`, `toStrictEqual`, `toHaveProperty`, and `toThrow`; each has
executable reference, target and neutral witnesses. Comparison operands and
arguments must be primitive values or recursively passive plain objects/arrays:
accessors, functions, proxies, custom prototypes and custom coercions are refused
before matcher issuance. `toHaveProperty` accepts a simple dotted identifier path
and an optional passive expected value. `toThrow` accepts a function and an optional
string expectation, or a rejected native Promise with a plain Error. Callback
errors are tracked separately from errors issued by the native matcher; active
returned/thrown values invalidate collection. All other matcher names, asymmetric
matchers and static expect helpers are explicitly unqualified.
A matcher failure is attributed through the issuing test's
async-local identity and an error WeakMap. Test errors are never classified from
their message or JUnit failure text. Cross-test rethrows, hooks, collection errors,
timeouts, skipped or missing tests, unmatched events and report inconsistency
cannot establish a detection. Rejected inputs under `resolves`, TypeError and
RangeError remain operational failures. Custom matchers (`expect.extend`) are
explicitly unqualified.

Both the outer process timeout and Bun's per-test timeout are operational failures.
JUnit `TimeoutError` observations invalidate collection even when a synchronous
callback finishes before the outer budget and throws an owned matcher error after
its per-test deadline. This observation matches the existing v4 Bun driver's
timeout handling; its private JUnit parser is not imported as a new dependency.

The Node compatibility forms `node:test` default/named registrations with callback
contexts (`t.after`), generated parameterized registrations, helper imports and
`node:assert/strict` `ok`, `equal` and `strictEqual` assertions are qualified under
the pinned Bun revision, with reference/target/neutral witnesses for each name.
Their operands and optional message must be passive. All other assertion names,
including callback-bearing `throws` and `rejects`, are explicitly unqualified.
Native Node AssertionError is attributed only when issued by the wrapped assertion
function in the current test. Manually constructed errors and failing after hooks
remain operational failures.
Snapshots, mocks, global-only registrations, callback-style completion, browser
tests, and other runtime versions need additional qualification witnesses.
Successful collection is an observation, not a campaign admission or readiness
claim.

Every declared test file must start at least one test; an empty or missing file
beside an otherwise passing suite invalidates collection. Successful facts include
the sorted relative paths of files that actually started tests (`testFiles`).
The collector exposes binary, driver and preload identities. The consuming
campaign must bind test/helper/configuration input digests and all world identities.
The pipe MAC detects accidental or unsophisticated report substitution; this is
trusted-local, unsandboxed execution. It is not an OS boundary or an authentication
of a hostile producer. Candidates can execute arbitrary code in that process.
Replay does not reexecute the tests or authenticate their producer.
