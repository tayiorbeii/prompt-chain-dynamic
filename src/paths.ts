import path from "node:path";

const HIGH_RISK_ROOT_FILES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.toml",
  "cargo.lock",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "poetry.lock",
  "requirements.txt",
  "tsconfig.json",
  "turbo.json",
  "nx.json",
  "vite.config.ts",
  "vite.config.js",
  "next.config.ts",
  "next.config.js",
]);

export function normalizeRepoPath(input: string): string {
  const value = input.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!value) throw new Error("path is empty");
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) {
    throw new Error(`absolute path is not allowed: ${input}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`parent traversal is not allowed: ${input}`);
  }
  if (normalized === ".") throw new Error("repository root is not a valid concrete path");
  return normalized;
}

export function isConcretePath(value: string): boolean {
  return !value.includes("*") && !value.includes("?") && !value.includes("{") && !value.includes("}");
}

export function isHighRiskPath(value: string): boolean {
  const normalized = normalizeRepoPath(value).toLowerCase();
  const base = path.posix.basename(normalized);
  return HIGH_RISK_ROOT_FILES.has(base)
    || /(^|\/)migrations?(\/|$)/.test(normalized)
    || /(^|\/)(schema|schemas|shared-types|types)(\/|\.|$)/.test(normalized)
    || /(^|\/)__snapshots__(\/|$)/.test(normalized)
    || /\.(snap|snapshot)$/.test(normalized)
    || /(^|\/)(auth|authorization|billing|payments?|secrets?)(\/|\.|$)/.test(normalized);
}

export function patternCoversPath(patternInput: string, pathInput: string): boolean {
  const pattern = normalizeRepoPath(patternInput);
  const candidate = normalizeRepoPath(pathInput);
  if (pattern === candidate) return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3).replace(/\/$/, "");
    return candidate === prefix || candidate.startsWith(`${prefix}/`);
  }
  if (!pattern.includes("*")) return false;
  const expression = globToRegExp(pattern);
  return expression.test(candidate);
}

export function pathsMayOverlap(aInput: string, bInput: string): boolean {
  const a = normalizeRepoPath(aInput);
  const b = normalizeRepoPath(bInput);
  if (a === b) return true;
  if (isConcretePath(a) && isConcretePath(b)) return false;
  if (a.endsWith("/**")) {
    const prefix = a.slice(0, -3).replace(/\/$/, "");
    if (b === prefix || b.startsWith(`${prefix}/`)) return true;
  }
  if (b.endsWith("/**")) {
    const prefix = b.slice(0, -3).replace(/\/$/, "");
    if (a === prefix || a.startsWith(`${prefix}/`)) return true;
  }
  if (isConcretePath(a)) return patternCoversPath(b, a);
  if (isConcretePath(b)) return patternCoversPath(a, b);
  return staticPrefix(a) === staticPrefix(b) || staticPrefix(a).startsWith(`${staticPrefix(b)}/`) || staticPrefix(b).startsWith(`${staticPrefix(a)}/`);
}

export function assertPathCovered(pathValue: string, allowed: string[]): boolean {
  return allowed.some((pattern) => patternCoversPath(pattern, pathValue));
}

export function uniquePaths(values: string[]): string[] {
  return [...new Set(values.map(normalizeRepoPath))].sort();
}

function staticPrefix(pattern: string): string {
  const firstGlob = pattern.search(/[?*{]/);
  if (firstGlob < 0) return pattern;
  return pattern.slice(0, firstGlob).replace(/\/$/, "");
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char ?? "");
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
