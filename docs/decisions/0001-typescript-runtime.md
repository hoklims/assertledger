# ADR 0001: TypeScript runtime for the first vertical release

Status: accepted for v0.1

## Decision

Implement the first complete TestForge release in strict TypeScript on maintained Node.js releases.

## Rationale

The first release must deliver a pure decision core, JSON schemas, process orchestration, SDK, CLI,
and current MCP integration together. TypeScript makes those integration surfaces directly usable by
agent harnesses while preserving a strict protocol boundary.

Rust would improve native distribution and OS process control. The schema and CLI protocols are
therefore versioned so a native orchestrator can replace the Node implementation without moving gate
authority or changing consumers.

## Consequences

- Node.js 22.15 or newer is a runtime dependency.
- `trusted-local` process-tree termination is best effort, especially on Windows.
- The core remains I/O-free and portable at the algorithmic level.
- A future Rust backend must prove byte-compatible canonical decisions with shared fixtures.
