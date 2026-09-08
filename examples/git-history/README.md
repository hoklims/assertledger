# A historical bug, exercised from the installed package

This example uses byte-exact `index.js` snapshots from the MIT-licensed
[`escape-string-regexp` Unicode-hyphen correction](https://github.com/sindresorhus/escape-string-regexp/commit/732905da074f0220487ad6a27590f89bd0819374).
The upstream commit and blob IDs, SHA-256 hashes and license are bundled beside them.

The demo creates a **new projected Git history** with an AssertLedger-authored `node:test`
harness. It does not claim to run the upstream repository's original AVA tests. No network
access or dependency installation is needed once AssertLedger is installed; Node and Git
must be available.

Run the following from your project after installing `assertledger`:

```sh
node node_modules/assertledger/examples/git-history/create-demo.mjs regression-demo
```

The JSON output gives `before`, `after`, `neutral`, the test path and the declared neutral
reason. Copy those exact values into `assertledger check`; see the
[Git command reference](../../docs/git-regression.md). The target directory must not exist.

| Candidate | Expected result | Why |
| --- | --- | --- |
| `strong.test.mjs` | `VERIFIED` | An assertion detects the invalid Unicode pattern on the buggy code. |
| `weak.test.mjs` | `REJECTED` | Checking only the return type passes on both versions. |
| `crash.test.mjs` | `REJECTED` | A generic error on buggy code is not an attributed assertion. |

Use a new `--out` directory for each candidate. Base tests stay identical across all three
worlds. The neutral commit changes only documentation, so it is a declared control, not an
independent demonstration of robustness. `trusted-local` execution remains unsandboxed.

The package smoke runs all three candidates, replays every manifest, checks source and index
preservation, and retains the manifests, executed requests and summaries as CI artifacts.

## Français

Le cas reproduit une correction réelle : l’ancienne fonction échappait le tiret avec une forme
invalide dans une expression régulière Unicode. Les deux fichiers sources sont conservés à
l’octet près, avec leurs références Git et leur licence.

L’historique de démonstration et les tests `node:test` sont créés par AssertLedger. Le test fort
vérifie que la construction de l’expression régulière ne lève pas d’erreur ; le test faible
vérifie seulement le type de retour. Une exception générique ne suffit pas pour prouver la
détection du défaut.
