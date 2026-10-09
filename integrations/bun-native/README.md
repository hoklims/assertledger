# Native Bun collection profile 1.0.0

This profile is separate from the frozen helper-only Bun adapter. It requires
Bun 1.4.2, revision 744846f844374847c902b5e7fd59b4342a51ef99.
The outer Node process runs the driver with argument arrays and a bounded process
tree; the driver loads the signed-pipe preload and checks complete JUnit evidence.

The qualified forms are TypeScript tests importing `bun:test`, `test`, `it`,
`describe`, async functions, helper-module imports, `test.each`, native `expect`
matchers and `not`/`resolves`/`rejects` chains. The executable witnesses exercise
`toBe` and `toThrow`. A matcher failure is attributed through the issuing test's
async-local identity and an error WeakMap. Test errors are never classified from
their message or JUnit failure text. Cross-test rethrows, hooks, collection errors,
timeouts, skipped or missing tests, unmatched events and report inconsistency
cannot establish a detection. Rejected inputs under `resolves`, TypeError and
RangeError remain operational failures. Custom matchers (`expect.extend`) are
explicitly unqualified.

The Node compatibility forms `node:test` default/named registrations with callback
contexts (`t.after`), generated parameterized registrations, helper imports and
`node:assert/strict` equal assertions are qualified under the pinned Bun revision.
Native Node AssertionError is attributed only when issued by the wrapped assertion
function in the current test. Manually constructed errors and failing after hooks
remain operational failures.
Snapshots, mocks, global-only registrations, callback-style completion, browser
tests, and other runtime versions need additional qualification witnesses.
Successful collection is an observation, not a campaign admission or readiness
claim.

The collector exposes binary, driver and preload identities. The consuming
campaign must bind test/helper/configuration input digests and all world identities.
The pipe MAC detects accidental or unsophisticated report substitution; this is
trusted-local, unsandboxed execution. It is not an OS boundary or an authentication
of a hostile producer. Candidates can execute arbitrary code in that process.
Replay does not reexecute the tests or authenticate their producer.
