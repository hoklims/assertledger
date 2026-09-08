import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { runCli } from "../src/cli.js";
import { DiagnosticReportSchema, explainReasonCodes } from "../src/diagnostics.js";
import { createAssertLedgerServer } from "../src/mcp/index.js";
import { AssertLedger } from "../src/sdk/index.js";

describe("versioned diagnostic guidance", () => {
  it("explains refusal without turning operational failures into evidence", () => {
    const report = explainReasonCodes([
      "TARGET_STRENGTH_INSUFFICIENT",
      "TIMEOUT",
      "POLICY_SATISFIED",
    ]);
    assert.equal(report.catalogueVersion, "1.0.0");
    assert.deepEqual(
      report.diagnostics.map((item) => item.code),
      ["POLICY_SATISFIED", "TARGET_STRENGTH_INSUFFICIENT", "TIMEOUT"],
    );
    assert.match(report.diagnostics[1]?.explanation ?? "", /attributed assertion/);
    assert.match(report.diagnostics[2]?.nextAction ?? "", /does not count/);
    assert.equal(report.diagnostics[0]?.severity, "info");
    assert.equal(
      DiagnosticReportSchema.safeParse({ ...report, verdict: "VERIFIED" }).success,
      false,
    );
  });

  it("bounds untrusted input and never interpolates raw logs or credentials into advice", () => {
    const report = explainReasonCodes(["FUTURE_CODE", "FUTURE_CODE"]);
    assert.equal(report.diagnostics.length, 1);
    assert.equal(report.diagnostics[0]?.known, false);
    assert.match(report.diagnostics[0]?.nextAction ?? "", /version/);
    assert.throws(
      () => explainReasonCodes(["SECRET=credential\nPASS"]),
      /DIAGNOSTIC_CODES_INVALID/,
    );
    assert.throws(
      () => explainReasonCodes(Array.from({ length: 129 }, () => "TIMEOUT")),
      /DIAGNOSTIC_CODES_INVALID/,
    );
  });

  it("returns the same strict report through SDK, CLI JSON and read-only MCP", async () => {
    const codes = ["NO_ELIGIBLE_CANDIDATE", "REFERENCE_NOT_GREEN"];
    const expected = new AssertLedger().explain(codes);
    let stdout = "";
    const code = await runCli(["explain", ...codes, "--json"], {
      cwd: process.cwd(),
      readStdin: async () => "",
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        assert.fail(text);
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), expected);
    const server = createAssertLedgerServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "diagnostics-client", version: "1.0.0" });
    await server.connect(st);
    await client.connect(ct);
    try {
      const result = await client.callTool({ name: "assertledger_explain", arguments: { codes } });
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.structuredContent, expected);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports malformed explanation arguments as usage or input errors", async () => {
    for (const [argv, expected] of [
      [["explain", "--unknown"], 64],
      [["explain", "not-a-code"], 4],
    ] as const) {
      let stdout = "";
      const exitCode = await runCli([...argv], {
        cwd: process.cwd(),
        readStdin: async () => "",
        writeStdout: (value) => {
          stdout += value;
        },
        writeStderr: () => {},
      });
      assert.equal(exitCode, expected);
      assert.equal(stdout, "");
    }
  });
});
