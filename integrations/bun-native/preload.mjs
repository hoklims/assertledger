import * as bunTest from "bun:test";
import nodeAssert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomUUID } from "node:crypto";
import { closeSync, readSync, writeSync } from "node:fs";
import path from "node:path";
import * as nodeTest from "node:test";
import { fileURLToPath } from "node:url";
import { types } from "node:util";

const root = process.env.ASSERTLEDGER_BUN_ROOT;
if (!path.isAbsolute(root ?? "")) throw new Error("ASSERTLEDGER_BUN_PRELOAD_CONFIGURATION_INVALID");
const preloadPath = fileURLToPath(import.meta.url);
const safeApply = Reflect.apply.bind(Reflect);
const safeGet = Reflect.get.bind(Reflect);
const issuedDuringTest = new WeakMap();
const markIssuingTest = WeakMap.prototype.set.bind(issuedDuringTest);
const issuingTest = WeakMap.prototype.get.bind(issuedDuringTest);
const activeTestExecution = new AsyncLocalStorage();
const currentTestId = AsyncLocalStorage.prototype.getStore.bind(activeTestExecution);
const runInTest = AsyncLocalStorage.prototype.run.bind(activeTestExecution);
const supportedMatchers = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toHaveProperty",
  "toThrow",
]);
const supportedNodeAssertions = new Set(["ok", "equal", "strictEqual"]);
const isProxy = types.isProxy.bind(types);
const descriptorsOf = Object.getOwnPropertyDescriptors.bind(Object);
const prototypeOf = Object.getPrototypeOf.bind(Object);
function refuse() {
  throw new Error("ASSERTLEDGER_BUN_NATIVE_ACTIVE_OR_UNQUALIFIED_INPUT");
}
function passive(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === "function") refuse();
  if (value === null || typeof value !== "object") return;
  if (depth > 64 || isProxy(value)) refuse();
  if (seen.has(value)) return;
  seen.add(value);
  const prototype = prototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
    refuse();
  const descriptors = descriptorsOf(value);
  for (const descriptor of Reflect.ownKeys(descriptors).map((key) => descriptors[key])) {
    if (!("value" in descriptor)) refuse();
    passive(descriptor.value, seen, depth + 1);
  }
}
function passiveThrown(value) {
  if (value === null || typeof value !== "object") return passive(value);
  if (isProxy(value) || prototypeOf(value) !== Error.prototype) refuse();
  const descriptors = descriptorsOf(value);
  for (const descriptor of Reflect.ownKeys(descriptors).map((key) => descriptors[key])) {
    if (!("value" in descriptor)) refuse();
    passive(descriptor.value);
  }
}
function validateMatcher(name, arguments_, operand, modifier) {
  if (!supportedMatchers.has(name)) refuse();
  if (name === "toThrow") {
    if (arguments_.length > 1 || (arguments_.length === 1 && typeof arguments_[0] !== "string"))
      refuse();
    if (modifier !== "rejects" && (typeof operand.actual !== "function" || isProxy(operand.actual)))
      refuse();
    return;
  }
  if (name === "toHaveProperty") {
    if (
      arguments_.length < 1 ||
      arguments_.length > 2 ||
      typeof arguments_[0] !== "string" ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u.test(arguments_[0]) ||
      arguments_[0]
        .split(".")
        .some((key) => ["__proto__", "constructor", "prototype"].includes(key))
    )
      refuse();
    if (arguments_.length === 2) passive(arguments_[1]);
  } else {
    if (arguments_.length !== 1) refuse();
    passive(arguments_[0]);
  }
  if (operand.promise === undefined) passive(operand.actual);
  else if (modifier !== "resolves" && modifier !== "rejects") refuse();
}
function wrapExpectation(expectation, operand, modifier) {
  return new Proxy(expectation, {
    get(target, property) {
      if (
        property !== "not" &&
        property !== "resolves" &&
        property !== "rejects" &&
        !supportedMatchers.has(property)
      )
        refuse();
      const value = safeGet(target, property, target);
      if (property === "not" || property === "resolves" || property === "rejects")
        return wrapExpectation(value, operand, property === "not" ? modifier : property);
      return (...arguments_) => {
        validateMatcher(property, arguments_, operand, modifier);
        const id = currentTestId();
        const failed = (error) => {
          if (
            id !== undefined &&
            error !== null &&
            typeof error === "object" &&
            !(error instanceof TypeError) &&
            !(error instanceof RangeError) &&
            !operand.invalidOperand &&
            !operand.userErrors.has(error)
          )
            markIssuingTest(error, id);
          throw error;
        };
        const invoke = () => {
          try {
            const result = safeApply(value, target, arguments_);
            if (operand.invalidOperand) refuse();
            return result && typeof result.then === "function"
              ? Promise.resolve(result).catch(failed)
              : result;
          } catch (error) {
            return failed(error);
          }
        };
        return operand.promise !== undefined && modifier === "resolves"
          ? operand.promise.then((actual) => {
              passive(actual);
              return invoke();
            })
          : operand.promise !== undefined && modifier === "rejects"
            ? operand.promise.then(
                () => invoke(),
                (error) => {
                  passiveThrown(error);
                  return invoke();
                },
              )
            : invoke();
      };
    },
  });
}
const nativeExpect = new Proxy(bunTest.expect, {
  get() {
    refuse();
  },
  apply(target, thisArg, arguments_) {
    if (arguments_.length !== 1 || isProxy(arguments_[0])) refuse();
    const operand = {
      actual: arguments_[0],
      promise: undefined,
      userErrors: new WeakSet(),
      invalidOperand: false,
    };
    if (types.isPromise(operand.actual)) {
      if (prototypeOf(operand.actual) !== Promise.prototype) refuse();
      operand.promise = operand.actual;
    }
    const controlledArguments = [...arguments_];
    if (typeof operand.actual === "function") {
      controlledArguments[0] = (...callbackArguments) => {
        try {
          const result = safeApply(operand.actual, undefined, callbackArguments);
          try {
            passive(result);
          } catch (error) {
            operand.invalidOperand = true;
            throw error;
          }
          return result;
        } catch (error) {
          if (error !== null && typeof error === "object") operand.userErrors.add(error);
          try {
            passiveThrown(error);
          } catch (failure) {
            operand.invalidOperand = true;
            throw failure;
          }
          throw error;
        }
      };
    }
    return wrapExpectation(safeApply(target, thisArg, controlledArguments), operand, undefined);
  },
});
const AssertionError = nodeAssert.AssertionError;
const assertionCache = new WeakMap();
function wrapNodeAssertion(native, name = "ok") {
  if (assertionCache.has(native)) return assertionCache.get(native);
  const wrapper = new Proxy(native, {
    apply(target, thisArg, arguments_) {
      if (!supportedNodeAssertions.has(name)) refuse();
      if (
        arguments_.length < (name === "ok" ? 1 : 2) ||
        arguments_.length > (name === "ok" ? 2 : 3)
      )
        refuse();
      for (const argument of arguments_) passive(argument);
      const id = currentTestId();
      try {
        return safeApply(target, thisArg, arguments_);
      } catch (error) {
        if (id !== undefined && error instanceof AssertionError) markIssuingTest(error, id);
        throw error;
      }
    },
    get(target, property, receiver) {
      const value = safeGet(target, property, receiver);
      return typeof value === "function" &&
        property !== "AssertionError" &&
        property !== "constructor"
        ? wrapNodeAssertion(value, property === "strict" ? "ok" : property)
        : value;
    },
  });
  assertionCache.set(native, wrapper);
  return wrapper;
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

function wrapRegistration(native, cache) {
  if (cache.has(native)) return cache.get(native);
  const wrapper = new Proxy(native, {
    apply(target, thisArg, arguments_) {
      const callbackIndex = arguments_.findIndex(
        (value, index) => typeof value === "function" && (index > 0 || arguments_.length === 1),
      );
      if (callbackIndex < 0) {
        const result = safeApply(target, thisArg, arguments_);
        return typeof result === "function" ? wrapRegistration(result, cache) : result;
      }
      const callback = arguments_[callbackIndex];
      const file = registrationFile();
      const wrappedArguments = [...arguments_];
      wrappedArguments[callbackIndex] = function (...callbackArguments) {
        const id = randomUUID();
        record({ kind: "found", id, file });
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
              owned: issuingTest(error) === id,
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
        ? wrapRegistration(value.bind(target), cache)
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
bunTest.mock.module("bun:test", () => ({
  ...bunTest,
  expect: nativeExpect,
  test: wrappedTest,
  it: wrappedIt,
  beforeAll: wrapHook(bunTest.beforeAll),
  afterAll: wrapHook(bunTest.afterAll),
  beforeEach: wrapHook(bunTest.beforeEach),
  afterEach: wrapHook(bunTest.afterEach),
}));
const wrappedNodeTest = wrapRegistration(nodeTest.test, cache);
bunTest.mock.module("node:test", () => ({
  ...nodeTest,
  default: wrappedNodeTest,
  test: wrappedNodeTest,
  it: wrapRegistration(nodeTest.it, cache),
  before: wrapHook(nodeTest.before),
  after: wrapHook(nodeTest.after),
  beforeEach: wrapHook(nodeTest.beforeEach),
  afterEach: wrapHook(nodeTest.afterEach),
}));
const controlledNodeAssert = wrapNodeAssertion(nodeAssert);
bunTest.mock.module("node:assert/strict", () => ({
  ...nodeAssert,
  ...Object.fromEntries(
    Object.entries(nodeAssert).map(([name, value]) => [
      name,
      typeof value === "function" && name !== "AssertionError"
        ? wrapNodeAssertion(value, name)
        : value,
    ]),
  ),
  default: controlledNodeAssert,
}));
record({ kind: "ready" });
