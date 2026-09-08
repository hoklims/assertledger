# Agentic corpus provenance v1

An Agentic Test Profile corpus case is not trusted because it names a plausible `sourceId`.
Every `<name>.case.json` must retain the unchanged case-v1 format and be paired with a canonical
`<name>.provenance.json`. Readiness additionally requires an operator-supplied trust policy and its
expected digest.

## Trust root

The trust policy registers Ed25519 SPKI public keys, their subjects and AUTHOR or REVIEWER roles,
then binds each source ID to one immutable source-identity digest and explicit authorized subjects.
The `policyDigest` is the canonical SHA-256 digest of the policy without that field. Callers must
pin the same value independently with `--trust-policy-digest`; a policy bundled beside a corpus is
not its own root of trust.

Key IDs are SHA-256 digests of canonical SPKI DER bytes. AssertLedger imports and re-exports every key,
requires byte-for-byte equality with the supplied DER, and compares canonical fingerprints. This
rejects alternate encodings such as a valid SPKI followed by ignored suffix bytes. A case requires
different author and reviewer keys, canonical fingerprints, and subjects. Both principals sign the
same domain-separated canonical projection, including both key IDs, the case digest, source identity
and revision, and execution receipt. `provenanceDigest` then binds that projection and both
signatures.

`keyId` values are globally unique within a policy. `subjectId` values intentionally are not: one
principal may rotate across multiple trusted keys. That rotation does not create reviewer
independence. For a case replay, the selected author and reviewer must still have different key IDs,
canonical key fingerprints, and subject IDs.

Sidecars use canonical JSON exactly: `canonicalize(parsed) + "\n"`. Formatting variants and JSON
with duplicate members are rejected before evaluation. A sidecar must be a regular, non-symlink
file whose resolved parent is the physical split directory. Case identifiers and paired basenames
also use AssertLedger's NFC and case-folded portable path key, so host-dependent collisions fail closed.

## CLI

```sh
tsx scripts/evaluate-agentic-profile-corpus.ts status benchmarks/agentic-profile \
  --trust-policy operator-policy.json \
  --trust-policy-digest sha256:...

tsx scripts/evaluate-agentic-profile-corpus.ts replay-provenance \
  public/example.case.json public/example.provenance.json \
  --trust-policy operator-policy.json \
  --trust-policy-digest sha256:...
```

`status`, `evaluate-public`, and `evaluate-holdout` return exit 3 when not ready. Invalid policy or
provenance returns exit 4. Valid replay or evaluation returns exit 0. AssertLedger intentionally has no
private-key or signing command.

## Migration and limits

Unsigned v1 case files remain parse-compatible, but can never make a corpus READY. Producers must
retain each case unchanged, create its paired sidecar, and distribute the policy digest through an
independent trusted channel.

The signatures prove that the named authorized principals approved the signed bytes. They do not
prove that execution actually occurred. Until `evidenceDigests` resolve to independently replayable
artifacts, the EXECUTED receipt remains an attestation rather than execution proof.
