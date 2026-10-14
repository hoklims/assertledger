# Rust migration: implementation and completion contract

Status: **in progress; this is not a complete Rust migration**.

The target is a shared Rust implementation behind compatible npm, JavaScript SDK,
CLI and MCP facades. Existing public npm exports still run the TypeScript implementation.
No release, installation cutover or stronger isolation guarantee is established here.
The implementation started from `ecdffeee071435087afddfa2ad180e31faef1c12`.

## Architecture

| Component | Responsibility | Current implementation |
| --- | --- | --- |
| `rust/assertledger-core` | Pure canonicalization, decisions, selection and replay | Evidence kernel v1-v5; v1 profile/benchmark creation and replay |
| `rust/assertledger-engine` | Repository IO, execution, adapters and budgets | Process supervisor only |
| `rust/assertledger-node` | Node-API conversion and promises | Lossless canonicalization, ordinary JSON core dispatch and process transport |
| `src/native` | Development facade over the addon | Internal module, absent from public package exports |
| Native CLI | Arguments, output and exit codes over shared Rust use cases | Open |
| Existing SDK/MCP facades | Public JS objects, callbacks, schemas and server identity | Cutover open |

The core has no filesystem, process, network, clock or random input. The addon is
the only component that reads JavaScript values; the engine supervises processes.
Node/Bun reporters may remain JavaScript target-runtime adapters. Rust must own
their validation, attribution and outcome classification.

A subprocess JSON bridge cannot preserve the complete existing SDK. The package
exports actual Zod schemas, errors, callbacks, maps, bytes and foreign FileHandles.
Node-API preserves the option of keeping those objects while moving authority into Rust.
The callback acknowledgement channel and native-backed schema compatibility are still open.

## Preserved and measured behavior

- Frozen `conformance/v1` inputs and expected bytes remain unchanged; native tests
  compare their actual outputs, rather than regenerating expectations.
- Decisions bind the same v1-v5 contexts and distinguish decision from artifact digests.
- Timeout, collection, compilation, infrastructure and process failures receive no kill credit.
- Canonicalization uses UTF-16 ordinal keys, ECMAScript number formatting, and
  lossless lone-surrogate escaping. Cycles, array holes and non-plain objects are refused.
- Commands use an executable and literal argument array; output budgets are independent;
  digests cover complete observed streams, including bytes beyond capture limits.
- On Windows, the supervisor supplies the same fixed required-environment names as
  [libuv 1.51.0](https://github.com/libuv/libuv/blob/v1.51.0/src/win/process.c#L47-L59)
  when absent, preserving Node startup with an explicit empty environment. This is
  the existing Node behavior; arbitrary inherited environment variables remain excluded.

`trusted-local` remains explicitly unsandboxed. Process-tree termination is best effort.
Windows cleanup can finish after the 250 ms public grace window; its background
cleanup is bounded. Detached children or children whose parent has exited are not contained.
Native timeout exit/signal fields and spawn-error text can differ from Node's host-specific values.

## Development checks

Install Rust 1.95.0 with `rustfmt` and `clippy`; Windows addon builds use the MSVC
toolchain and existing Visual Studio build tools. The GNU evidence/process crates
can be tested separately, but the Node addon does not use a separate `libnode.dll`.

```text
pnpm install --frozen-lockfile
pnpm check
pnpm run check:rust
```

`check:rust` builds the TS reference, checks Rust formatting and Clippy, runs native
unit/integration/conformance tests, compiles the addon, and executes JavaScript
differential tests. Each failed step stops the runner with its nonzero exit code.
CI runs the native checks on Windows, Linux and macOS with Node 22 and 24.
The build writes only a development addon under `.testforge/native`.

## Known compatibility limits before cutover

- Native core dispatch accepts ordinary JSON values. Lossless canonicalization is
  separate; callbacks, maps, bytes, undefined fields and lone-surrogate evidence
  payloads have not all been mapped into the core dispatcher.
- The native value reader refuses nesting beyond 512 objects. This is an explicit
  development limit, not a claim of unrestricted legacy API parity.
- Malformed primitive entries in manifest digest projections fail closed rather
  than reproducing every JavaScript spread/coercion behavior.
- The native process supervisor does not yet carry streaming standard input for
  container transport, and timeout host fields require parity decisions before cutover.
- Platform CI and packaged consumer installation are separate evidence; a local
  Windows run does not qualify Linux/macOS or public npm distribution.

## Complete migration requires

- [ ] Port all contract parsers/refinements and preserve genuine exported Zod objects.
- [ ] Port remaining profiles, corpus allocation/experiments, qualification,
      proof planner, diagnostics and evaluation.
- [ ] Port repository inventory, lexical scanning, closure resolution, snapshots,
      links, init/doctor/setup and atomic managed-file writes.
- [ ] Port Node/Bun/structured-command adapter orchestration, container transports,
      witness imports, Git regression and qualification terminal observation.
- [ ] Preserve callback order, async acknowledgements, Map/byte conversion,
      foreign-handle lifetime, error classes/properties and synchronous SDK calls.
- [ ] Bind qualification mechanism identity to the actual loaded native binary
      and retained reporters; document any new versioned identity projection.
- [ ] Switch every public SDK, CLI and MCP operation to the same Rust authority.
- [ ] Ship prebuilt native assets for every supported npm platform without requiring
      lifecycle scripts or consumer-side Rust compilation, then test fresh installs.
- [ ] Pass existing checks, complete native parity and sensitive negative witnesses
      on the final candidate and the declared platform matrix.

The pull request remains a draft until these obligations are closed. Keeping the
TypeScript reference or wrapping it in a Rust launcher does not close this checklist.
