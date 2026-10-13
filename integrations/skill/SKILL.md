---
name: assertledger
description: Analyze a repository, submit candidate tests, and accept only deterministic AssertLedger evidence.
metadata:
  version: "1.1.0"
---

# AssertLedger skill

Use this skill when an agent is asked to generate tests whose actual evidence must be checked.

AssertLedger was formerly named TestForge. The `assertledger` CLI is the preferred binary; the
`testforge` binary remains a legacy-compatible alias for the same commands during the compatibility
window.

## Preferred path: a committed regression

1. Run `assertledger doctor <repo> --json` for static readiness. Runtime probes require the separate
   `doctor --runtime --allow-unsafe-execution` command and prior operator authorization. Doctor
   judges each repository link against the module closure of the tests that would run: a link
   outside every closure is reported as `REPOSITORY_LINK_OUTSIDE_TEST_CLOSURE`, while a link in a
   closure (`REPOSITORY_LINK_IN_TEST_CLOSURE`) or leaving the repository
   (`REPOSITORY_LINK_ESCAPES_ROOT`) stays a `CONFLICT` that names the path. A refusal is never
   yours to work around: only the operator may replace the link or declare the local-only entry that
   holds it with `--exclude NAME`. Never add names to `repository.exclude` yourself; the configured
   list never removes files from campaign evidence.
2. Ask the operator or harness for the buggy, corrected and neutral revisions, the neutral reason,
   candidate path and unchanged base tests. Do not invent a neutral control's meaning.
3. For committed dependency-free JavaScript `node:test`, use `assertledger check` or the MCP
   `assertledger_check` tool. The server operator must enable execution; a tool payload cannot grant it.
4. Preserve the manifest and run `assertledger replay`. Use `assertledger explain CODE` or the
   read-only `assertledger_explain` tool to understand a refusal without changing the policy.
5. The configuration, skill and server do not grant trust. Never treat a crash, timeout, compilation
   error or missing test as detection. The returned limitations remain part of the result.

## Replaying a recorded red/green witness

1. When the operator supplies a witness (mutated target files with their base digests, one existing
   designated test named by file and describe path, and its expected first failure line), write it
   as a `witness-import-request.v1.json` document; do not change the targets, test or line.
2. The operator chooses the backend; a witness never does. Run
   `assertledger import-witness <witness.json> --out <new-directory> --json` with exactly one of
   `--container-image NAME@sha256:DIGEST [--container-runtime JSON_ARGV]`,
   `--allow-unsafe-execution` or `--allow-windows-native-execution`, as authorized. The resulting
   isolation level, `CONTAINER`, `UNSANDBOXED` or `WINDOWS_NATIVE_UNSANDBOXED`, is part of the
   result and must be reported with it.
3. Only an assertion failure attributed to the designated test counts as red. A timeout, crash,
   collection or compile error, or a test that is not found is never red, and diverging repeated runs
   make the candidate `UNSTABLE`. Accept the witness only on `VERIFIED` plus `assertledger replay` with
   `valid: true`.

## Lower-level verification requests

1. Run `assertledger init <repo> --dry-run --json`, review conflicts and planned bytes, then run
   `assertledger init <repo> --json`. Initialization is static and manages only the two AssertLedger
   root files; it never executes a command or generates worlds or candidates.
2. Run `assertledger audit <repo> --json`, then `assertledger analyze <repo> --json` for generation
   context. Audit may report `VERIFICATION_REQUEST_UNAVAILABLE` until the harness supplies the two
   required operator inputs: `worlds` and `candidates`.
3. Propose candidate files only under the config's `candidateRoots`.
4. Do not let candidate content choose worlds, expected outcomes, policy, or budgets. Those belong to
   the operator or harness.
5. Submit all candidates in one versioned verification request.
6. Run `assertledger verify <request> --allow-unsafe-execution --json` only when the controlling human
   or CI policy has authorized the `UNSANDBOXED` local backend.
7. Preserve the returned manifest, then run `assertledger replay <manifest> --json`.
8. Treat only `VERIFIED` plus a replay result whose `valid` field is true as positive evidence. This
   requires valid schema, decision digest, artifact digest, and decision semantics. `REJECTED`,
   `INCONCLUSIVE`, invalid input, engine errors, and invalid replay results are stop conditions, not
   soft passes.
9. Preserve the emitted manifest as the auditable artifact. Never summarize away failed attempts,
   controls, limitations, or isolation level.

Never claim that AssertLedger proves overall program correctness or universal non-flakiness.
