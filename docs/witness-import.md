# Witness import

`assertledger import-witness` replays a recorded red/green witness as a v4 campaign and verifies it.
The witness states what was observed; AssertLedger observes it again under its own taxonomy.

## Request

A `witness-import-request.v1.json` document names:

- `repository`: the root, exclusions, `includeDependencies` and the `git` mode, as in a
  [v4 request](migration-verification-v4.md);
- `adapter`: `bun-test-designated`, with its executable and per-test timeout;
- `test` and `expectedFailure`: the existing designated test and the first line of its failure;
- `targets`: each mutated file with its `beforeDigest`, the SHA-256 of the bytes it replaces, and
  its mutated `content`;
- `neutral`: an operator-supplied neutral control and its reason, or `null`;
- `requiredAttempts` and `timeoutMsPerExecution`.

Each target must still hold its base bytes (`WITNESS_TARGET_BASE_MISMATCH`) and its content must
differ from them (`WITNESS_TARGET_UNCHANGED`).

## Campaign

The repository is the reference world, the targets form the one target world, and the neutral
control is the operator's, or an identity control whose limit the manifest states. The policy is
fixed: every attempt in the target world must be an assertion failure attributed to the designated
test with the expected line, and every reference and neutral attempt must pass.

## Backend

The witness never selects its backend. The operator passes exactly one of:

```sh
assertledger import-witness witness.json --out evidence --container-image oven/bun@sha256:DIGEST \
  --container-runtime '["wsl.exe","-d","Ubuntu","--exec","docker"]'
assertledger import-witness witness.json --out evidence --allow-unsafe-execution
assertledger import-witness witness.json --out evidence --allow-windows-native-execution
```

`--env NAME` replaces the default host environment allowlist of a local backend. Without a backend
the command refuses with exit code 4 and writes nothing.

## Output

`--out` must be a new directory outside the repository. It receives `executed-request.json`,
`summary.md` and, written last, `manifest.json`. The summary states the verdict, every observation,
the isolation level and the limitations; `--json` prints the manifest instead. The exit code follows
the verdict. Accept the witness only on `VERIFIED` plus `assertledger replay <manifest> --json`
with `valid: true`.

## A repository with installed dependencies

A Bun workspace installed with the isolated linker holds links in `node_modules`. Replay such a
witness from an archive of the exact revision with a hoisted install, and keep the dependencies in
the snapshot:

```sh
git -C <repository> archive --format=tar --output=archive.tar <revision>
tar -xf archive.tar -C witness-repository
cd witness-repository
bun install --frozen-lockfile --linker hoisted --ignore-scripts
```

Set `includeDependencies: true`. Workspace packages stay linked in `node_modules`; a link outside
the designated test's closure is left out and recorded, and one inside it refuses the import. A
test that asks Git for its tracked files needs `git: "synthesized"`. When a snapshot copy is slow
to read the first time, for example under on-access scanning, declare a per-test timeout that fits.
