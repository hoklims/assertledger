import { builtinModules } from "node:module";
import path from "node:path";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { portablePathKey } from "../core/index.js";

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
export function scanModuleSpecifiers(source: string): SpecifierScan {
  const tokens: Array<{ kind: SyntaxKind; text: string; value: string }> = [];
  const scanner = createScanner(true, undefined, source);
  const templateExpressionBraceDepths: number[] = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    const tokenStart = scanner.getTokenStart();
    if (scanner.getTokenEnd() <= tokenStart) {
      scanner.resetTokenState(Math.min(source.length, tokenStart + 1));
      continue;
    }
    const templateDepthIndex = templateExpressionBraceDepths.length - 1;
    if (
      kind === SyntaxKind.CloseBraceToken &&
      templateDepthIndex >= 0 &&
      templateExpressionBraceDepths[templateDepthIndex] === 0
    ) {
      kind = scanner.reScanTemplateToken(false);
      tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() });
      if (kind === SyntaxKind.TemplateTail) templateExpressionBraceDepths.pop();
      continue;
    }
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() });
    if (kind === SyntaxKind.TemplateHead) {
      templateExpressionBraceDepths.push(0);
    } else if (templateDepthIndex >= 0 && kind === SyntaxKind.OpenBraceToken) {
      templateExpressionBraceDepths[templateDepthIndex] =
        (templateExpressionBraceDepths[templateDepthIndex] ?? 0) + 1;
    } else if (templateDepthIndex >= 0 && kind === SyntaxKind.CloseBraceToken) {
      templateExpressionBraceDepths[templateDepthIndex] =
        (templateExpressionBraceDepths[templateDepthIndex] ?? 0) - 1;
    }
  }
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

class RepositoryIndex {
  readonly fileByKey = new Map<string, string>();
  readonly linkByKey = new Map<string, string>();
  readonly sortedFileKeys: string[];
  readonly sortedLinkKeys: string[];

  constructor(files: readonly string[], links: readonly string[]) {
    for (const file of files) this.fileByKey.set(portablePathKey(file), file);
    for (const link of links) this.linkByKey.set(portablePathKey(link), link);
    this.sortedFileKeys = [...this.fileByKey.keys()].sort();
    this.sortedLinkKeys = [...this.linkByKey.keys()].sort();
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
  ) {}

  addFile(file: string): void {
    if (this.files.has(file)) return;
    this.files.add(file);
    if (!withinNodeModules(file)) this.queue.push(file);
  }

  /** Adds an existing file, a link on its path, or nothing. Returns whether it was found. */
  include(candidate: string): boolean {
    const link = this.index.linkOnPath(candidate);
    if (link !== undefined) {
      this.links.add(link);
      return true;
    }
    const file = this.index.file(candidate);
    if (file === undefined) return false;
    this.addFile(file);
    return true;
  }

  /** Resolves a path the way a bundler does: exact, with an extension, or a directory index. */
  includeModulePath(base: string): boolean {
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
    for (const link of belowLinks) this.links.add(link);
    for (const file of below) this.addFile(file);
    return true;
  }

  /** A dependency package is kept whole and its declared dependencies are followed. */
  async includePackage(directory: string, read: TestClosureInput["read"]): Promise<boolean> {
    const link = this.index.linkOnPath(directory);
    if (link !== undefined) {
      this.links.add(link);
      return true;
    }
    const files = this.index.filesUnder(directory);
    const links = this.index.linksUnder(directory);
    if (files.length === 0 && links.length === 0) return false;
    const key = portablePathKey(directory);
    if (this.packages.has(key)) return true;
    this.packages.add(key);
    for (const found of links) this.links.add(found);
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
    if (mapped) return;
    const { name, subpath } = packageName(specifier);
    const workspace = this.workspaces.get(name);
    if (workspace !== undefined) {
      // A workspace package is repository source: keep every file of it and scan them.
      this.includeModulePath(subpath === "" ? workspace : `${workspace}/${subpath}`);
      for (const link of this.index.linksUnder(workspace)) this.links.add(link);
      for (const found of this.index.filesUnder(workspace)) this.addFile(found);
    }
    const directory = path.posix.dirname(file);
    // The runtime reaches a workspace package through node_modules too: an installed link there
    // is on the resolution path.
    // Absent from the inventory, a package is external: its directory is not repository content.
    await this.includeNodeModule(directory === "." ? "" : directory, name, read);
  }
}

async function tsconfigMappings(
  index: RepositoryIndex,
  read: TestClosureInput["read"],
): Promise<PathMapping[]> {
  const mappings: PathMapping[] = [];
  const configs = [...index.fileByKey.values()].filter((file) => {
    const base = path.posix.basename(file).toLowerCase();
    return (
      !withinNodeModules(file) &&
      (base === "jsconfig.json" || (base.startsWith("tsconfig") && base.endsWith(".json")))
    );
  });
  for (const config of configs.sort()) {
    for (const text of await read(config)) {
      let document: unknown;
      try {
        document = parseJsonWithComments(text);
      } catch {
        continue;
      }
      const options = isRecord(document) ? document.compilerOptions : undefined;
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
  const index = new RepositoryIndex(input.files, input.links);
  const walk = new ClosureWalk(
    index,
    await tsconfigMappings(index, input.read),
    await workspacePackages(index, input.read),
  );
  for (const root of input.roots) walk.include(root);
  const scanned = new Set<string>();
  const configurations = new Set<string>();
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
    if (!SCANNED_EXTENSIONS.includes(path.posix.extname(file).toLowerCase())) continue;
    for (const text of await input.read(file)) {
      const scan = scanModuleSpecifiers(text);
      if (scan.nonLiteral) walk.markUnbounded(file, "NON_LITERAL_MODULE_SPECIFIER");
      for (const specifier of [...scan.specifiers].sort()) {
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

/** Preload modules a root `bunfig.toml` declares for `bun test`; undefined when unreadable. */
export function bunTestPreloads(bunfig: string): string[] | undefined {
  const preloads: string[] = [];
  const assignments = [...bunfig.matchAll(/^\s*preload\s*=\s*(.*)$/gmu)];
  for (const assignment of assignments) {
    const value = (assignment[1] ?? "").trim();
    const strings = [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/gu)].map(
      (match) => match[1] ?? match[2] ?? "",
    );
    const literal = value.startsWith("[") ? value.endsWith("]") : strings.length === 1;
    if (!literal || strings.length === 0) return undefined;
    preloads.push(...strings);
  }
  return preloads;
}
