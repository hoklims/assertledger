import { readFileSync } from "node:fs";

function readPackageVersion(): string {
  const document = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof document.version !== "string" || document.version.length === 0) {
    throw new Error("PACKAGE_VERSION_INVALID");
  }
  return document.version;
}

export const ASSERTLEDGER_VERSION = readPackageVersion();
