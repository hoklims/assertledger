# Security policy

## Execution boundary

AssertLedger executes repository code, world overlays, adapter code, and candidate tests. The
`trusted-local` backend is explicitly `UNSANDBOXED`: temporary workspaces, a reduced environment,
bounded output, and process timeouts reduce accidental damage, but they do not contain hostile code.
Timeout enforcement and process-tree termination are best effort and depend on local host facilities.

Do not run untrusted or adversarial candidates with `trusted-local` on a developer workstation or a
CI runner containing secrets. Verification request v2 provides a `container` backend instead: every
execution runs in a fresh container from a digest-pinned local image, with network disabled, no host
mounts, a read-only root file system, a non-root user without capabilities, and process, memory,
CPU, temporary-storage, output, and time limits. See [container isolation](docs/container-isolation.md).
Containers share the daemon host's kernel and are not a VM boundary. The container daemon, its host,
and the image remain trusted, and access to the daemon is administrative access to its host.
AssertLedger records the achieved isolation level in each manifest.

Candidate files are restricted to configured test roots. Absolute paths, traversal segments, path
segments ending in a dot or space, and NTFS alternate data stream syntax are rejected. Repository
symlinks are not silently omitted: AssertLedger rejects a symlink unless an excluded path segment keeps
it outside the inventory and snapshot. Overlay writes also reject symlink destinations discovered in
the workspace. Commands run from executable and argument arrays with `shell: false`.

Environment allowlists and container environment declarations cannot include `NODE_OPTIONS` or
names beginning with `TESTFORGE_` or `NODE_TEST_`, using case-insensitive comparison. AssertLedger
reserves these names for runner custody. Container environment values are recorded in the manifest;
never declare a secret there.

These checks protect the intended write boundary; they do not make execution safe. The source
repository, operator-supplied worlds and policy, dependencies, runner adapter, host, and AssertLedger
engine remain part of the trusted computing base.

## Semantic boundary

A `VERIFIED` decision means only that the selected candidate produced the policy-required,
repeatable observations in the declared worlds. It is not proof of program correctness, absence of
flakiness, absence of bugs, complete fault detection, or resistance to a candidate designed to
recognize the worlds.

Manifest digests detect modification; they do not authenticate the producer or prove that reported
observations were truthful. Use an external signing and attestation system when provenance identity
matters.

The repository digest omits `.git`, `.testforge`, `node_modules`, and operator-excluded path segments.
The manifest stores repository, candidate, world, executable, and process-output digests where the
adapter supplies them; it does not embed the repository snapshot, overlay bodies, raw logs, or
effective environment values. The built-in `node:test` adapter records its resolved executable real
path, Node.js version, and executable SHA-256 digest. The structured-command adapter does not resolve
or hash its executable. Preserve and attest missing materials separately when they affect an audit or
reproduction claim.

## Reporting a vulnerability

Until a private security contact is published, open a GitHub security advisory on the repository.
Do not include exploit payloads or secrets in a public issue.
