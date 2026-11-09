import type { GitService } from "./gitService.js";

/**
 * Kernel §16 G3 contract aliases. The t68 kernel currently exposes a
 * synchronous beforeStart hook; this adapter is the stable surface the kernel
 * can call when the async RunEnvironmentProvider lands (t68 §16 follow-up).
 */
export type BeforeStartResult =
  | { allow: true }
  | { allow: false; reason: string }
  | { allow: false; defer: true; retryAfterMs: number; reason: "GIT_CAPACITY" };

export interface RunEnvironmentProvider {
  prepare(input: {
    workspaceId: string;
    taskId: string;
    runId: string;
    attempt: number;
    agentId: string;
  }): Promise<
    | { ok: true; cwd: string; branch: string | null; sandboxId: string; mode: "git" | "degraded" }
    | { ok: false; defer: true; retryAfterMs: number; reason: string }
    | { ok: false; defer: false; errorCode: string; message: string }
  >;
  release(input: { runId: string; taskId: string; status: "completed" | "failed" | "cancelled" }): Promise<void>;
}

export class GitRunEnvironmentProvider implements RunEnvironmentProvider {
  constructor(private readonly git: GitService) {}

  async beforeStart(input: {
    workspaceId: string;
    taskId: string;
    attempt: number;
  }): Promise<BeforeStartResult> {
    const result = this.git.admit(input);
    if (typeof result === "boolean") return result ? { allow: true } : { allow: false, reason: "GIT_CAPACITY" };
    return result.allow
      ? { allow: true }
      : { allow: false, reason: result.reason ?? "GIT_CAPACITY" };
  }

  async prepare(input: {
    workspaceId: string;
    taskId: string;
    runId: string;
    attempt: number;
    agentId: string;
  }) {
    return this.git.prepareRun(input);
  }

  async release(input: {
    runId: string;
    taskId: string;
    status: "completed" | "failed" | "cancelled";
  }): Promise<void> {
    await this.git.finalizeRun({ runId: input.runId, taskId: input.taskId, status: input.status });
  }
}
