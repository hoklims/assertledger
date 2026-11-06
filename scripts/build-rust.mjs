import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const toolchain = process.platform === "win32" ? "+1.95.0-x86_64-pc-windows-msvc" : "+1.95.0";
const build = spawnSync(
  "cargo",
  [toolchain, "build", "--locked", "--release", "--message-format=json", "-p", "assertledger-node"],
  {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  },
);
if (build.error) throw build.error;
const library = {
  win32: "assertledger_node.dll",
  linux: "libassertledger_node.so",
  darwin: "libassertledger_node.dylib",
}[process.platform];
if (!library) throw new Error(`UNSUPPORTED_NATIVE_PLATFORM: ${process.platform}`);
let artifact;
for (const line of build.stdout.split(/\r?\n/u).filter(Boolean)) {
  const message = JSON.parse(line);
  if (message.reason === "compiler-message" && message.message.rendered) {
    process.stderr.write(message.message.rendered);
  }
  if (
    message.reason === "compiler-artifact" &&
    message.target.name === "assertledger_node" &&
    message.target.kind.includes("cdylib")
  ) {
    artifact = message.filenames.find((filename) => path.basename(filename) === library);
  }
}
if (build.status !== 0) process.exit(build.status ?? 1);
if (!artifact) throw new Error("NATIVE_COMPILER_ARTIFACT_MISSING");
const destination = path.join(root, ".testforge", "native");
mkdirSync(destination, { recursive: true });
copyFileSync(artifact, path.join(destination, "assertledger.node"));
process.stdout.write(
  `${JSON.stringify({ artifact, addon: path.join(destination, "assertledger.node") })}\n`,
);
