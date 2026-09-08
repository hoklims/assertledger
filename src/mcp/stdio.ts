#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createAssertLedgerServer } from "./index.js";

const allowUnsafeExecution = process.argv.slice(2).includes("--allow-unsafe-execution");

serveStdio(
  () =>
    createAssertLedgerServer({
      allowUnsafeExecution,
      allowedRepositoryRoots: [process.cwd()],
    }),
  {
    onerror(error) {
      process.stderr.write(`AssertLedger MCP error: ${error.message}\n`);
    },
  },
);
