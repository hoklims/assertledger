import { builtinModules } from "node:module";
import path from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import { designatedBunConfig } from "../../integrations/bun/driver.mjs";
import { portablePathKey } from "../core/index.js";
import { scanJavaScriptTokens } from "./javascript-tokens.js";

/**
 * The static module closure of the tests an adapter executes. A repository link inside it refuses
 * the repository; a link outside it can be left out of the snapshot. The closure follows literal
 * module specifiers only and records every file whose computed `import()` or `require()` makes it
 * unbounded, so that a campaign keeps every link refusal for such a closure. Files read at run time
 * through the file system, spawned processes and workers are not module edges and are not followed.
 */
export interface TestClosureInput {
  /** Regular files of the inventory, as `/`-separated paths relative to the repository root. */
  files: readonly string[];
  /** Repository links, in the same form. None is followed. */
  links: readonly string[];
  /** Entry points: the tests and the files the runner loads for them. */
  roots: readonly string[];
  /** Every text the path can hold during the campaign: the repository bytes and each overlay. */
  read: (file: string) => Promise<readonly string[]>;
  /**
   * With this map the closure follows repository-internal links, as Bun resolves modules through
   * real paths: each link is recorded and its target, a `/`-separated path from the root, is walked
   * instead. Without it, or for a link absent from it, a link stops the walk and is only recorded.
   */
  linkTargets?: ReadonlyMap<string, string>;
  /**
   * Specifiers the runner provides itself. `bun test` answers `vitest` and `@jest/globals` with its
   * own test API, so their installed packages are not on the closure.
   */
  runnerModules?: ReadonlySet<string>;
  /** Existing regular directories, including empty runtime inputs. */
  directories?: readonly string[];
}

export interface UnboundedClosureEdge {
  file: string;
  reason:
    | "NON_LITERAL_MODULE_SPECIFIER"
    | "ABSOLUTE_MODULE_SPECIFIER"
    | "MODULE_OUTSIDE_REPOSITORY"
    | "TEST_PRELOAD_UNREADABLE";
}

/** The literal closure, its links, and the edges that leave it unbounded (sorted, unique). */
export interface TestClosure {
  files: string[];
  links: string[];
  unbounded: UnboundedClosureEdge[];
}

const SCANNED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const RESOLVED_EXTENSIONS = [...SCANNED_EXTENSIONS, ".json"];
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

interface SpecifierScan {
  specifiers: Set<string>;
  nonLiteral: boolean;
}

function isLiteralToken(kind: SyntaxKind | undefined): boolean {
  return kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral;
}

/** Literal module specifiers of one JavaScript or TypeScript text, and whether one is computed. */
export function scanModuleSpecifiers(source: string, file?: string): SpecifierScan {
  const tokens = [...scanJavaScriptTokens(source, file)];
  const specifiers = new Set<string>();
  let nonLiteral = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const call = next?.kind === SyntaxKind.OpenParenToken;
    const argument = tokens[index + 2];
    const closesCall =
      tokens[index + 3]?.kind === SyntaxKind.CloseParenToken ||
      tokens[index + 3]?.kind === SyntaxKind.CommaToken;
    // `require(x)`, and Bun's `mock.module(x, factory)`, which resolves x like an import.
    const requireCall =
      (token.kind === SyntaxKind.Identifier || token.kind === SyntaxKind.RequireKeyword) &&
      token.text === "require" &&
      previous?.kind !== SyntaxKind.DotToken;
    const mockModuleCall =
      (token.kind === SyntaxKind.Identifier || token.kind === SyntaxKind.ModuleKeyword) &&
      token.text === "module" &&
      previous?.kind === SyntaxKind.DotToken &&
      tokens[index - 2]?.text === "mock";
    if ((requireCall || mockModuleCall) && call) {
      if (isLiteralToken(argument?.kind) && closesCall) specifiers.add(argument?.value ?? "");
      else nonLiteral = true;
      continue;
    }
    if (token.kind !== SyntaxKind.ImportKeyword && token.kind !== SyntaxKind.ExportKeyword) {
      continue;
    }
    if (token.kind === SyntaxKind.ImportKeyword && call) {
      if (isLiteralToken(argument?.kind) && closesCall) specifiers.add(argument?.value ?? "");
      else nonLiteral = true;
      continue;
    }
    if (isLiteralToken(next?.kind)) {
      specifiers.add(next?.value ?? "");
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const candidate = tokens[cursor];
      if (
        candidate?.kind === SyntaxKind.SemicolonToken ||
        candidate?.kind === SyntaxKind.ImportKeyword ||
        candidate?.kind === SyntaxKind.ExportKeyword
      ) {
        break;
      }
      if (candidate?.text === "from" && isLiteralToken(tokens[cursor + 1]?.kind)) {
        specifiers.add(tokens[cursor + 1]?.value ?? "");
        break;
      }
    }
  }
  specifiers.delete("");
  return { specifiers, nonLiteral };
}

/** Removes comments and trailing commas so that a tsconfig file parses as JSON. */
function parseJsonWithComments(text: string): unknown {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const current = text[index] as string;
    const next = text[index + 1];
    if (current === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
      index += 1;
      output += text.slice(start, index);
    } else if (current === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (current === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
    } else {
      output += current;
      index += 1;
    }
  }
  return JSON.parse(output.replace(/,(\s*[}\]])/gu, "$1"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageName(specifier: string): { name: string; subpath: string } {
  const segments = specifier.split("/");
  const count = specifier.startsWith("@") ? 2 : 1;
  return {
    name: segments.slice(0, count).join("/"),
    subpath: segments.slice(count).join("/"),
  };
}

function withinNodeModules(file: string): boolean {
  return file.split("/").some((segment) => portablePathKey(segment) === "node_modules");
}

interface PathMapping {
  pattern: string;
  targets: string[];
}

/** A path read through the links on it: the real path, or the link the walk could not follow. */
interface ResolvedPath {
  path: string;
  links: string[];
  stopped?: string;
}

/** Link hops followed for one path before the walk stops at the link, as a resolver would. */
const LINK_HOP_LIMIT = 40;

class RepositoryIndex {
  readonly fileByKey = new Map<string, string>();
  readonly linkByKey = new Map<string, string>();
  readonly linkTargetByKey = new Map<string, string>();
  readonly sortedFileKeys: string[];
  readonly sortedLinkKeys: string[];

  constructor(
    files: readonly string[],
    links: readonly string[],
    linkTargets?: ReadonlyMap<string, string>,
  ) {
    for (const file of files) this.fileByKey.set(portablePathKey(file), file);
    for (const link of links) this.linkByKey.set(portablePathKey(link), link);
    for (const [link, target] of linkTargets ?? []) {
      this.linkTargetByKey.set(portablePathKey(link), target);
    }
    this.sortedFileKeys = [...this.fileByKey.keys()].sort();
    this.sortedLinkKeys = [...this.linkByKey.keys()].sort();
  }

  get followsLinks(): boolean {
    return this.linkTargetByKey.size > 0;
  }

  /** Replaces each followable link on the path by its target; stops at any other link. */
  resolve(candidate: string): ResolvedPath {
    const links: string[] = [];
    let current = candidate;
    for (let hop = 0; ; hop += 1) {
      const link = this.linkOnPath(current);
      if (link === undefined) return { path: current, links };
      links.push(link);
      const target = this.linkTargetByKey.get(portablePathKey(link));
      if (target === undefined || hop >= LINK_HOP_LIMIT)
        return { path: current, links, stopped: link };
      const rest = current.slice(link.length);
      current = path.posix.normalize(`${target}${rest}`).replace(/\/$/u, "");
    }
  }

  file(candidate: string): string | undefined {
    return this.fileByKey.get(portablePathKey(candidate));
  }

  /** The link that is the path itself or one of its parent directories, if any. */
  linkOnPath(candidate: string): string | undefined {
    const segments = portablePathKey(candidate).split("/");
    for (let length = 1; length <= segments.length; length += 1) {
      const link = this.linkByKey.get(segments.slice(0, length).join("/"));
      if (link !== undefined) return link;
    }
    return undefined;
  }

  private under(keys: readonly string[], directory: string): string[] {
    const prefix = `${portablePathKey(directory)}/`;
    let low = 0;
    let high = keys.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((keys[middle] as string) < prefix) low = middle + 1;
      else high = middle;
    }
    const found: string[] = [];
    for (let index = low; index < keys.length && keys[index]?.startsWith(prefix); index += 1) {
      found.push(keys[index] as string);
    }
    return found;
  }

  filesUnder(directory: string): string[] {
    return this.under(this.sortedFileKeys, directory).map((key) => this.fileByKey.get(key) ?? key);
  }

  linksUnder(directory: string): string[] {
    return this.under(this.sortedLinkKeys, directory).map((key) => this.linkByKey.get(key) ?? key);
  }
}

class ClosureWalk {
  readonly files = new Set<string>();
  readonly links = new Set<string>();
  readonly packages = new Set<string>();
  readonly queue: string[] = [];
  readonly unbounded = new Map<string, UnboundedClosureEdge>();

  markUnbounded(file: string, reason: UnboundedClosureEdge["reason"]): void {
    this.unbounded.set(`${file}|${reason}`, { file, reason });
  }

  constructor(
    readonly index: RepositoryIndex,
    readonly mappings: readonly PathMapping[],
    readonly workspaces: ReadonlyMap<string, string>,
    readonly runnerModules: ReadonlySet<string> = new Set(),
  ) {}

  addFile(file: string): void {
    if (this.files.has(file)) return;
    this.files.add(file);
    if (!withinNodeModules(file)) this.queue.push(file);
  }

  /** The real path of `candidate`, recording every link read; undefined at an unfollowable link. */
  realPath(candidate: string): string | undefined {
    const resolved = this.index.resolve(candidate);
    for (const link of resolved.links) this.links.add(link);
    return resolved.stopped === undefined ? resolved.path : undefined;
  }

  /** Adds an existing file, a link on its path, or nothing. Returns whether it was found. */
  include(candidate: string): boolean {
    const real = this.realPath(candidate);
    if (real === undefined) return true;
    const file = this.index.file(real);
    if (file === undefined) return false;
    this.addFile(file);
    return true;
  }

  /**
   * Keeps the links below a directory the way the runtime can reach them. Without link following
   * every one is recorded. With it, a dependency link inside a nested node_modules is left to
   * module resolution, and any other link is followed and its target kept whole.
   */
  includeLinksUnder(directory: string): void {
    for (const link of this.index.linksUnder(directory)) {
      if (!this.index.followsLinks) {
        this.links.add(link);
        continue;
      }
      const below = link.slice(directory.length + 1);
      if (below.split("/").some((segment) => portablePathKey(segment) === "node_modules")) continue;
      const real = this.realPath(link);
      if (real === undefined || this.followedTrees.has(portablePathKey(real))) continue;
      this.followedTrees.add(portablePathKey(real));
      if (!this.include(real)) {
        for (const file of this.index.filesUnder(real)) this.addFile(file);
        this.includeLinksUnder(real);
      }
    }
  }

  readonly followedTrees = new Set<string>();

  /** Resolves a path the way a bundler does: exact, with an extension, or a directory index. */
  includeModulePath(requested: string): boolean {
    const base = this.realPath(requested);
    if (base === undefined) return true;
    const extension = path.posix.extname(base);
    const alternatives = [".js", ".jsx", ".mjs", ".cjs"].includes(extension)
      ? [".ts", ".tsx", ".mts", ".cts"].map(
          (replacement) => base.slice(0, -extension.length) + replacement,
        )
      : [];
    const candidates = [
      base,
      ...alternatives,
      ...RESOLVED_EXTENSIONS.map((suffix) => `${base}${suffix}`),
      ...RESOLVED_EXTENSIONS.map((suffix) => `${base}/index${suffix}`),
    ];
    for (const candidate of candidates) if (this.include(candidate)) return true;
    // A directory without an index resolves through its package.json: keep all of it.
    const below = this.index.filesUnder(base);
    const belowLinks = this.index.linksUnder(base);
    if (below.length === 0 && belowLinks.length === 0) return false;
    this.includeLinksUnder(base);
    for (const file of below) this.addFile(file);
    return true;
  }

  /** A dependency package is kept whole and its declared dependencies are followed. */
  async includePackage(requested: string, read: TestClosureInput["read"]): Promise<boolean> {
    const directory = this.realPath(requested);
    if (directory === undefined) return true;
    const files = this.index.filesUnder(directory);
    const links = this.index.linksUnder(directory);
    if (files.length === 0 && links.length === 0) return false;
    const key = portablePathKey(directory);
    if (this.packages.has(key)) return true;
    this.packages.add(key);
    this.includeLinksUnder(directory);
    for (const file of files) this.files.add(file);
    const manifest = this.index.file(`${directory}/package.json`);
    if (manifest === undefined) return true;
    for (const text of await read(manifest)) {
      let document: unknown;
      try {
        document = JSON.parse(text);
      } catch {
        continue;
      }
      if (!isRecord(document)) continue;
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        const declared = document[field];
        if (!isRecord(declared)) continue;
        for (const name of Object.keys(declared)) {
          await this.includeNodeModule(directory, name, read);
        }
      }
    }
    return true;
  }

  async includeNodeModule(
    fromDirectory: string,
    name: string,
    read: TestClosureInput["read"],
  ): Promise<boolean> {
    let directory = fromDirectory;
    for (;;) {
      const candidate =
        directory === "" ? `node_modules/${name}` : `${directory}/node_modules/${name}`;
      if (await this.includePackage(candidate, read)) return true;
      if (directory === "") return false;
      const parent = path.posix.dirname(directory);
      directory = parent === "." ? "" : parent;
    }
  }

  async resolve(file: string, specifier: string, read: TestClosureInput["read"]): Promise<void> {
    if (BUILTINS.has(specifier) || specifier === "bun" || specifier.startsWith("bun:")) return;
    if (this.runnerModules.has(specifier)) return;
    if (specifier.startsWith("#")) {
      await this.resolvePackageImport(file, specifier, read);
      return;
    }
    if (specifier.startsWith("node:")) return;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier) || specifier.startsWith("/")) {
      this.markUnbounded(file, "ABSOLUTE_MODULE_SPECIFIER");
      return;
    }
    if (specifier === "." || specifier === ".." || /^\.\.?\//u.test(specifier)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (base === ".." || base.startsWith("../")) {
        this.markUnbounded(file, "MODULE_OUTSIDE_REPOSITORY");
        return;
      }
      this.includeModulePath(base.replace(/\/$/u, ""));
      return;
    }
    let mapped = false;
    for (const mapping of this.mappings) {
      const star = mapping.pattern.indexOf("*");
      let capture: string | undefined;
      if (star < 0) {
        if (specifier === mapping.pattern) capture = "";
      } else {
        const prefix = mapping.pattern.slice(0, star);
        const suffix = mapping.pattern.slice(star + 1);
        if (
          specifier.length >= prefix.length + suffix.length &&
          specifier.startsWith(prefix) &&
          specifier.endsWith(suffix)
        ) {
          capture = specifier.slice(prefix.length, specifier.length - suffix.length);
        }
      }
      if (capture === undefined) continue;
      for (const target of mapping.targets) {
        const resolved = path.posix.normalize(target.replace("*", capture));
        if (resolved === ".." || resolved.startsWith("../")) {
          this.markUnbounded(file, "MODULE_OUTSIDE_REPOSITORY");
          return;
        }
        if (this.includeModulePath(resolved)) mapped = true;
      }
    }
    // The mappings come from every tsconfig, while the runtime applies only the one that governs
    // the importing file: following links, the installed package stays on the resolution path too.
    if (mapped && !this.index.followsLinks) return;
    const { name, subpath } = packageName(specifier);
    const workspace = this.workspaces.get(name);
    if (workspace !== undefined) {
      // A workspace package is repository source: keep every file of it and scan them.
      this.includeModulePath(subpath === "" ? workspace : `${workspace}/${subpath}`);
      this.includeLinksUnder(workspace);
      for (const found of this.index.filesUnder(workspace)) this.addFile(found);
    }
    const directory = path.posix.dirname(file);
    // The runtime reaches a workspace package through node_modules too: an installed link there
    // is on the resolution path.
    // Absent from the inventory, a package is external: its directory is not repository content.
    await this.includeNodeModule(directory === "." ? "" : directory, name, read);
  }

  async resolvePackageImport(
    file: string,
    specifier: string,
    read: TestClosureInput["read"],
  ): Promise<void> {
    let directory = path.posix.dirname(file);
    for (;;) {
      const manifest = this.index.file(
        directory === "." ? "package.json" : `${directory}/package.json`,
      );
      if (manifest !== undefined) {
        this.addFile(manifest);
        for (const text of await read(manifest)) {
          const document: unknown = JSON.parse(text);
          const imports = isRecord(document) ? document.imports : undefined;
          if (!isRecord(imports)) throw new Error("TEST_CLOSURE_PACKAGE_IMPORT_UNSUPPORTED");
          const matching = Object.keys(imports)
            .filter((key) => {
              const star = key.indexOf("*");
              return star < 0
                ? key === specifier
                : specifier.startsWith(key.slice(0, star)) &&
                    specifier.endsWith(key.slice(star + 1)) &&
                    specifier.length >= key.length - 1;
            })
            .sort((a, b) =>
              a === specifier
                ? -1
                : b === specifier
                  ? 1
                  : b.indexOf("*") - a.indexOf("*") || b.length - a.length,
            );
          const key = matching[0];
          if (key === undefined) throw new Error("TEST_CLOSURE_PACKAGE_IMPORT_UNSUPPORTED");
          const star = key.indexOf("*");
          const capture =
            star < 0 ? "" : specifier.slice(star, specifier.length - (key.length - star - 1));
          const targets = (value: unknown): string[] => {
            if (typeof value === "string") return [value];
            if (Array.isArray(value)) return value.flatMap(targets);
            if (isRecord(value)) return Object.values(value).flatMap(targets);
            if (value === null) return [];
            throw new Error("TEST_CLOSURE_PACKAGE_IMPORT_UNSUPPORTED");
          };
          const resolved = targets(imports[key]);
          if (resolved.length === 0) throw new Error("TEST_CLOSURE_PACKAGE_IMPORT_UNSUPPORTED");
          for (const target of resolved) {
            // Follow all conditional branches conservatively; unsupported external/recursive
            // aliases must refuse before a closure snapshot can silently omit runtime inputs.
            if (!target.startsWith("./"))
              throw new Error("TEST_CLOSURE_PACKAGE_IMPORT_UNSUPPORTED");
            const relative = path.posix.normalize(
              path.posix.join(directory, target.replaceAll("*", capture)),
            );
            if (
              relative.startsWith("../") ||
              relative === ".." ||
              !this.includeModulePath(relative)
            ) {
              throw new Error("TEST_CLOSURE_PACKAGE_IMPORT_UNSUPPORTED");
            }
          }
        }
        return;
      }
      if (directory === ".") throw new Error("TEST_CLOSURE_PACKAGE_IMPORT_UNSUPPORTED");
      directory = path.posix.dirname(directory);
    }
  }
}

async function tsconfigMappings(
  index: RepositoryIndex,
  read: TestClosureInput["read"],
  jsxSources: Set<string>,
): Promise<PathMapping[]> {
  const mappings: PathMapping[] = [];
  const configs = [...index.fileByKey.values()].filter((file) => {
    const base = path.posix.basename(file).toLowerCase();
    return (
      !withinNodeModules(file) &&
      (base === "jsconfig.json" || (base.startsWith("tsconfig") && base.endsWith(".json")))
    );
  });
  const seen = new Set<string>();
  for (const config of configs.sort()) {
    if (seen.has(config)) continue;
    seen.add(config);
    for (const text of await read(config)) {
      let document: unknown;
      try {
        document = parseJsonWithComments(text);
      } catch {
        continue;
      }
      for (const specifier of tsconfigExtends(text)) {
        let directory = path.posix.dirname(config);
        let inherited: string | undefined;
        let stopped = false;
        for (;;) {
          const candidate = specifier.startsWith(".")
            ? path.posix.join(directory, specifier)
            : path.posix.join(directory, "node_modules", specifier);
          const resolved = index.resolve(candidate);
          if (resolved.stopped !== undefined) {
            stopped = true;
            break;
          }
          inherited =
            index.file(resolved.path) ??
            index.file(`${resolved.path}.json`) ??
            index.file(`${resolved.path}/tsconfig.json`);
          if (inherited !== undefined || specifier.startsWith(".") || directory === ".") break;
          directory = path.posix.dirname(directory);
        }
        if (inherited !== undefined) configs.push(inherited);
        else if (!stopped) throw new Error("TEST_CLOSURE_TSCONFIG_EXTENDS_UNSUPPORTED");
      }
      const options = isRecord(document) ? document.compilerOptions : undefined;
      if (isRecord(options) && typeof options.jsxImportSource === "string") {
        jsxSources.add(options.jsxImportSource);
      }
      if (!isRecord(options) || !isRecord(options.paths)) continue;
      const directory = path.posix.dirname(config);
      const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : ".";
      const base = path.posix.normalize(path.posix.join(directory, baseUrl));
      for (const [pattern, targets] of Object.entries(options.paths)) {
        if (!Array.isArray(targets)) continue;
        mappings.push({
          pattern,
          targets: targets
            .filter((target): target is string => typeof target === "string")
            .map((target) => path.posix.join(base, target)),
        });
      }
    }
  }
  return mappings;
}

async function workspacePackages(
  index: RepositoryIndex,
  read: TestClosureInput["read"],
): Promise<Map<string, string>> {
  const packages = new Map<string, string>();
  for (const file of [...index.fileByKey.values()].sort()) {
    if (path.posix.basename(file) !== "package.json" || withinNodeModules(file)) continue;
    const directory = path.posix.dirname(file);
    if (directory === ".") continue;
    for (const text of await read(file)) {
      try {
        const document = JSON.parse(text) as unknown;
        if (isRecord(document) && typeof document.name === "string") {
          packages.set(document.name, directory);
        }
      } catch {
        // An unreadable manifest names no package; its directory stays reachable by path.
      }
    }
  }
  return packages;
}

/** Computes the module closure of `roots`. */
export async function computeTestClosure(input: TestClosureInput): Promise<TestClosure> {
  const index = new RepositoryIndex(input.files, input.links, input.linkTargets);
  const jsxSources = new Set(["react"]);
  const walk = new ClosureWalk(
    index,
    await tsconfigMappings(index, input.read, jsxSources),
    await workspacePackages(index, input.read),
    input.runnerModules,
  );
  for (const root of input.roots) walk.include(root);
  const scanned = new Set<string>();
  const configurations = new Set<string>();
  const compilerConfigurations = new Set<string>();
  while (walk.queue.length > 0) {
    const file = walk.queue.shift() as string;
    if (scanned.has(file)) continue;
    scanned.add(file);
    // Every directory up to the root can hold the package.json or tsconfig that configures it,
    // and a bunfig.toml whose test preloads run before every test.
    let directory = path.posix.dirname(file);
    for (;;) {
      for (const name of ["package.json", "tsconfig.json", "jsconfig.json", "bunfig.toml"]) {
        const configuration = directory === "." ? name : `${directory}/${name}`;
        walk.include(configuration);
        const found = index.file(configuration);
        if (name !== "bunfig.toml" || found === undefined || configurations.has(found)) continue;
        configurations.add(found);
        for (const text of await input.read(found)) {
          const jsxSource = bunJsxImportSource(text);
          if (jsxSource !== undefined) jsxSources.add(jsxSource);
          const preloads = bunTestPreloads(text);
          if (preloads === undefined) {
            walk.markUnbounded(found, "TEST_PRELOAD_UNREADABLE");
            continue;
          }
          for (const preload of preloads) await walk.resolve(found, preload, input.read);
        }
      }
      if (directory === ".") break;
      directory = path.posix.dirname(directory);
    }
    // The walk also keeps what Bun reads to compile a file: each configuration a
    // tsconfig or jsconfig extends, and the automatic JSX runtime a .tsx or .jsx file imports.
    if (isProjectConfiguration(file) || compilerConfigurations.has(file)) {
      for (const text of await input.read(file)) {
        for (const specifier of tsconfigExtends(text)) {
          const previous = new Set(walk.files);
          await walk.resolve(file, specifier, input.read);
          for (const added of walk.files) {
            if (!previous.has(added) && added.endsWith(".json")) compilerConfigurations.add(added);
          }
        }
      }
      continue;
    }
    if (!SCANNED_EXTENSIONS.includes(path.posix.extname(file).toLowerCase())) continue;
    for (const text of await input.read(file)) {
      const scan = scanModuleSpecifiers(text, file);
      if (scan.nonLiteral) walk.markUnbounded(file, "NON_LITERAL_MODULE_SPECIFIER");
      const fileJsxSources = new Set(jsxSources);
      for (const directive of text.matchAll(/@jsxImportSource\s+([^\s*]+)/gu)) {
        fileJsxSources.add(directive[1] as string);
      }
      const implicit = /\.[jt]sx$/iu.test(file)
        ? [...fileJsxSources].flatMap((source) => [
            `${source}/jsx-dev-runtime`,
            `${source}/jsx-runtime`,
          ])
        : [];
      for (const specifier of [...new Set([...scan.specifiers, ...implicit])].sort()) {
        await walk.resolve(file, specifier, input.read);
      }
    }
  }
  return {
    files: [...walk.files].sort(),
    links: [...walk.links].sort(),
    unbounded: [...walk.unbounded.values()].sort((left, right) =>
      left.file === right.file
        ? left.reason < right.reason
          ? -1
          : 1
        : left.file < right.file
          ? -1
          : 1,
    ),
  };
}

/**
 * The files and links below each operator path, read through followable links. A path that names
 * no file, directory or link is missing. Nothing below a path is left out.
 */
export function expandIncludedPaths(
  input: Pick<TestClosureInput, "files" | "links" | "linkTargets" | "directories">,
  paths: readonly string[],
): { files: string[]; links: string[]; directories: string[]; missing: string[] } {
  const index = new RepositoryIndex(input.files, input.links, input.linkTargets);
  const files = new Set<string>();
  const links = new Set<string>();
  const directories = new Set<string>();
  const visited = new Set<string>();
  const visit = (candidate: string): boolean => {
    const resolved = index.resolve(candidate);
    for (const link of resolved.links) links.add(link);
    if (resolved.stopped !== undefined) return true;
    const key = portablePathKey(resolved.path);
    if (visited.has(key)) return true;
    visited.add(key);
    const file = index.file(resolved.path);
    if (file !== undefined) {
      files.add(file);
      return true;
    }
    const below = index.filesUnder(resolved.path);
    const belowLinks = index.linksUnder(resolved.path);
    const selectedDirectories = (input.directories ?? []).filter(
      (directory) =>
        portablePathKey(directory) === key || portablePathKey(directory).startsWith(`${key}/`),
    );
    if (below.length === 0 && belowLinks.length === 0 && selectedDirectories.length === 0)
      return false;
    for (const directory of selectedDirectories) directories.add(directory);
    for (const found of below) files.add(found);
    for (const link of belowLinks) visit(link);
    return true;
  };
  const missing = paths.filter((entry) => !visit(entry));
  return {
    files: [...files].sort(),
    links: [...links].sort(),
    directories: [...directories].sort(),
    missing,
  };
}

function isProjectConfiguration(file: string): boolean {
  const base = path.posix.basename(file).toLowerCase();
  return base === "jsconfig.json" || (base.startsWith("tsconfig") && base.endsWith(".json"));
}

/** The configurations a tsconfig or jsconfig extends, as module specifiers from its directory. */
function tsconfigExtends(text: string): string[] {
  let document: unknown;
  try {
    document = parseJsonWithComments(text);
  } catch {
    return [];
  }
  const value = isRecord(document) ? document.extends : undefined;
  const entries = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return entries
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .map((entry) => (entry === "." || entry === ".." ? `${entry}/tsconfig.json` : entry));
}

/** Supported top-level Bun JSX source strings; other tables cannot set this option. */
function bunJsxImportSource(text: string): string | undefined {
  let source: string | undefined;
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*\[/u.test(line)) break;
    const assignment =
      /^\s*(?:jsxImportSource|"jsxImportSource"|'jsxImportSource')\s*=\s*(.*)$/u.exec(line);
    if (assignment === null) continue;
    const value = assignment[1] ?? "";
    const basic = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/u.exec(value);
    const literal = /^'([^']*)'\s*(?:#.*)?$/u.exec(value);
    try {
      source = basic === null ? literal?.[1] : JSON.parse(basic[1] as string);
    } catch {
      throw new Error("TEST_CLOSURE_BUNFIG_JSX_UNSUPPORTED");
    }
    if (source === undefined || source.length === 0) {
      throw new Error("TEST_CLOSURE_BUNFIG_JSX_UNSUPPORTED");
    }
  }
  return source;
}

/** Preload modules a root `bunfig.toml` declares for `bun test`; undefined when unreadable. */
export function bunTestPreloads(bunfig: string): string[] | undefined {
  const marker = "./__assertledger_closure_preload__.mjs";
  try {
    // Share the runner's parser so every supported multiline/string/escape spelling has the
    // same closure, and top-level preload settings cannot become test module edges.
    const rewritten = designatedBunConfig(bunfig, marker);
    for (const match of rewritten.matchAll(/^preload = (\[.*\])$/gmu)) {
      const entries = JSON.parse(match[1] as string) as string[];
      if (entries[0] === marker) return entries.slice(1);
    }
  } catch {
    return undefined;
  }
  return undefined;
}
