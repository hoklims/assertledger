import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomUUID } from "node:crypto";
import { closeSync, readSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as assertionHelper from "./bun.mjs";
import * as bunTest from "bun:test";

const root = process.env.ASSERTLEDGER_BUN_ROOT;
if (!path.isAbsolute(root ?? "")) {
  throw new Error("ASSERTLEDGER_BUN_PRELOAD_CONFIGURATION_INVALID");
}

const preloadPath = fileURLToPath(import.meta.url);
const safeApply = Reflect.apply.bind(Reflect);
const safeGet = Reflect.get.bind(Reflect);
const ownDescriptor = Reflect.getOwnPropertyDescriptor.bind(Reflect);
const prototypeOf = Reflect.getPrototypeOf.bind(Reflect);
const stringReplace = String.prototype.replace;
const stringSplit = String.prototype.split;
const stringTrim = String.prototype.trim;
const stringStartsWith = String.prototype.startsWith;
const isErrorInstance = Object.prototype.isPrototypeOf.bind(Error.prototype);
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
const LINE_BREAK = /\r?\n/u;
const fileKey = (file) =>
  process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);

// A designated selection runs one existing test ("run") or only loads its file ("load"). Without it
// the preload keeps the candidate-file behavior: only assertSame failures can be owned.
const designatedSelection = (() => {
  const value = process.env.ASSERTLEDGER_BUN_DESIGNATED;
  if (value === undefined) return undefined;
  const parsed = JSON.parse(value);
  if (parsed?.mode !== "run" && parsed?.mode !== "load") {
    throw new Error("ASSERTLEDGER_BUN_PRELOAD_CONFIGURATION_INVALID");
  }
  return parsed;
})();
const designatedKeys = (
  designatedSelection === undefined
    ? []
    : designatedSelection.mode === "run"
      ? [designatedSelection.test]
      : designatedSelection.tests
).map((test) => JSON.stringify([fileKey(path.resolve(root, test.file)), ...test.path]));
// The expected line may be copied from Bun's output, which prefixes "error:".
const expectedFailure =
  designatedSelection?.mode === "run" && typeof designatedSelection.expectedFailure === "string"
    ? designatedSelection.expectedFailure
        .replace(ANSI_SGR, "")
        .split(LINE_BREAK)[0]
        .trim()
        .replace(/^error:\s*/u, "")
    : null;

/** The first line of a failure message without terminal colors, as Bun prints it after "error:". */
function failureSignature(error) {
  const descriptor = ownDescriptor(error, "message");
  const message = typeof descriptor?.value === "string" ? descriptor.value : "";
  const plain = safeApply(stringReplace, message, [ANSI_SGR, ""]);
  return safeApply(stringTrim, safeApply(stringSplit, plain, [LINE_BREAK])[0] ?? "", []);
}

const rawAssertSame = assertionHelper.assertSame;
const verifyIssuedError = assertionHelper.isAssertSameFailure;
const issuedDuringTest = new WeakMap();
const markIssuingTest = WeakMap.prototype.set.bind(issuedDuringTest);
const issuingTest = WeakMap.prototype.get.bind(issuedDuringTest);
const expectIssued = new WeakMap();
const markExpectIssued = WeakMap.prototype.set.bind(expectIssued);
const expectIssuingTest = WeakMap.prototype.get.bind(expectIssued);
const activeTestExecution = new AsyncLocalStorage();
const currentTestId = AsyncLocalStorage.prototype.getStore.bind(activeTestExecution);
const runInTest = AsyncLocalStorage.prototype.run.bind(activeTestExecution);
function scopedAssertSame(...arguments_) {
  try {
    return safeApply(rawAssertSame, undefined, arguments_);
  } catch (error) {
    const id = currentTestId();
    if (id !== undefined && verifyIssuedError(error)) markIssuingTest(error, id);
    throw error;
  }
}

// Only a built-in matcher, present before any test file can extend expect, can issue an owned
// failure, and only when its message has Bun's matcher form. Usage errors and custom matchers stay
// ordinary errors.
const nativeExpect = bunTest.expect;
const builtInMatchers = new Set();
const matcherChains = new Set(["not", "resolves", "rejects"]);
const matcherPrototype =
  designatedSelection === undefined ? null : prototypeOf(nativeExpect(undefined));
for (const name of matcherPrototype === null ? [] : Reflect.ownKeys(matcherPrototype)) {
  const descriptor = ownDescriptor(matcherPrototype, name);
  if (typeof name === "string" && name !== "constructor" && typeof descriptor?.value === "function")
    builtInMatchers.add(name);
}
const hasBuiltInMatcher = Set.prototype.has.bind(builtInMatchers);
const isMatcherChain = Set.prototype.has.bind(matcherChains);
function markMatcherFailure(error, id) {
  if (id === undefined || !isErrorInstance(error)) return;
  const signature = failureSignature(error);
  if (safeApply(stringStartsWith, signature, ["expect("]))
    markExpectIssued(error, { id, signature });
}
function scopedMatchers(matchers) {
  return new Proxy(matchers, {
    get(target, property) {
      const value = safeGet(target, property, target);
      if (typeof property === "string" && isMatcherChain(property)) return scopedMatchers(value);
      if (typeof value !== "function") return value;
      if (typeof property !== "string" || !hasBuiltInMatcher(property)) return value.bind(target);
      return (...arguments_) => {
        const id = currentTestId();
        try {
          const result = safeApply(value, target, arguments_);
          return result && typeof result.then === "function"
            ? Promise.resolve(result).catch((error) => {
                markMatcherFailure(error, id);
                throw error;
              })
            : result;
        } catch (error) {
          markMatcherFailure(error, id);
          throw error;
        }
      };
    },
  });
}
const scopedExpect = new Proxy(nativeExpect, {
  apply(target, thisArg, arguments_) {
    return scopedMatchers(safeApply(target, thisArg, arguments_));
  },
  get(target, property) {
    const value = safeGet(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

/** Whether a designated test's failure is an owned assertion with the expected first line. */
function designatedFailureOwned(error, id) {
  const assertSameOwned = verifyIssuedError(error) && issuingTest(error) === id;
  const expectOwned = expectIssuingTest(error)?.id === id;
  if (!assertSameOwned && !expectOwned) return false;
  return expectedFailure === null || failureSignature(error) === expectedFailure;
}

const stringify = JSON.stringify.bind(JSON);
const evidenceKey = Buffer.alloc(32);
let received = 0;
while (received < evidenceKey.length) {
  const length = readSync(4, evidenceKey, received, evidenceKey.length - received, null);
  if (length === 0) throw new Error("ASSERTLEDGER_BUN_EVIDENCE_KEY_MISSING");
  received += length;
}
closeSync(4);
function record(event) {
  const body = stringify(event);
  const mac = createHmac("sha256", evidenceKey).update(body).digest("hex");
  writeSync(3, `${stringify({ event, mac })}\n`);
}

function registrationFile() {
  const lines = new Error().stack?.split(/\r?\n/u).slice(1) ?? [];
  for (const line of lines) {
    let location = line.trim().replace(/^at\s+/u, "");
    if (location.endsWith(")") && location.includes("(")) {
      location = location.slice(location.lastIndexOf("(") + 1, -1);
    }
    const match = location.match(/^(.+?):\d+(?::\d+)?$/u);
    if (match === null) continue;
    let file = match[1];
    if (file.startsWith("file:")) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }
    if (!path.isAbsolute(file)) continue;
    const absolute = path.resolve(file);
    if (absolute === preloadPath) continue;
    return absolute;
  }
  throw new Error("ASSERTLEDGER_BUN_REGISTRATION_FILE_UNAVAILABLE");
}

// Describe names enclosing the registration in progress. A templated (`each`) or non-string name
// can never match a designated path.
const describeStack = [];
const UNNAMED = Symbol("unnamed");

function designatedIndex(file, name) {
  if (designatedSelection === undefined || describeStack.includes(UNNAMED) || name === UNNAMED) {
    return -1;
  }
  return designatedKeys.indexOf(JSON.stringify([fileKey(file), ...describeStack, name]));
}

function wrapRegistration(native, cache, templated = false) {
  if (cache.has(native)) return cache.get(native);
  const wrapper = new Proxy(native, {
    apply(target, thisArg, arguments_) {
      const callbackIndex = arguments_.findIndex(
        (value, index) => typeof value === "function" && (index > 0 || arguments_.length === 1),
      );
      if (callbackIndex < 0) {
        const result = safeApply(target, thisArg, arguments_);
        return typeof result === "function" ? wrapRegistration(result, cache, templated) : result;
      }
      const callback = arguments_[callbackIndex];
      const file = registrationFile();
      const name = !templated && typeof arguments_[0] === "string" ? arguments_[0] : UNNAMED;
      const designated = designatedIndex(file, name);
      if (designatedSelection?.mode === "load") {
        // Loading registers nothing: the file and every module it imports are evaluated only.
        record({ kind: "registered", file, designated });
        return undefined;
      }
      const wrappedArguments = [...arguments_];
      wrappedArguments[callbackIndex] = function (...callbackArguments) {
        const id = randomUUID();
        record(
          designatedSelection === undefined
            ? { kind: "found", id, file }
            : { kind: "found", id, file, designated: designated >= 0 },
        );
        return runInTest(id, () => {
          const passed = (value) => {
            record({ kind: "end", id, status: "pass" });
            return value;
          };
          const failed = (error) => {
            record({
              kind: "end",
              id,
              status: "fail",
              owned:
                designatedSelection === undefined
                  ? verifyIssuedError(error) && issuingTest(error) === id
                  : designated >= 0 && designatedFailureOwned(error, id),
            });
            throw error;
          };
          try {
            const result = safeApply(callback, this, callbackArguments);
            return result && typeof result.then === "function"
              ? Promise.resolve(result).then(passed, failed)
              : passed(result);
          } catch (error) {
            return failed(error);
          }
        });
      };
      return safeApply(target, thisArg, wrappedArguments);
    },
    get(target, property, receiver) {
      const value = safeGet(target, property, receiver);
      return typeof value === "function" && property !== "constructor"
        ? wrapRegistration(value.bind(target), cache, templated || property === "each")
        : value;
    },
  });
  cache.set(native, wrapper);
  return wrapper;
}

function wrapDescribe(native, cache, templated = false) {
  if (cache.has(native)) return cache.get(native);
  const wrapper = new Proxy(native, {
    apply(target, thisArg, arguments_) {
      const callbackIndex = arguments_.findIndex(
        (value, index) => typeof value === "function" && (index > 0 || arguments_.length === 1),
      );
      if (callbackIndex < 0) {
        const result = safeApply(target, thisArg, arguments_);
        return typeof result === "function" ? wrapDescribe(result, cache, templated) : result;
      }
      const callback = arguments_[callbackIndex];
      const name = !templated && typeof arguments_[0] === "string" ? arguments_[0] : UNNAMED;
      const wrappedArguments = [...arguments_];
      wrappedArguments[callbackIndex] = function (...callbackArguments) {
        describeStack.push(name);
        try {
          return safeApply(callback, this, callbackArguments);
        } finally {
          describeStack.pop();
        }
      };
      return safeApply(target, thisArg, wrappedArguments);
    },
    get(target, property, receiver) {
      const value = safeGet(target, property, receiver);
      return typeof value === "function" && property !== "constructor"
        ? wrapDescribe(value.bind(target), cache, templated || property === "each")
        : value;
    },
  });
  cache.set(native, wrapper);
  return wrapper;
}

function wrapHook(nativeHook) {
  return (callback, ...options) => {
    if (typeof callback !== "function")
      return safeApply(nativeHook, bunTest, [callback, ...options]);
    const wrappedCallback = function (...arguments_) {
      const failed = (error) => {
        record({ kind: "hook-error" });
        throw error;
      };
      try {
        const result = safeApply(callback, this, arguments_);
        return result && typeof result.then === "function"
          ? Promise.resolve(result).catch(failed)
          : result;
      } catch (error) {
        return failed(error);
      }
    };
    return safeApply(nativeHook, bunTest, [wrappedCallback, ...options]);
  };
}

const cache = new WeakMap();
const wrappedTest = wrapRegistration(bunTest.test, cache);
const wrappedIt = wrapRegistration(bunTest.it, cache);
const describeCache = new WeakMap();
bunTest.mock.module("bun:test", () => ({
  ...bunTest,
  test: wrappedTest,
  it: wrappedIt,
  beforeAll: wrapHook(bunTest.beforeAll),
  afterAll: wrapHook(bunTest.afterAll),
  beforeEach: wrapHook(bunTest.beforeEach),
  afterEach: wrapHook(bunTest.afterEach),
  ...(designatedSelection === undefined
    ? {}
    : { describe: wrapDescribe(bunTest.describe, describeCache), expect: scopedExpect }),
}));
bunTest.mock.module("assertledger/bun", () => ({
  ...assertionHelper,
  assertSame: scopedAssertSame,
}));
