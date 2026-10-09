import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const kind = process.argv[2];
const name = JSON.parse(readFileSync("package.json", "utf8")).name;
const task = `${name}#${kind}`;
const emit = (event) =>
  appendFileSync(
    process.env.ASSERTLEDGER_QUALIFICATION_TRACE,
    `${JSON.stringify({ nonce: process.env.ASSERTLEDGER_QUALIFICATION_NONCE, task, event })}\n`,
  );
emit("start");
if (kind === "fail" && name === "@public/leaf") {
  emit("fail");
  process.exit(7);
}
if (kind === "build") {
  mkdirSync("dist", { recursive: true });
  const verdict = readFileSync("verdict.txt", "utf8");
  writeFileSync("dist/result.txt", verdict);
  writeFileSync("dist/manifest.txt", "required-output\n");
}
emit("finish");
