import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const teamSource = readFileSync(new URL("../TeamDashboard.tsx", import.meta.url), "utf8");

describe("t247 approval terminology", () => {
  it("distinguishes task delivery approval, code review and merge confirmation", () => {
    expect(appSource).toContain("批准任务交付（任务交付 gate");
    expect(appSource).toContain("<ApprovalTerms");
    expect(appSource).toContain("合并确认说明");
    expect(teamSource).toContain("合并确认在此执行");
  });

  it("keeps the Tasks detail empty state to one new-task primary", () => {
    const start = appSource.indexOf('title={snapshot.tasks.length === 0 ? "创建第一个任务"');
    const end = appSource.indexOf("{selectedTask && (", start);
    const block = appSource.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('"+ 新建任务"');
    expect(block).not.toContain("规划任务");
    expect(appSource).toContain("从对话规划");
    expect(appSource).toContain('aria-label="从对话规划"');
  });

  it("focuses the models section for recovery/first-run settings actions", () => {
    expect(appSource).toContain('openSettingsSection("models")');
    expect(appSource).toContain('initialSection={gitSettingsFocus ? "git" : settingsInitialSection}');
  });

  it("uses only the current model provider for first-run key readiness", () => {
    expect(appSource).toContain("resolveFirstRunKeyStatus(");
    expect(appSource).not.toContain(
      'snapshot.settings.providers.some((provider) => provider.apiKeySource !== "none")',
    );
    expect(appSource).toContain("keyProviderName: firstRunKey.providerName");
  });
});
