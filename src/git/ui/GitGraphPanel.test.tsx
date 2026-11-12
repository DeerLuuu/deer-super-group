import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import GitGraphPanel from "./GitGraphPanel";

describe("GitGraphPanel", () => {
  it("explains when the desktop bridge is unavailable", () => {
    const html = renderToStaticMarkup(<GitGraphPanel workspaceId="ws1" />);
    expect(html).toContain("版本图不可用");
    expect(html).toContain("桌面桥未加载");
  });

  it("renders the read-only graph shell when the bridge exists", () => {
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      deer: {
        gitRepo: async () => ({ ok: false, errorCode: "GIT_READ_NOT_REPO", message: "not repo" }),
        gitGraph: async () => ({ ok: false }),
        gitRefs: async () => ({ ok: false }),
        gitCommit: async () => ({ ok: false }),
        gitStatus: async () => ({ ok: false }),
        gitDiff: async () => ({ ok: false }),
      },
    };
    try {
      const html = renderToStaticMarkup(<GitGraphPanel workspaceId="ws1" />);
      expect(html).toContain("版本图");
      expect(html).toContain("只读");
      expect(html).toContain("筛选提交");
      expect(html).toContain('role="tablist"');
      expect(html).toContain("aria-label=\"版本视图\"");
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  });
});
