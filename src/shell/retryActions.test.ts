import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

describe("t253 write-operation retry wiring", () => {
  it("attaches executable retry actions for createTask/sendMessage/planDraft confirm", () => {
    expect(appSource).toContain('label: "重试创建任务"');
    expect(appSource).toContain('label: "重试发送邮件"');
    expect(appSource).toContain('label: "重试确认"');
    expect(appSource).toContain("retryAction={");
    expect(appSource).toContain("run: () => void handleCreateTask");
    expect(appSource).toContain("run: () => void handleSendMessage");
    expect(appSource).toContain("run: () => void handleConfirmPlan");
  });
});
