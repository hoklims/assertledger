# Understand a refusal and choose the next action

Run `assertledger explain TARGET_STRENGTH_INSUFFICIENT` for an explanation. Add `--json` for
the strict `catalogueVersion: "1.0.0"` report. Several codes can be passed together; duplicates
are removed and results are sorted by code.

The same report is available through `new AssertLedger().explain(codes)` and the read-only
MCP tool `assertledger_explain` with `{ "codes": ["TARGET_STRENGTH_INSUFFICIENT"] }`.
`DiagnosticReportSchema` and `explainReasonCodes` are public package exports. Git qualification
includes this guidance in the terminal and its saved summary.

| Symptom | Meaning | Next step |
| --- | --- | --- |
| `TARGET_STRENGTH_INSUFFICIENT` | The test did not detect enough declared bugs by assertion. | Assert the corrected behavior and rerun against the same worlds. |
| `REFERENCE_NOT_GREEN` | The test fails on corrected code. | Fix the test or the reference before interpreting bug detection. |
| `OBSERVATIONS_DIVERGE` | Repeated runs disagree. | Remove nondeterministic inputs and repeat all attempts. |
| `CANDIDATE_DISCOVERY_INVALID` | The candidate was not identified as expected. | Check the committed path and runner selection. |
| `TIMEOUT` / `PROCESS_CRASH` | Execution did not yield acceptable assertion evidence. | Resolve the operational failure; it cannot count as a detected bug. |
| `GIT_REGRESSION_OUTPUT_EXISTS` | The chosen directory already contains something. | Choose a new evidence directory. |
| `MCP_REPOSITORY_ROOT_FORBIDDEN` | The server does not permit the requested repository. | Use the intended project root or a server configured by its operator. |

Guidance is derived presentation data. It does not change the verdict, evidence manifest,
decision digest, artifact digest or existing JSON outputs. Unknown codes remain unknown and
advise consulting the matching package version. Inputs accept only bounded uppercase reason
codes; arbitrary exception messages, source code, environment values and logs are not inputs.

## Français

La commande `assertledger explain CODE --json` rend les mêmes explications que le SDK et MCP.
Les explications du catalogue sont en anglais pour conserver un vocabulaire commun aux outils.
Un code inconnu reste signalé comme inconnu ; il ne devient jamais un résultat favorable.

Commencez par le premier contrôle en échec. Corrigez les erreurs d’exécution avant d’évaluer la
force du test. Un délai dépassé, une compilation impossible ou une exception générique ne
prouvent pas que le test détecte le défaut déclaré.
