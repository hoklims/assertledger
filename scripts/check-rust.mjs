import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const toolchain = process.platform === "win32" ? "+1.95.0-x86_64-pc-windows-msvc" : "+1.95.0";
const checks = [
  ["cargo", [toolchain, "fmt", "--all", "--", "--check"]],
  [
    "cargo",
    [toolchain, "clippy", "--locked", "--workspace", "--all-targets", "--", "-D", "warnings"],
  ],
  ["cargo", [toolchain, "test", "--locked", "--workspace", "--exclude", "assertledger-node"]],
  [process.execPath, ["scripts/build-rust.mjs"]],
  [process.execPath, ["--test", "tests/native-runtime.mjs"]],
];
for (const [executable, arguments_] of checks) {
  const result = spawnSync(executable, arguments_, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
