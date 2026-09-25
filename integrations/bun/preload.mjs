import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAssertSameFailure } from "./bun.mjs";
import * as bunTest from "bun:test";

const root = process.env.ASSERTLEDGER_BUN_ROOT;
const eventsFile = process.env.ASSERTLEDGER_BUN_EVENTS_FILE;
if (!path.isAbsolute(root ?? "") || !path.isAbsolute(eventsFile ?? "")) {
  throw new Error("ASSERTLEDGER_BUN_PRELOAD_CONFIGURATION_INVALID");
}

const preloadPath = fileURLToPath(import.meta.url);
const verifyIssuedError = isAssertSameFailure;
function record(event) {
  appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
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
        const result = Reflect.apply(target, thisArg, arguments_);
        return typeof result === "function" ? wrapRegistration(result, cache) : result;
      }
      const callback = arguments_[callbackIndex];
      const id = randomUUID();
      record({ kind: "found", id, file: registrationFile() });
      const wrappedArguments = [...arguments_];
      wrappedArguments[callbackIndex] = function (...callbackArguments) {
        const passed = (value) => {
          record({ kind: "end", id, status: "pass" });
          return value;
        };
        const failed = (error) => {
          record({
            kind: "end",
            id,
            status: "fail",
            owned: verifyIssuedError(error),
          });
          throw error;
        };
        try {
          const result = Reflect.apply(callback, this, callbackArguments);
          return result && typeof result.then === "function"
            ? Promise.resolve(result).then(passed, failed)
            : passed(result);
        } catch (error) {
          return failed(error);
        }
      };
      return Reflect.apply(target, thisArg, wrappedArguments);
    },
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" && property !== "constructor"
        ? wrapRegistration(value.bind(target), cache)
        : value;
    },
  });
  cache.set(native, wrapper);
  return wrapper;
}

const cache = new WeakMap();
const wrappedTest = wrapRegistration(bunTest.test, cache);
const wrappedIt = wrapRegistration(bunTest.it, cache);
bunTest.mock.module("bun:test", () => ({ ...bunTest, test: wrappedTest, it: wrappedIt }));
