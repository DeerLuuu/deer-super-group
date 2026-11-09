import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MemoryWorkbench from "./MemoryWorkbench.js";

describe("MemoryWorkbench initial state", () => {
  it("renders the three tabs, search and aria-live loading state before data arrives", () => {
    const html = renderToStaticMarkup(
      <MemoryWorkbench
        workspaceId="w1"
        agents={[]}
        selectedBoard={null}
        onSelectBoard={() => undefined}
        autoOpenPublish={false}
        onAutoOpenHandled={() => undefined}
        onNotify={() => undefined}
      />,
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("黑板");
    expect(html).toContain("备忘录");
    expect(html).toContain("归档审批");
    expect(html).toContain('aria-label="检索记忆"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("加载记忆");
  });

  it("keeps the memory panel accessible without hover-only controls", () => {
    const html = renderToStaticMarkup(
      <MemoryWorkbench
        workspaceId="w1"
        agents={[]}
        selectedBoard="general"
        onSelectBoard={() => undefined}
        autoOpenPublish={false}
        onAutoOpenHandled={() => undefined}
        onNotify={() => undefined}
      />,
    );
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("发布条目");
  });
});
