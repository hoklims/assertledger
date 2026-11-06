import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";
const scope = new AsyncLocalStorage();
const records = [];
let next = 0;
function begin(name, meta) {
  const record = {
    id: ++next,
    parent: scope.getStore() ?? null,
    name,
    meta,
    start: performance.now(),
  };
  records.push(record);
  return record;
}
export async function span(name, meta, operation) {
  const record = begin(name, meta);
  try {
    return await scope.run(record.id, operation);
  } finally {
    record.end = performance.now();
  }
}
export function spanSync(name, meta, operation) {
  const record = begin(name, meta);
  try {
    return scope.run(record.id, operation);
  } finally {
    record.end = performance.now();
  }
}
process.once("exit", () => {
  writeFileSync(
    process.env.E5_SPANS,
    JSON.stringify({
      timeOrigin: performance.timeOrigin,
      records,
      resourceUsage: process.resourceUsage(),
    }),
  );
});
