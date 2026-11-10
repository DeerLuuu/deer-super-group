import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Store } from "../kernel/store.js";
import type { Clock } from "../kernel/execution/clock.js";
import type { Agent, Run, Task } from "../shared/types.js";
import type { RunHandoff } from "../shared/watchdog.js";
import { isSensitivePath } from "../kernel/permission.js";
import type { WatchdogStore } from "./store.js";

const MAX_PATCH_BYTES = 256 * 1024;

function safeDiff(command: string[], cwd: string): string {
  try {
    return execFileSync("git", command, {
      cwd,
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    return "";
  }
}

function redactSensitiveText(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      /(^|[\\/\s])\.env(rc)?(\b|\.|$)|(^|[\\/\s])\.ssh([\\/]|$)|id_(rsa|dsa|ed25519|ecdsa)|\.pem\b|\.key\b|credentials\.json|\.npmrc\b|\.netrc\b|\.git-credentials\b|(secret|password|api[_-]?key|token)\s*=/i.test(
        line,
      )
        ? "[REDACTED]"
        : line,
    )
    .join("\n");
}

export class HandoffBuilder {
  private readonly store: Store;
  private readonly watchdog: WatchdogStore;
  private readonly clock: Clock;
  private readonly dataDir: string | undefined;

  constructor(options: {
    store: Store;
    watchdog: WatchdogStore;
    clock: Clock;
    dataDir?: string;
  }) {
    this.store = options.store;
    this.watchdog = options.watchdog;
    this.clock = options.clock;
    this.dataDir = options.dataDir;
  }

  build(input: {
    run: Run;
    task: Task;
    reason: RunHandoff["reason"];
    toModelProfileId?: string | null;
    toAgentId?: string | null;
  }): RunHandoff {
    const { run, task } = input;
    const agent = this.store.getAgent(run.agentId);
    const workspace = this.store.getWorkspace(task.workspaceId);
    const summary = this.store.getSummaryForTask(task.id);
    const events = this.store.listEventsForTask(task.id, 300);
    const lastAssistant = [...events]
      .reverse()
      .find((event) => event.type === "assistant.message") as
      | { payload?: { text?: string } }
      | undefined;
    const lastEvent = events[events.length - 1];
    const cwd = run.sandboxId?.startsWith("git:")
      ? run.sandboxId.slice(4)
      : workspace?.path ?? process.cwd();

    const diffStat = safeDiff(["diff", "--stat", "--no-color"], cwd).slice(0, 8_000);
    const nameStatus = safeDiff(["diff", "--name-status", "--no-color"], cwd);
    const allGitFiles = nameStatus
      .split("\n")
      .map((line) => line.split("\t").slice(1).join("\t").trim())
      .filter(Boolean);
    const sensitiveFiles = allGitFiles.filter((file) => isSensitivePath(file));
    const gitFiles = allGitFiles.filter((file) => !isSensitivePath(file));
    // t157 F1：先按路径过滤敏感文件，再按安全路径分别取 diff；敏感路径只保留
    // redacted 标记，stat/patch/assistant 文本都不含内容。
    const safeStat = gitFiles.length
      ? safeDiff(["diff", "--stat", "--no-color", "--", ...gitFiles.slice(0, 100)], cwd).slice(0, 8_000)
      : "";
    const redactedDiffStat = sensitiveFiles.length
      ? `[REDACTED] ${sensitiveFiles.length} sensitive path(s) changed${safeStat ? `\nsafe stat:\n${safeStat}` : ""}`
      : diffStat;
    const patch = sensitiveFiles.length
      ? gitFiles
          .slice(0, 100)
          .map((file) => safeDiff(["diff", "--no-color", "--unified=3", "--", file], cwd))
          .filter(Boolean)
          .join("\n")
          .slice(0, MAX_PATCH_BYTES)
      : safeDiff(["diff", "--no-color", "--unified=3"], cwd).slice(0, MAX_PATCH_BYTES);
    const files = [...new Set([...(summary?.files ?? []), ...gitFiles])]
      .filter((file) => !isSensitivePath(file))
      .slice(0, 50);

    const redactedChanges = (summary?.changes ?? []).map(redactSensitiveText);
    const redactedQuestions = (summary?.openQuestions ?? []).map(redactSensitiveText);
    const summaryLines = [
      `task: ${task.title}`,
      `status: ${task.status}; run attempt ${run.attempt ?? 1}`,
      `acceptance: ${task.acceptance.length ? task.acceptance.join("; ") : "(none)"}`,
      summary
        ? `completed: ${redactedChanges.join("; ") || redactSensitiveText(summary.goal)}`
        : "completed: (no structured summary)",
      redactedQuestions.length ? `open questions: ${redactedQuestions.join("; ")}` : "",
      lastAssistant?.payload?.text
        ? `last assistant: ${redactSensitiveText(String(lastAssistant.payload.text)).slice(0, 1_200)}`
        : "",
      redactedDiffStat ? `diff stat:\n${redactedDiffStat}` : "diff stat: (no repository diff)",
    ].filter(Boolean);
    const nextStepRaw =
      summary?.openQuestions[0] ??
      (task.acceptance.length
        ? `继续完成未通过的验收项：${task.acceptance[0]}`
        : "先核验当前改动，再完成剩余最小步骤");
    const nextStep = redactSensitiveText(nextStepRaw);
    // t161 F4：summary/nextStep 统一走 redactSensitiveText，避免 changes/openQuestions
    // 把 `.env`/私钥路径或内容带进 handoff。
    const redactedSummary = redactSensitiveText(summaryLines.join("\n"));

    const id = `hof_${run.id}`;
    const handoff: RunHandoff = {
      id,
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      attempt: run.attempt ?? 1,
      reason: input.reason,
      summary: redactedSummary.slice(0, 2_000),
      nextStep: nextStep.slice(0, 500),
      files,
      diffStat: redactedDiffStat,
      diffRef: null,
      lastEventSeq: lastEvent?.seq ?? 0,
      fromModelProfileId: run.modelProfileId ?? null,
      toModelProfileId: input.toModelProfileId ?? null,
      fromAgentId: run.agentId,
      toAgentId: input.toAgentId ?? null,
      createdAt: new Date(this.clock.now()).toISOString(),
      expiresAt: new Date(this.clock.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    if (patch) {
      try {
        if (this.dataDir) {
          const dir = path.join(this.dataDir, "handoffs");
          mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `${id}.patch`);
          writeFileSync(file, patch, { encoding: "utf8", mode: 0o600 });
          handoff.diffRef = `handoffs/${id}.patch`;
        }
      } catch {
        handoff.diffRef = null;
      }
    }

    this.watchdog.saveHandoff(handoff);
    this.watchdog.appendEvent(
      "run.handoff_created",
      "run",
      run.id,
      {
        handoffId: handoff.id,
        runId: run.id,
        taskId: task.id,
        reason: handoff.reason,
        files: handoff.files,
        diffStatHash: handoff.diffStat ? `stat_${handoff.diffStat.length}` : undefined,
      },
      `handoff:${run.id}:${input.reason}`,
    );
    return handoff;
  }
}
