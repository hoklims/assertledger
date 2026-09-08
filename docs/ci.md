# CI and trusted-local execution

The repository workflow runs the full checks on Windows/Linux with Node 22/24, then tests
the packed distribution on Windows/Linux with Node 22.15/24. The package job retains
manifests, summaries, replay results, command logs and the tarball for 14 days. Artifact names
contain the tested GitHub SHA and matrix values.

Both jobs execute repository code. They run on disposable GitHub-hosted runners with
`contents: read`, no deployment secrets, and checkout credential persistence disabled.
Never move trusted-local verification onto a privileged or self-hosted runner handling
untrusted contributions. AssertLedger does not contain hostile code.

The workflow permits pushes to `main` and same-repository pull requests from an owner,
member or collaborator. Fork pull requests are skipped. A skipped job does not establish
compatibility or release readiness: a maintainer must inspect the exact contribution and
bring the reviewed changes onto a trusted repository branch before executing them.

This is the project's contribution policy, not a sandbox or an immutable security boundary:
workflow definitions themselves must be reviewed, and GitHub's repository permission and
workflow-approval settings remain operator-owned controls. Do not use `pull_request_target`
to execute a contributor's checkout with elevated authority.

## Reuse the result

Open the package job's `package-evidence-*` artifact. Start with `historical-strong-summary.md`,
then inspect the corresponding manifest and `historical-provenance.json`. Run:

```sh
assertledger replay historical-strong-manifest.json --json
```

`historical-checkout-preserved.json` records the unchanged source files, index hash and HEAD.
The weak and generic-crash cases must be rejected, with valid replay. These results prove
the observed supported case; they do not authenticate an arbitrary evidence producer.

Keep release evidence outside the temporary CI retention window when publishing a version.
Never upload private proof-policy copies, credentials or unrelated workspace artifacts.
