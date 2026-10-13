import { test, expect } from "bun:test";
test("native Bun assertion", () => {
  expect(2 + 2).toBe(4);
});
