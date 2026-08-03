---
name: testforge
description: Analyze a repository, submit candidate tests, and accept only deterministic TestForge evidence.
---

# TestForge skill

Use this skill when an agent is asked to generate tests whose actual evidence must be checked.

1. Run `testforge analyze <repo> --json` and use that structured result as generation context.
2. Propose candidate files only under the request's `candidateRoots`.
3. Do not let candidate content choose worlds, expected outcomes, policy, or budgets. Those belong to
   the operator or harness.
4. Submit all candidates in one versioned verification request.
5. Run `testforge verify <request> --allow-unsafe-execution --json` only when the controlling human or
   CI policy has authorized the `UNSANDBOXED` local backend.
6. Preserve the returned manifest, then run `testforge replay <manifest> --json`.
7. Treat only `VERIFIED` plus a replay result whose `valid` field is true as positive evidence. This
   requires valid schema, decision digest, artifact digest, and decision semantics. `REJECTED`,
   `INCONCLUSIVE`, invalid input, engine errors, and invalid replay results are stop conditions, not
   soft passes.
8. Preserve the emitted manifest as the auditable artifact. Never summarize away failed attempts,
   controls, limitations, or isolation level.

Never claim that TestForge proves overall program correctness or universal non-flakiness.
