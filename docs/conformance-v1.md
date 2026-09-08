# AssertLedger conformance bundle v1

`conformance/v1/` is a checked-in compatibility oracle. It contains autonomous JSON inputs and
complete expected JSON outputs for canonicalization, evidence decisions and replay, Profile v1,
and Benchmark v1. The bundle includes positive behavior and negative security witnesses.

The published npm package includes this static bundle for inspection and interoperability. The
maintainer commands below require a source checkout with development dependencies; package scripts
are repository-maintenance metadata, not an installed-package verification API.

`pnpm run check:conformance` never generates fixtures. It first verifies the exact file set, every
raw file SHA-256, and this root digest construction over ordinally sorted portable paths:

```text
SHA256(path + NUL + "sha256:" + raw-hex-digest + newline)
```

It then verifies the raw SHA-256 and `$id` of all 34 published schemas directly from `schemas/`,
strictly parses `bundle.json`, dispatches an explicit operation allowlist to public AssertLedger APIs,
and deep-compares every complete expected output. Additional assertions ensure compilation,
collection, timeout, process-crash, infrastructure-error, and no-test-discovered outcomes never
become target kills, and that re-sealed semantic forgeries remain invalid even when their public
digest rails are true.

## Negative witness runner

`pnpm run witness:conformance` exercises the checker against seven mutations in an OS-temporary copy,
never against the checked-in candidate. It first proves the copied oracle green, then verifies that:

1. changing one fixture byte fails the raw-file lock; and
2. replacing each of COMPILE_FAILURE, COLLECTION_FAILURE, TIMEOUT, PROCESS_CRASH, INFRA_ERROR, and
   NO_TEST_DISCOVERED, together with its expected output, with VERIFIED semantics still fails the
   manually written non-kill assertion, even after the temporary raw locks and root are resealed.

The runner recreates the temporary copy between mutants, verifies a final green run, removes the
temporary directory, and emits one JSON receipt containing the before/after raw digests, red and
green exit codes, and output digests. It rejects any mutation target inside the repository. Because
the runner is deliberately mutating and more expensive, it is an explicit audit command and is not
part of `pnpm check`.

## Maintainer regeneration

The generator requires an explicit output directory and normally writes only to a temporary or
review directory:

```sh
pnpm exec tsx scripts/generate-conformance-v1.ts --output-dir ./tmp/conformance-candidate
```

It refuses `conformance/v1` unless `--maintainer-allow-canonical` is present and never writes
`scripts/conformance-v1-lock.ts`. Updating the public oracle therefore requires an intentional
sequence:

1. generate into a temporary directory and review the semantic delta;
2. obtain a fresh proof-integrity review of changed operations and witnesses;
3. explicitly regenerate the canonical directory with the maintainer flag;
4. format the final JSON bytes;
5. independently calculate and manually update raw file hashes, the root digest, and locked public
   decision/artifact/profile/benchmark digests;
6. run `pnpm check` and review the final aggregate diff.

Any fixture or lock change is a public compatibility migration and must be documented. Do not
accept a regenerated lock merely because the new checker is green: the checked-in oracle is an
initial assumption, not an independent source of truth.

## Scope and non-claims

The bundle establishes deterministic compatibility with these checked-in examples and preserves
named negative witnesses. It does not prove that the initial expected outputs are correct, that all
semantic branches are covered, that execution evidence is truthful, or that a self-modifying
change deserves acceptance. A fresh human or independent proof audit remains required whenever
the fixtures, lock, checker, schemas, digest projections, or decision semantics change.
