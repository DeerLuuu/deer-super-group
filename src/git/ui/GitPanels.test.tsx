import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GitSettingsPanel, MergeQueueModal, TaskVcsPanel } from "./GitPanels.js";

/**
 * F7：Git 面板的初始 loading/aria 状态可用 SSR 自动回归；
 * Esc/Tab/焦点环/窄屏交互无 DOM 测试环境（仓库未装 jsdom/RTL），
 * 按 t111 实现文档 §8 的 manual-only 例外，用 t103 mock fixture Electron 冒烟复现。
 */
describe("GitPanels initial loading states", () => {
  it("TaskVcsPanel shows a busy loading status instead of an empty VCS", () => {
    const html = renderToStaticMarkup(<TaskVcsPanel taskId="t1" />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("加载 Git 状态");
    expect(html).not.toContain("尚未产生 Git 提交");
  });

  it("MergeQueueModal shows loading only while open", () => {
    const open = renderToStaticMarkup(
      <MergeQueueModal workspaceId="w1" open onClose={() => undefined} />,
    );
    expect(open).toContain('role="dialog"');
    expect(open).toContain('aria-busy="true"');
    expect(open).toContain("加载合并队列");
    const closed = renderToStaticMarkup(
      <MergeQueueModal workspaceId="w1" open={false} onClose={() => undefined} />,
    );
    expect(closed).toBe("");
  });

  it("GitSettingsPanel shows loading before settings arrive", () => {
    const html = renderToStaticMarkup(<GitSettingsPanel workspaceId="w1" />);
    expect(html).toContain('aria-label="Git 设置"');
    expect(html).toContain("加载中");
  });
});
