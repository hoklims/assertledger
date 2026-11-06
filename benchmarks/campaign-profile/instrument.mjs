import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
const root = process.argv[2];
const groups = {
  "engine/index.js": [
    "verifyCampaign",
    "verifyCampaignWithTrace",
    "verifyPreparedCampaign",
    "resolveRepositoryRoot",
    "walkFiles",
    "probeNodeTestExecutable",
    "runNodeExecutableProbe",
    "sha256File",
    "copyRepository",
    "analyzeRepository",
    "repositoryInventoryDigest",
    "executeObservation",
    "executeTrustedLocalAdapter",
    "runProcess",
    "runBoundedProcess",
    "applyFiles",
    "readNodeTestReport",
    "removeTemporaryDirectory",
  ],
  "engine/adapters/node-test-runtime.js": ["runNodeTestRuntimePreflight"],
  "core/index.js": ["decideEvidence"],
};
const inventory = [];
for (const [file, names] of Object.entries(groups)) {
  const target = join(root, file);
  const source = readFileSync(target, "utf8");
  const edits = [];
  const found = [];
  for (const name of names) {
    const pattern = new RegExp(
      `^((?:export )?(async )?function ${name}\\([^]*?\\) \\{)([^]*?)(^\\})`,
      "gm",
    );
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1) throw new Error(`Ambiguous function boundary: ${file}:${name}`);
    const match = matches[0];
    const async = Boolean(match[2]);
    const meta =
      name === "executeObservation"
        ? "{world:world.id,candidate:candidate?.id??null,attempt}"
        : name === "runBoundedProcess"
          ? "{executable:input.executable,args:input.args}"
          : "{}";
    const start = match.index + match[1].length;
    edits.push({
      start,
      end: start + match[3].length,
      text: `\nreturn ${async ? "__e5span" : "__e5sync"}(${JSON.stringify(name)},${meta},${async ? "async " : ""}()=>{${match[3]}\n});\n`,
    });
    found.push(name);
  }
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  const helper =
    "./" + relative(dirname(target), join(root, "e5-recorder.mjs")).split("\\").join("/");
  writeFileSync(
    target,
    `import {span as __e5span,spanSync as __e5sync} from ${JSON.stringify(helper)};\n` + output,
  );
  inventory.push({ file, functions: found });
}
writeFileSync(join(root, "instrumentation.json"), JSON.stringify(inventory, null, 2));
