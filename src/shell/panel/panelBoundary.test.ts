import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PANEL_LOADERS, type LazyPanelKey } from "./panelLoaders";
import {
  PANEL_CHUNK_BUDGET_BYTES,
  checkPanelChunkBudget,
  type PanelChunkEntry,
} from "./panelChunkBudget";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const PANEL_ROOTS: Record<LazyPanelKey, string> = {
  settings: "src/SettingsView.tsx",
  team: "src/TeamDashboard.tsx",
  board: "src/shell/MemoryWorkbench.tsx",
  polls: "src/shell/PollPanel.tsx",
  planDraft: "src/shell/PlanDraftPanel.tsx",
  gitGraph: "src/git/ui/GitGraphPanel.tsx",
  mergeQueue: "src/git/ui/MergeQueuePanel.tsx",
};

/** Only these pure shared helpers may be reached from a panel graph. */
const ALLOWED_SHARED_MODULES = new Set([
  "src/shared/types.ts",
  "src/shared/interactive.ts",
  "src/shared/models.ts",
  "src/shared/translation.ts",
  "src/shared/copy.ts",
  "src/shared/errorRedaction.ts",
  "src/shared/gitAi.ts",
  "src/shared/kernelUi.ts",
  "src/shared/modalStack.ts",
  "src/shared/memberRecommendation.ts",
  "src/shared/poll.ts",
  "src/shared/planDraft.ts",
]);
/** Pure type-only memory contract; value imports remain forbidden. */
const ALLOWED_TYPE_ONLY_MEMORY = new Set(["src/memory/types.ts"]);
const ALLOWED_APP_TYPE_IMPORTS = new Set(["src/SettingsView.tsx"]);
const FORBIDDEN_EXTERNAL_PREFIXES = ["node:", "electron"];
const FORBIDDEN_DIRS = [
  "src/kernel",
  "src/review",
  "src/watchdog",
  "src/memory",
  "src/electron",
  "electron",
];
const FORBIDDEN_REVERSE = [
  "src/App.tsx",
  "src/shell/dock/DockTree.tsx",
  "src/shell/dock/DockShell.tsx",
  "src/shell/dock/DockShellV2.tsx",
  "src/shell/panel/panelManifest.ts",
  "src/shell/panel/panelLoaders.ts",
];

interface ImportRef {
  spec: string;
  typeOnly: boolean;
  dynamic: boolean;
}

interface GraphEdge {
  from: string;
  to: string;
  typeOnly: boolean;
  spec: string;
}

function relativePOSIX(file: string): string {
  return path.relative(REPO_ROOT, file).replace(/\\/g, "/");
}

function absolute(rel: string): string {
  return path.join(REPO_ROOT, rel);
}

function parseImports(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const pattern =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const spec = match[3] ?? match[4];
    if (!spec) continue;
    refs.push({
      spec,
      typeOnly: Boolean(match[2]),
      dynamic: match[1] === undefined,
    });
  }
  return refs;
}

function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base];
  if (base.endsWith(".js")) {
    candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
  } else {
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.js`);
  }
  candidates.push(path.join(base, "index.ts"), path.join(base, "index.tsx"));
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function collectEdges(rootRel: string): { files: string[]; edges: GraphEdge[] } {
  const root = absolute(rootRel);
  const visited = new Set<string>();
  const edges: GraphEdge[] = [];
  const pending = [root];
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const ref of parseImports(source)) {
      const target = resolveLocal(file, ref.spec);
      if (!target) continue;
      edges.push({ from: relativePOSIX(file), to: relativePOSIX(target), typeOnly: ref.typeOnly, spec: ref.spec });
      pending.push(target);
    }
  }
  return { files: [...visited].map(relativePOSIX).sort(), edges };
}

function under(rel: string, dir: string): boolean {
  return rel === dir || rel.startsWith(`${dir}/`);
}

describe("MF1-2 panel boundary", () => {
  it("covers every lazy loader with an explicit panel root", () => {
    expect(Object.keys(PANEL_ROOTS).sort()).toEqual(Object.keys(PANEL_LOADERS).sort());
    for (const root of Object.values(PANEL_ROOTS)) expect(existsSync(absolute(root))).toBe(true);
  });

  it("keeps panel graphs free of server code and cross-panel imports", () => {
    const offenders: string[] = [];
    for (const [key, root] of Object.entries(PANEL_ROOTS) as Array<[LazyPanelKey, string]>) {
      const { files, edges } = collectEdges(root);
      for (const edge of edges) {
        const target = edge.to;
        if (FORBIDDEN_REVERSE.includes(target)) {
          offenders.push(`${key}: ${edge.from} -> ${target} (reverse dependency)`);
        }
        const forbiddenDir = FORBIDDEN_DIRS.find((dir) => under(target, dir));
        if (forbiddenDir) {
          const typeOnlyMemory =
            target.startsWith("src/memory/") &&
            ALLOWED_TYPE_ONLY_MEMORY.has(target) &&
            edge.typeOnly;
          if (!typeOnlyMemory) {
            offenders.push(`${key}: ${edge.from} -> ${target} (${forbiddenDir})`);
          }
        }
        if (target.startsWith("src/shared/") && !ALLOWED_SHARED_MODULES.has(target)) {
          offenders.push(`${key}: ${edge.from} -> ${target} (shared not whitelisted)`);
        }
        if (
          target !== root &&
          (Object.values(PANEL_ROOTS) as string[]).includes(target)
        ) {
          offenders.push(`${key}: ${edge.from} -> ${target} (cross-panel)`);
        }
      }
      for (const file of files) {
        for (const ref of parseImports(readFileSync(absolute(file), "utf8"))) {
          if (FORBIDDEN_EXTERNAL_PREFIXES.some((prefix) => ref.spec.startsWith(prefix))) {
            offenders.push(`${key}: ${file} -> ${ref.spec} (external server import)`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("allows only the memory type contract, not memory runtime", () => {
    const { edges } = collectEdges(PANEL_ROOTS.board);
    const memoryEdges = edges.filter((edge) => edge.to.startsWith("src/memory/"));
    expect(memoryEdges).toEqual([
      expect.objectContaining({
        to: "src/memory/types.ts",
        typeOnly: true,
      }),
    ]);
  });

  it("keeps App/manifest going through the loader map only", () => {
    const appSource = readFileSync(absolute("src/App.tsx"), "utf8");
    expect(appSource).toContain('from "./shell/panel/panelLoaders"');
    const appRefs = parseImports(appSource);
    const appEdges = appRefs
      .filter((ref) => !ref.typeOnly)
      .map((ref) => resolveLocal(absolute("src/App.tsx"), ref.spec))
      .filter((file): file is string => Boolean(file))
      .map(relativePOSIX);
    for (const root of Object.values(PANEL_ROOTS)) {
      expect(appEdges).not.toContain(root);
    }
    for (const ref of appRefs.filter((item) => item.typeOnly)) {
      const target = resolveLocal(absolute("src/App.tsx"), ref.spec);
      if (!target) continue;
      const rel = relativePOSIX(target);
      if ((Object.values(PANEL_ROOTS) as string[]).includes(rel)) {
        expect(ALLOWED_APP_TYPE_IMPORTS.has(rel)).toBe(true);
      }
    }

    const manifestRefs = parseImports(
      readFileSync(absolute("src/shell/panel/panelManifest.ts"), "utf8"),
    );
    const manifestTargets = manifestRefs
      .map((ref) => resolveLocal(absolute("src/shell/panel/panelManifest.ts"), ref.spec))
      .filter((file): file is string => Boolean(file))
      .map(relativePOSIX);
    expect(manifestTargets).toContain("src/shell/panel/panelLoaders.ts");
    for (const root of Object.values(PANEL_ROOTS)) {
      expect(manifestTargets).not.toContain(root);
    }

    const loaderRefs = parseImports(
      readFileSync(absolute("src/shell/panel/panelLoaders.ts"), "utf8"),
    ).filter((ref) => ref.dynamic);
    const dynamicTargets = loaderRefs
      .map((ref) => resolveLocal(absolute("src/shell/panel/panelLoaders.ts"), ref.spec))
      .filter((file): file is string => Boolean(file))
      .map(relativePOSIX);
    expect(new Set(dynamicTargets)).toEqual(new Set(Object.values(PANEL_ROOTS)));
  });

  it("allows panel dynamic imports only in panelLoaders", () => {
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          visit(file);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.includes(".test.")) continue;
        if (relativePOSIX(file) === "src/shell/panel/panelLoaders.ts") continue;
        const source = readFileSync(file, "utf8");
        for (const ref of parseImports(source)) {
          if (!ref.dynamic) continue;
          const target = resolveLocal(file, ref.spec);
          if (!target) continue;
          const rel = relativePOSIX(target);
          if (Object.values(PANEL_ROOTS).includes(rel)) offenders.push(`${relativePOSIX(file)} -> ${rel}`);
        }
      }
    };
    visit(absolute("src"));
    expect(offenders).toEqual([]);
  });
});

describe("MF1-2 panel chunk budget", () => {
  // Baseline from the current Vite build; budgets are reviewed with ADR.
  const BASELINE: Record<LazyPanelKey, number> = {
    settings: 26_185,
    team: 46_386,
    board: 30_485,
    polls: 16_473,
    planDraft: 8_922,
    gitGraph: 52_136,
    mergeQueue: 8_756,
  };

  it("records a budget above baseline and within 35% headroom for every panel", () => {
    expect(Object.keys(PANEL_CHUNK_BUDGET_BYTES).sort()).toEqual(Object.keys(BASELINE).sort());
    for (const key of Object.keys(BASELINE) as LazyPanelKey[]) {
      expect(PANEL_CHUNK_BUDGET_BYTES[key]).toBeGreaterThanOrEqual(BASELINE[key]);
      expect(PANEL_CHUNK_BUDGET_BYTES[key]).toBeLessThanOrEqual(Math.ceil(BASELINE[key] * 1.35));
    }
  });

  it("fails over-budget chunks and accepts exact budgets", () => {
    const within = Object.entries(PANEL_CHUNK_BUDGET_BYTES).map(([key, bytes]) => ({
      key: key as LazyPanelKey,
      bytes,
    })) satisfies PanelChunkEntry[];
    expect(checkPanelChunkBudget(within)).toEqual([]);

    const over = within.map((entry) => ({ ...entry, bytes: entry.bytes + 1 }));
    expect(checkPanelChunkBudget(over)).toHaveLength(over.length);
  });
});
