import { expect, test } from "bun:test";
import { subject } from "../../src/subject.ts";
test("returns a boolean", () => expect(typeof subject(2)).toBe("boolean"));
