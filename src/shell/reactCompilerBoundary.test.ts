import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REACT_COMPILER_ALLOWLIST,
  REACT_COMPILER_EXCLUDED_FILES,
  REACT_COMPILER_EXCLUDED_PREFIXES,
  REACT_COMPILER_HIGH_RISK_OPT_OUT,
  REACT_COMPILER_LICENSE,
  REACT_COMPILER_PACKAGE,
  REACT_COMPILER_VERSION,
  isReactCompilerBuild,
  isReactCompilerExcluded,
  reactCompilerBabelPlugins,
  reactCompilerMode,
  reactCompilerPluginOptions,
  shouldCompileReactFile,
} from "./reactCompilerBoundary.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("t510 RC1-0 React Compiler boundary", () => {
  it("pins the compiler devDependency and records its license", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    expect(pkg.devDependencies?.[REACT_COMPILER_PACKAGE]).toBe(REACT_COMPILER_VERSION);
    expect(REACT_COMPILER_VERSION).toBe("1.0.0");
    expect(REACT_COMPILER_LICENSE).toBe("MIT");
  });

  it("enables only explicit renderer compiler builds and never default Vitest runs", () => {
    expect(isReactCompilerBuild("build", {})).toBe(false);
    expect(isReactCompilerBuild("build", { RC1_COMPILER: "1" })).toBe(true);
    expect(isReactCompilerBuild("serve", {})).toBe(false);
    expect(isReactCompilerBuild("build", { VITEST: "true", RC1_COMPILER: "1" })).toBe(false);
    expect(isReactCompilerBuild("build", { NODE_ENV: "test", RC1_COMPILER: "1" })).toBe(false);
    expect(isReactCompilerBuild("build", { RC1_COMPILER: "0" })).toBe(false);
    expect(isReactCompilerBuild("build", { RC1_COMPILER: "off" })).toBe(false);
    expect(
      isReactCompilerBuild("serve", { VITEST: "true", VITEST_REACT_COMPILER: "1" }),
    ).toBe(true);
    expect(isReactCompilerBuild("serve", { VITEST: "true", VITEST_REACT_COMPILER: "0" })).toBe(
      false,
    );
  });

  it("compiles shell/git UI but excludes Dock/panel infrastructure/tests", () => {
    expect(REACT_COMPILER_ALLOWLIST).toEqual(["src/shell/", "src/git/ui/"]);
    expect(shouldCompileReactFile("src/shell/SkipLink.tsx")).toBe(true);
    expect(shouldCompileReactFile("S:/repo/src/shell/ApprovalTerms.tsx")).toBe(true);
    expect(shouldCompileReactFile("src/git/ui/GitPanels.tsx")).toBe(true);
    expect(shouldCompileReactFile("src/shell/dock/DockShell.tsx")).toBe(false);
    expect(shouldCompileReactFile("src/shell/panel/PanelHost.tsx")).toBe(false);
    expect(shouldCompileReactFile("src/shell/LazyPanel.tsx")).toBe(false);
    expect(shouldCompileReactFile("src/shell/dock/layoutOps.tsx")).toBe(false);
    expect(shouldCompileReactFile("src/kernel/service.tsx")).toBe(false);
    expect(shouldCompileReactFile("electron/main.tsx")).toBe(false);
    expect(shouldCompileReactFile("scripts/seed.tsx")).toBe(false);
    expect(shouldCompileReactFile("src/shared/View.tsx")).toBe(false);
    expect(shouldCompileReactFile("src/shell/SkipLink.test.tsx")).toBe(false);
    expect(shouldCompileReactFile("src/shell/__tests__/SkipLink.tsx")).toBe(false);
    expect(shouldCompileReactFile("src/git/ui/GitDiffViewer.ts")).toBe(false);
    expect(isReactCompilerExcluded("src/kernel/service.tsx")).toBe(true);
    expect(isReactCompilerExcluded("electron/main.tsx")).toBe(true);
    expect(REACT_COMPILER_EXCLUDED_PREFIXES).toContain("src/shared/");
    expect(REACT_COMPILER_EXCLUDED_FILES).toContain("src/shell/dock/");
  });

  it("documents high-risk components with explicit use no memo", () => {
    expect(REACT_COMPILER_HIGH_RISK_OPT_OUT).toContain("src/git/ui/GitDiffViewer.tsx");
    expect(REACT_COMPILER_HIGH_RISK_OPT_OUT).toContain("src/shell/SeparatorControl.tsx");
    for (const file of REACT_COMPILER_HIGH_RISK_OPT_OUT) {
      const source = readFileSync(path.join(root, file), "utf8");
      expect(source).toContain('"use no memo";');
    }
  });

  it("exposes the Babel plugin guard and both compilation modes", () => {
    const options = reactCompilerPluginOptions({});
    expect(options.target).toBe("19");
    expect(options.compilationMode).toBe("annotation");
    expect(options.sources("src/shell/SkipLink.tsx")).toBe(true);
    expect(options.sources("src/git/ui/GitPanels.tsx")).toBe(true);
    expect(options.sources("src/kernel/service.tsx")).toBe(false);
    expect(reactCompilerMode({})).toBe("annotation");
    expect(reactCompilerMode({ RC1_MODE: "annotation" })).toBe("annotation");
    expect(reactCompilerMode({ RC1_MODE: "infer" })).toBe("infer");
    expect(reactCompilerBabelPlugins({})[0][0]).toBe(REACT_COMPILER_PACKAGE);
  });

  it("keeps the Electron build script outside the compiler", () => {
    const buildElectron = readFileSync(path.join(root, "scripts/build-electron.mjs"), "utf8");
    expect(buildElectron).not.toContain("babel-plugin-react-compiler");
    expect(buildElectron).not.toContain("reactCompilerBoundary");
    expect(buildElectron).toContain("esbuild");
  });
});
