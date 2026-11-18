import { describe, expect, it } from "vitest";
import {
  GIT_AI_LIMITS,
  buildGitAiMessages,
  parseGitAiDraft,
  sanitizeGitAiText,
} from "./gitAi.js";

describe("t368 Git AI shared contract", () => {
  it("redacts secrets and caps every outbound context field", () => {
    const raw =
      "Authorization: Bearer sk-live-SECRET12345 https://user:pass@example.com/x?token=abc api_key=xyz " +
      "sk-proj-abcdefghijk".repeat(300);
    const clean = sanitizeGitAiText(raw, 900);
    expect(clean).not.toContain("SECRET12345");
    expect(clean).not.toContain("token=abc");
    expect(clean).not.toContain("api_key=xyz");
    expect(clean.length).toBeLessThanOrEqual(900);
    expect(clean).toContain("[REDACTED]");
  });

  it("builds messages with sanitized diff/task/persona and parses fenced JSON", () => {
    const messages = buildGitAiMessages({
      kind: "pr",
      agentName: "Mika",
      agentRole: "Designer",
      agentSystemPrompt: "persona sk-persona-SECRET",
      workspaceName: "Demo",
      taskTitle: "Add login",
      taskDescription: "token=task-SECRET",
      branch: "feature/login",
      baseBranch: "main",
      headSha: "abc123",
      prSummary: "none",
      mergeSummary: "none",
      diffSummary: "diff sk-diff-SECRET",
    });
    const all = messages.map((message) => message.content).join("\n");
    expect(all).not.toContain("task-SECRET");
    expect(all).not.toContain("persona-SECRET");
    expect(all).not.toContain("diff-SECRET");
    expect(all).toContain("Add login");
    expect(parseGitAiDraft('```json\n{"title":"T","body":"B"}\n```')).toEqual({
      title: "T",
      body: "B",
    });
    expect(parseGitAiDraft("Plain title\n\nbody line")).toEqual({
      title: "Plain title",
      body: "body line",
    });
    expect(parseGitAiDraft("")).toBeNull();
  });

  it("caps a very long model draft", () => {
    const draft = parseGitAiDraft(
      JSON.stringify({ title: "x".repeat(500), body: "y".repeat(GIT_AI_LIMITS.draftBody + 100) }),
    );
    expect(draft!.title.length).toBeLessThanOrEqual(GIT_AI_LIMITS.draftTitle);
    expect(draft!.body.length).toBeLessThanOrEqual(GIT_AI_LIMITS.draftBody);
  });
});
