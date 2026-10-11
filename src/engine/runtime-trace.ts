import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";

/** Operator diagnostics only: never included in evidence or decision inputs. */
export interface RuntimeTraceContext {
  kind?: "identity" | "preflight" | "campaign-load" | "campaign-test" | "snapshot";
  probe?: string;
  worldId?: string;
  candidateId?: string | null;
  attempt?: number;
}

const scopes = new AsyncLocalStorage<TraceSession | null>();

function warn(code: string): void {
  try {
    process.stderr.write(`${code}\n`);
  } catch {
    // A diagnostic channel failure cannot replace an execution result.
  }
}

/** Bounded, nonblocking handoff; acknowledgements release occupied slots. */
export class RuntimeTraceQueue {
  private pending = 0;
  private warned = false;
  constructor(private readonly publish: (record: string) => void) {}
  enqueue(record: string): void {
    if (this.pending >= 512 || Buffer.byteLength(record) > 4096) {
      if (!this.warned) warn("ASSERTLEDGER_RUNTIME_TRACE_DROPPED");
      this.warned = true;
      return;
    }
    this.pending++;
    try {
      this.publish(record);
    } catch {
      this.pending--;
    }
  }
  acknowledge(): void {
    this.pending = Math.max(0, this.pending - 1);
  }
}

// Fixed engine-owned code: only JSONL data crosses the worker boundary.
// Filesystem writes cannot hold up a lifecycle operation or keep the CLI alive.
const WRITER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
try {
  const c = fs.constants;
  const fd = fs.openSync(workerData, c.O_WRONLY | c.O_CREAT | c.O_EXCL |
    (c.O_NOFOLLOW || 0) | (c.O_NONBLOCK || 0), 0o600);
  if (!fs.fstatSync(fd).isFile()) throw new Error('not regular');
  parentPort.postMessage('ready');
  parentPort.on('message', record => {
    try {
      if (record === null) {
        fs.closeSync(fd); parentPort.postMessage('closed'); parentPort.close();
      } else {
        const bytes = Buffer.from(record);
        let offset = 0;
        while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset);
        parentPort.postMessage('written');
      }
    } catch { parentPort.postMessage('failed'); parentPort.close(); }
  });
} catch { parentPort.postMessage('failed'); parentPort.close(); }
`;

async function canonical(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) throw new Error("unresolvable path");
    return join(await canonical(parent), basename(absolute));
  }
}

async function safeDestination(destination: string, roots: readonly string[]): Promise<string> {
  const target = join(await realpath(dirname(resolve(destination))), basename(destination));
  for (const root of roots) {
    const path = relative(await canonical(root), target);
    if (!path || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))) {
      throw new Error("reserved destination");
    }
  }
  return target;
}

class TraceSession {
  readonly queue: RuntimeTraceQueue;
  private failed = false;
  private signal: ((message: string) => void) | undefined;
  constructor(
    readonly destination: string,
    private readonly worker: Worker,
  ) {
    this.queue = new RuntimeTraceQueue((record) => {
      if (!this.failed) worker.postMessage(record);
    });
    worker.on("message", (message: string) => {
      if (message === "written") this.queue.acknowledge();
      if (message === "failed") this.fail();
      this.signal?.(message);
    });
    worker.on("error", () => {
      this.fail();
      this.signal?.("failed");
    });
    worker.unref();
  }
  private fail(): void {
    if (!this.failed) warn("ASSERTLEDGER_RUNTIME_TRACE_WRITE_FAILED");
    this.failed = true;
  }
  async waitFor(expected: string, timeoutMs: number): Promise<boolean> {
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.signal = undefined;
        done(false);
      }, timeoutMs);
      this.signal = (message) => {
        if (message !== expected && message !== "failed") return;
        clearTimeout(timer);
        this.signal = undefined;
        done(message === expected);
      };
    });
  }
  stop(): void {
    void this.worker.terminate().catch(() => {});
  }
  async finish(): Promise<void> {
    if (!this.failed) {
      const closed = this.waitFor("closed", 250);
      this.worker.postMessage(null);
      if (!(await closed)) this.fail();
    }
    this.stop();
  }
}

/** Reserve a fresh diagnostic sink outside proof inputs and output reservations. */
export async function withRuntimeTrace<T>(
  forbiddenRoots: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const existing = scopes.getStore();
  const destination = existing?.destination ?? process.env.ASSERTLEDGER_RUNTIME_TRACE;
  if (!destination || existing === null) return operation();
  let target: string;
  try {
    target = await safeDestination(destination, forbiddenRoots);
  } catch {
    warn("ASSERTLEDGER_RUNTIME_TRACE_UNSAFE_DESTINATION");
    return scopes.run(null, operation);
  }
  if (existing) return operation();
  let session: TraceSession;
  try {
    session = new TraceSession(
      target,
      new Worker(WRITER_SOURCE, { eval: true, workerData: target }),
    );
    if (!(await session.waitFor("ready", 1000))) {
      session.stop();
      warn("ASSERTLEDGER_RUNTIME_TRACE_WRITE_FAILED");
      return scopes.run(null, operation);
    }
  } catch {
    warn("ASSERTLEDGER_RUNTIME_TRACE_WRITE_FAILED");
    return scopes.run(null, operation);
  }
  try {
    return await scopes.run(session, operation);
  } finally {
    try {
      await session.finish();
    } catch {
      session.stop();
    }
  }
}

export async function traceOperation<T>(
  phase: string,
  context: RuntimeTraceContext & { container?: string; timeoutMs?: number; transport?: string },
  operation: () => Promise<T>,
  facts?: (result: T | undefined) => Record<string, string | number | boolean | null>,
): Promise<T> {
  const session = scopes.getStore();
  if (!session) return operation();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let result: T | undefined;
  let threw = true;
  try {
    result = await operation();
    threw = false;
    return result;
  } finally {
    try {
      const event = {
        phase,
        container: null,
        ...context,
        startedAt,
        durationMs: performance.now() - start,
        threw,
        ...facts?.(result),
      };
      session.queue.enqueue(`${JSON.stringify(event)}\n`);
    } catch {
      /* Diagnostics preserve the original result or error. */
    }
  }
}
