import { describe, expect, test } from "bun:test";
import { subject } from "../src/subject.ts";
describe("parity", () => {
  test("two is even", () => {
    expect(subject(2)).toBe(true);
  });
});
