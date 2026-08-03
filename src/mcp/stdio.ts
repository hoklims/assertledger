#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createTestForgeServer } from "./index.js";

const allowUnsafeExecution = process.argv.slice(2).includes("--allow-unsafe-execution");

serveStdio(
  () =>
    createTestForgeServer({
      allowUnsafeExecution,
      allowedRepositoryRoots: [process.cwd()],
    }),
  {
    onerror(error) {
      process.stderr.write(`TestForge MCP error: ${error.message}\n`);
    },
  },
);
