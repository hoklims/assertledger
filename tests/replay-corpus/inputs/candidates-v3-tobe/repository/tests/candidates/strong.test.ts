import { expect, test } from "bun:test";
import { subject } from "../../src/subject.ts";
test("two is even", () => expect(subject(2)).toBe(true));
