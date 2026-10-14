import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const toolchain = process.platform === "win32" ? "+1.95.0-x86_64-pc-windows-msvc" : "+1.95.0";
const build = spawnSync(
  "cargo",
  [toolchain, "build", "--locked", "--release", "-p", "assertledger-node"],
  {
    cwd: root,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const library = {
  win32: "assertledger_node.dll",
  linux: "libassertledger_node.so",
  darwin: "libassertledger_node.dylib",
}[process.platform];
if (!library) throw new Error(`UNSUPPORTED_NATIVE_PLATFORM: ${process.platform}`);
const destination = path.join(root, ".testforge", "native");
mkdirSync(destination, { recursive: true });
copyFileSync(
  path.join(root, "target", "release", library),
  path.join(destination, "assertledger.node"),
);
