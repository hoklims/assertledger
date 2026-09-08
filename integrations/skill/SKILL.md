---
name: assertledger
description: Analyze a repository, submit candidate tests, and accept only deterministic AssertLedger evidence.
---

# AssertLedger skill

Use this skill when an agent is asked to generate tests whose actual evidence must be checked.

AssertLedger was formerly named TestForge. The `assertledger` CLI is the preferred binary; the
`testforge` binary remains a legacy-compatible alias for the same commands during the compatibility
window.

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
