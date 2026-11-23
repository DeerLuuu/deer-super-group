/**
 * RC1-0 React Compiler boundary.
 *
 * This module is intentionally pure data/config: it is imported by
 * vite.config.ts and by the boundary test, but never by renderer runtime code.
 * Only an explicit allowlist is compiled, and only for renderer builds.
 */
export const REACT_COMPILER_PACKAGE = "babel-plugin-react-compiler";
export const REACT_COMPILER_VERSION = "1.0.0";
export const REACT_COMPILER_LICENSE = "MIT";

/** RC1-1 annotation pilot: non-Dock, non-critical presentational components. */
export const REACT_COMPILER_ALLOWLIST = [
  "src/shell/SkipLink.tsx",
  "src/shell/ApprovalTerms.tsx",
  "src/shell/TaskContractChips.tsx",
  "src/shell/TaskWorkspaceTabs.tsx",
] as const;

/** Files that must never reach the compiler, even if a future allowlist grows. */
export const REACT_COMPILER_EXCLUDED_PREFIXES = [
  "electron/",
  "scripts/",
  "src/kernel/",
  "src/review/",
  "src/watchdog/",
  "src/memory/",
  "src/shared/",
  "dist/",
  "dist-electron/",
  "node_modules/",
] as const;

export type ReactCompilerMode = "infer" | "annotation";

export interface ReactCompilerEnv {
  VITEST?: string;
  VITEST_REACT_COMPILER?: string;
  NODE_ENV?: string;
  RC1_COMPILER?: string;
  RC1_MODE?: string;
}

function normalizedPath(filename: string): string {
  return filename.replace(/\\/g, "/").replace(/^.*?\/src\//, "src/");
}

export function isReactCompilerBuild(
  command: "build" | "serve",
  env: ReactCompilerEnv = process.env,
): boolean {
  // Default Vitest runs never compile. The explicit targeted-test switch is
  // intentionally separate from production build enablement.
  const targetedTestCompiler = env.VITEST === "true" && env.VITEST_REACT_COMPILER === "1";
  if (targetedTestCompiler) return true;
  if (command !== "build") return false;
  if (env.VITEST === "true" || env.NODE_ENV === "test") return false;
  // RC1-0 is a scoped spike: default build stays baseline. CI/compiler evidence
  // is produced by `pnpm build:compiler` with RC1_COMPILER=1.
  return env.RC1_COMPILER === "1";
}

export function reactCompilerMode(env: ReactCompilerEnv = process.env): ReactCompilerMode {
  return env.RC1_MODE === "infer" ? "infer" : "annotation";
}

export function isReactCompilerExcluded(filename: string): boolean {
  const path = normalizedPath(filename);
  return (
    REACT_COMPILER_EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    /(?:^|\/)(?:__tests__\/|.*\.(?:test|spec)\.)/.test(path)
  );
}

export function shouldCompileReactFile(filename: string): boolean {
  const path = normalizedPath(filename);
  if (isReactCompilerExcluded(path)) return false;
  return REACT_COMPILER_ALLOWLIST.some(
    (allowed) => path === allowed || path.endsWith(`/${allowed}`),
  );
}

/** Options passed to Babel; `sources` is the final file-level guard. */
export function reactCompilerPluginOptions(env: ReactCompilerEnv = process.env) {
  return {
    target: "19" as const,
    compilationMode: reactCompilerMode(env),
    sources: shouldCompileReactFile,
  };
}

export function reactCompilerBabelPlugins(env: ReactCompilerEnv = process.env) {
  return [
    [REACT_COMPILER_PACKAGE, reactCompilerPluginOptions(env)],
  ] as const;
}
