import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { AppService } from "../src/kernel/service.js";
import { stripCreateAgentPermission } from "../src/shared/memberRecommendation.js";
import type {
  AnswerChatQuestionInput,
  CancelChatQuestionInput,
  ChatTurnHistoryOptions,
  CreateAgentInput,
  RecommendMembersRequest,
  CreateTaskInput,
  KernelErrorCode,
  LlmSettings,
  UpdateAgentInput,
  PostBoardInput,
  SendMessageInput,
} from "../src/shared/types.js";
import type { GitSettings, GitResult } from "../src/git/types.js";
import {
  gitCommitParamsSchema,
  gitDiffParamsSchema,
  gitGraphParamsSchema,
  gitRefsParamsSchema,
  gitWorkspaceIdSchema,
} from "../src/git/readTypes.js";
import {
  gitCommitBodySchema,
  gitCommitTitleSchema,
  gitWritePathsSchema,
} from "../src/git/writeTypes.js";
import type { SetBudgetInput, SetFallbackChainInput, WatchdogHoldReason } from "../src/shared/watchdog.js";
import type {
  CreateMemoryBoardInput,
  CreateMemoryMemoInput,
} from "../src/shared/memoryRuntime.js";
import type { MemorySearchInput, MemorySnapshotOptions } from "../src/memory/types.js";
import type { CastPollRequest, ClosePollRequest, CreatePollRequest, PollStatus } from "../src/shared/poll.js";
import { ReviewService, ensureTargetForPrEvent } from "../src/review/service.js";
import type { ReviewConfigPatch, ReviewDecision, ReviewSeverity } from "../src/review/types.js";

let win: BrowserWindow | null = null;
let service: AppService | null = null;
let reviewService: ReviewService | null = null;

function readBadParam(): GitResult<never> {
  return { ok: false, errorCode: "GIT_READ_BAD_PARAM", message: "invalid git read params", retryable: false };
}

function getService(): AppService {
  if (!service) {
    throw new Error("service is not ready");
  }
  return service;
}

function getReview(): ReviewService {
  if (!reviewService) {
    const current = getService();
    reviewService = new ReviewService({
      store: current.store,
      workspacePath: (workspaceId) => current.store.getWorkspace(workspaceId)?.path ?? process.cwd(),
      getTaskVcs: async (taskId) => current.git.getTaskVcs(taskId),
      sendMail: (mail) => {
        current.sendMessage(mail);
      },
      postBoard: (post) => {
        current.postBoard(post);
      },
    });
  }
  return reviewService;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    // t56（bb-83 裁决 F2）：minWidth 1100 → 960，让 dock 的 single 变体（<760）可达；
    // minHeight 保持 700 不变。
    minWidth: 960,
    minHeight: 700,
    backgroundColor: "#0d1117",
    autoHideMenuBar: true,
    title: "DeerSuperGroup",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  win.on("closed", () => {
    win = null;
  });
}

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
}

/**
 * t69：内核命令统一返回 KernelResult<T>。
 * 稳定错误码来自 KernelError.code；非内核异常归 INTERNAL。渲染层用 code 选择文案，
 * 不解析 message（message 只用于详情/复制）。
 */
function handleKernel(
  channel: string,
  fn: (...args: any[]) => unknown,
): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true as const, value: await fn(...args) };
    } catch (error) {
      const code =
        (error as { code?: KernelErrorCode } | null)?.code ?? "INTERNAL";
      return {
        ok: false as const,
        error: {
          code,
          message: error instanceof Error ? error.message : String(error),
          details: (error as { details?: unknown } | null)?.details,
        },
      };
    }
  });
}

app.whenReady().then(() => {
  // Optional fallback for environments where GUI apps do not inherit shell vars.
  const envFile = path.join(app.getPath("userData"), ".env");
  if (existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch (error) {
      console.warn(`failed to load ${envFile}:`, error);
    }
  }

  service = new AppService(app.getPath("userData"));
  service.onEvent((event) => {
    win?.webContents.send("app:event", event);
    if ((event.type === "pr.created" || event.type === "pr.updated") && event.aggregateType === "task") {
      // PR events are best-effort target creation; never block task completion.
      void ensureTargetForPrEvent(getReview(), event.aggregateId);
    }
  });
  service.onChatEvent((event) => {
    win?.webContents.send("chat:event", event);
  });

  handle("workspace:list", () => getService().listWorkspaces());

  handle("workspace:open", async () => {
    const options = {
      properties: ["openDirectory"] as const,
      title: "选择工作区文件夹",
    };
    const result = win
      ? await dialog.showOpenDialog(win, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return getService().openWorkspace(result.filePaths[0]);
  });

  handle("workspace:snapshot", (workspaceId: string) => getService().getSnapshot(workspaceId));
  handle("agent:create", (input: CreateAgentInput) =>
    getService().createAgent(stripCreateAgentPermission(input)),
  );
  handle("agent:recommend", (input: RecommendMembersRequest) =>
    getService().recommendMembers(input),
  );
  handle("agent:update", (input: UpdateAgentInput) => getService().updateAgent(input));
  handle("agent:delete", (agentId: string) => getService().deleteAgent(agentId));
  handle("task:create", (input: CreateTaskInput) => getService().createTask(input));
  handle("task:delete", (taskId: string) => getService().deleteTask(taskId));
  handle("task:run", (taskId: string) => getService().runTask(taskId));
  // t69：调度/运行可观测 UI 的内核命令（KernelResult，不抛裸错误）。
  handleKernel("kernel:startTask", (taskId: string) => getService().startTask(taskId));
  handleKernel("kernel:cancelTask", (taskId: string) => getService().cancelTask(taskId));
  handleKernel("kernel:retryTask", (taskId: string) => getService().retryTask(taskId));
  handleKernel(
    "kernel:reviewTask",
    (taskId: string, decision: "approve" | "reject", options?: { reviewer?: string; notes?: string }) =>
      getService().reviewTask(taskId, decision, options),
  );
  handleKernel("kernel:cancelRun", (runId: string) => getService().cancelRun(runId));
  handleKernel("kernel:listRuns", (taskId: string) => getService().listRuns(taskId));
  handleKernel("kernel:getScheduler", (workspaceId: string) =>
    getService().getScheduler(workspaceId),
  );
  handleKernel("kernel:pauseScheduler", (workspaceId: string, reason?: string) =>
    getService().pauseScheduler(workspaceId, reason),
  );
  handleKernel("kernel:resumeScheduler", (workspaceId: string) =>
    getService().resumeScheduler(workspaceId),
  );
  handle("task:trace", (taskId: string) => getService().getTaskTrace(taskId));
  // t144：watchdog/cost（WatchdogResult，业务失败不抛裸错误）
  handle("watchdog:getSnapshot", (workspaceId: string) =>
    getService().getWatchdogSnapshot(workspaceId),
  );
  handle("watchdog:getCosts", (workspaceId: string) => getService().getWatchdogCosts(workspaceId));
  handle("watchdog:getHandoff", (workspaceId: string, runId: string) =>
    getService().getRunHandoff(workspaceId, runId),
  );
  handle("watchdog:ackAlert", (workspaceId: string, alertId: string) =>
    getService().ackWatchdogAlert(workspaceId, alertId),
  );
  handle("watchdog:resolveAlert", (workspaceId: string, alertId: string) =>
    getService().resolveWatchdogAlert(workspaceId, alertId),
  );
  handle(
    "watchdog:releaseHold",
    (workspaceId: string, taskId: string, reason?: WatchdogHoldReason, all?: boolean) =>
      getService().releaseWatchdogTaskHold(workspaceId, taskId, reason, all),
  );
  handle("watchdog:setBudget", (input: SetBudgetInput) => getService().setWatchdogBudget(input));
  handle("watchdog:setFallback", (input: SetFallbackChainInput) =>
    getService().setWatchdogFallback(input),
  );
  handle("watchdog:health", () => getService().getWatchdogHealth());
  handle("router:plan", (workspaceId: string, goal: string) => getService().plan(workspaceId, goal));
  handle("plan:preview", (workspaceId: string, source: Parameters<AppService["previewPlan"]>[1]) =>
    getService().previewPlan(workspaceId, source),
  );
  handle("plan:confirm", (input: Parameters<AppService["confirmPlan"]>[0]) =>
    getService().confirmPlan(input),
  );
  handle("mailbox:send", (input: SendMessageInput) => getService().sendMessage(input));
  handle("board:post", (input: PostBoardInput) => getService().postBoard(input));
  handle("settings:get", () => getService().getSettings());
  handle("settings:save", (settings: LlmSettings) => getService().saveSettings(settings));
  handle("llm:models", (settings: LlmSettings, providerId?: string) =>
    getService().listModels(settings, providerId),
  );
  handle("chat:list", (workspaceId: string, agentId?: string) =>
    getService().listChat(workspaceId, agentId),
  );
  handle("chat:trajectory", (workspaceId: string, agentId?: string) =>
    getService().getChatTrajectory(workspaceId, agentId),
  );
  handle(
    "chat:turns",
    (workspaceId: string, agentId?: string, options?: ChatTurnHistoryOptions) =>
      getService().getChatTurns(workspaceId, agentId, options),
  );
  handle("chat:translate", (text: string) => getService().translateText(text));
  handle("translation:get", () => getService().getTranslationSettings());
  handle("translation:save", (settings) => getService().saveTranslationSettings(settings));
  handle("chat:send", (workspaceId: string, agentId: string, message: string) =>
    getService().sendChat(workspaceId, agentId, message),
  );
  handle("chat:cancel", (workspaceId: string, agentId: string) =>
    getService().cancelChat(workspaceId, agentId),
  );
  handle("chat:clear-context", (workspaceId: string) =>
    getService().clearChatContext(workspaceId),
  );
  handle("chat:compact-context", (workspaceId: string) =>
    getService().compactChatContext(workspaceId),
  );
  handle(
    "context:get",
    (workspaceId: string, agentId?: string, taskId?: string) =>
      getService().getContext(workspaceId, agentId, taskId),
  );
  // DESIGN §15.4：满血模式（会话级提示/预算覆盖）。
  handle("session:setFullThrottle", (workspaceId: string, agentId: string, enabled: boolean) => {
    getService().setFullThrottle(workspaceId, agentId, enabled);
  });
  // t64：交互画布索引 + 提问状态机（业务失败用返回值表达，不抛异常）。
  handle("chat:artifacts:list", (workspaceId: string, agentId?: string) =>
    getService().listChatArtifacts(workspaceId, agentId),
  );
  handle("chat:artifact:get", (workspaceId: string, artifactId: string) =>
    getService().getChatArtifact(workspaceId, artifactId),
  );
  handle("chat:questions:list", (workspaceId: string, agentId?: string) =>
    getService().listChatQuestions(workspaceId, agentId),
  );
  handle("chat:question:answer", (input: AnswerChatQuestionInput) =>
    getService().answerChatQuestion(input),
  );
  handle("chat:question:cancel", (input: CancelChatQuestionInput) =>
    getService().cancelChatQuestion(input),
  );
  // t96：Git 并行开发 / VCS / 合并队列
  handle("git:diagnose", (workspaceId: string) => getService().git.diagnose(workspaceId));
  handle("git:task-vcs", (taskId: string) => getService().git.getTaskVcs(taskId));
  handle("git:create-pr", (taskId: string) => getService().git.createPr(taskId));
  handle("git:cleanup", (taskId: string) => getService().git.cleanup(taskId));
  handle("git:open-pr", async (taskId: string) => {
    const url = await getService().git.openPrUrl(taskId);
    if (!url) return null;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:") return null;
    await shell.openExternal(parsed.toString());
    return parsed.toString();
  });
  handle("git:settings:get", (workspaceId: string) => getService().git.getSettings(workspaceId));
  handle("git:settings:save", (workspaceId: string, settings: Partial<GitSettings>) =>
    getService().git.saveSettings(workspaceId, settings),
  );
  handle("git:merge-queue", (workspaceId: string) => getService().git.listQueue(workspaceId));
  handle("git:merge-enqueue", (taskId: string) => getService().git.enqueue(taskId));
  handle("git:merge-approve", async (taskId: string) => {
    await getReview().assertMergeAllowed(taskId);
    return getService().git.approve(taskId);
  });
  handle("git:merge-waive", (taskId: string, reason: string) =>
    getService().git.waiveChecks(taskId, reason),
  );
  handle("git:merge-start", async (taskId: string) => {
    await getReview().assertMergeAllowed(taskId);
    return getService().git.mergeStart(taskId);
  });
  handle("git:merge-process", async (workspaceId: string) => {
    await getReview().assertQueueAllowed(workspaceId);
    return getService().git.processQueue(workspaceId);
  });
  handle("git:recover", (workspaceId: string) => getService().git.recover(workspaceId));
  // t301：只读版本图；参数先经 zod strict 校验
  handle("git:repo", (workspaceId: string) => {
    const parsed = gitWorkspaceIdSchema.safeParse(workspaceId);
    if (!parsed.success) return readBadParam();
    return getService().git.readRepo(parsed.data);
  });
  // t348：非 Git 工作区初始化；只接受 workspaceId，路径由主进程 Store 解析。
  handle("git:init-probe", (workspaceId: string) => {
    const parsed = gitWorkspaceIdSchema.safeParse(workspaceId);
    if (!parsed.success) return readBadParam();
    return getService().git.probeInit(parsed.data);
  });
  handle("git:init", (workspaceId: string) => {
    const parsed = gitWorkspaceIdSchema.safeParse(workspaceId);
    if (!parsed.success) return readBadParam();
    return getService().git.init(parsed.data);
  });
  handle("git:graph", (workspaceId: string, params?: unknown) => {
    const ws = gitWorkspaceIdSchema.safeParse(workspaceId);
    const body = gitGraphParamsSchema.safeParse(params ?? {});
    if (!ws.success || !body.success) return readBadParam();
    return getService().git.readGraph(ws.data, body.data);
  });
  handle("git:refs", (workspaceId: string, limit?: unknown) => {
    const ws = gitWorkspaceIdSchema.safeParse(workspaceId);
    const body = gitRefsParamsSchema.safeParse({ limit: typeof limit === "number" ? limit : 200 });
    if (!ws.success || !body.success) return readBadParam();
    return getService().git.readRefs(ws.data, body.data.limit);
  });
  handle("git:status", (workspaceId: string) => {
    const ws = gitWorkspaceIdSchema.safeParse(workspaceId);
    if (!ws.success) return readBadParam();
    return getService().git.readStatus(ws.data);
  });
  handle("git:commit", (workspaceId: string, sha: string) => {
    const ws = gitWorkspaceIdSchema.safeParse(workspaceId);
    const body = gitCommitParamsSchema.safeParse({ sha });
    if (!ws.success || !body.success) return readBadParam();
    return getService().git.readCommit(ws.data, body.data.sha);
  });
  handle("git:diff", (workspaceId: string, params?: unknown) => {
    const ws = gitWorkspaceIdSchema.safeParse(workspaceId);
    const body = gitDiffParamsSchema.safeParse(params);
    if (!ws.success || !body.success) return readBadParam();
    return getService().git.readDiff(ws.data, body.data);
  });
  // t352 G1：版本图本地写闭环。通道名 git:commit-create（git:commit 已被只读详情占用）。
  handle("git:stage", (workspaceId: string, paths?: unknown) => {
    const ws = gitWorkspaceIdSchema.safeParse(workspaceId);
    const body = gitWritePathsSchema.safeParse(paths ?? []);
    if (!ws.success || !body.success) return readBadParam();
    return getService().git.stage(ws.data, body.data);
  });
  handle("git:unstage", (workspaceId: string, paths?: unknown) => {
    const ws = gitWorkspaceIdSchema.safeParse(workspaceId);
    const body = gitWritePathsSchema.safeParse(paths ?? []);
    if (!ws.success || !body.success) return readBadParam();
    return getService().git.unstage(ws.data, body.data);
  });
  handle("git:commit-create", (workspaceId: string, title?: unknown, body?: unknown) => {
    const ws = gitWorkspaceIdSchema.safeParse(workspaceId);
    const titleParsed = gitCommitTitleSchema.safeParse(title ?? "");
    const bodyParsed = gitCommitBodySchema.safeParse(body ?? undefined);
    if (!ws.success || !titleParsed.success || !bodyParsed.success) return readBadParam();
    return getService().git.commitFiles(ws.data, { title: titleParsed.data, body: bodyParsed.data });
  });
  handle("git:ignore-preview", (workspaceId: string) => {
    const ws = gitWorkspaceIdSchema.safeParse(workspaceId);
    if (!ws.success) return readBadParam();
    return getService().git.ignorePreview(ws.data);
  });
  handle("git:ignore-apply", (workspaceId: string) => {
    const ws = gitWorkspaceIdSchema.safeParse(workspaceId);
    if (!ws.success) return readBadParam();
    return getService().git.ignoreApply(ws.data);
  });
  // t154：行级评审
  handle("review:summary", (taskId: string) => getReview().getSummary(taskId));
  handle("review:diff", (input: { taskId: string; file?: string; offset?: number; limit?: number }) =>
    getReview().getDiff(input.taskId, input),
  );
  handle("review:threads", (input: { taskId: string; file?: string; status?: string }) =>
    getReview().getThreads(input.taskId, input),
  );
  handle(
    "review:thread:create",
    (input: {
      taskId: string;
      filePath: string;
      side: "new" | "old";
      lineStart: number;
      lineEnd?: number;
      body: string;
      severity: ReviewSeverity;
    }) => getReview().createThread(input),
  );
  handle("review:thread:reply", (input: { taskId: string; threadId: string; body: string }) =>
    getReview().reply(input.taskId, input.threadId, input.body),
  );
  handle("review:comment:edit", (input: { taskId: string; commentId: string; body: string }) =>
    getReview().editComment(input.taskId, input.commentId, input.body),
  );
  handle("review:comment:delete", (input: { taskId: string; commentId: string }) =>
    getReview().deleteComment(input.taskId, input.commentId),
  );
  handle("review:thread:resolve", (input: { taskId: string; threadId: string; note?: string }) =>
    getReview().resolveThread(input.taskId, input.threadId, input.note),
  );
  handle("review:thread:reopen", (input: { taskId: string; threadId: string; note?: string }) =>
    getReview().reopenThread(input.taskId, input.threadId, input.note),
  );
  handle("review:thread:severity", (input: { taskId: string; threadId: string; severity: ReviewSeverity }) =>
    getReview().setSeverity(input.taskId, input.threadId, input.severity),
  );
  handle("review:decisions", (taskId: string) => getReview().getDecisions(taskId));
  handle(
    "review:decision",
    (input: {
      taskId: string;
      decision: ReviewDecision;
      headSha: string;
      notes?: string;
      clientRequestId?: string;
    }) => getReview().submitDecision(input),
  );
  handle(
    "review:reviewer:assign",
    (input: { taskId: string; reviewerId: string; role?: "reviewer" | "advisory" }) =>
      getReview().assignReviewer(input.taskId, input.reviewerId, input.role ?? "reviewer"),
  );
  handle("review:reviewer:remove", (input: { taskId: string; reviewerId: string; reason: string }) =>
    getReview().removeReviewer(input.taskId, input.reviewerId, input.reason),
  );
  handle(
    "review:reviewer:replace",
    (input: {
      taskId: string;
      fromReviewerId: string;
      toReviewerId: string;
      role?: "reviewer" | "advisory";
      reason: string;
    }) => getReview().replaceReviewer(input.taskId, input.fromReviewerId, input.toReviewerId, input.reason),
  );
  handle("review:ensure", (taskId: string) => getReview().ensureTarget(taskId));
  handle("review:config:get", (workspaceId: string) => getReview().getConfig(workspaceId));
  handle(
    "review:config:save",
    (workspaceId: string, patch: ReviewConfigPatch, options?: { confirmResets?: boolean }) =>
      getReview().saveConfig(workspaceId, patch, options),
  );
  // t123：记忆工作台 / MemoryService
  handle("memory:snapshot", (workspaceId: string, options?: MemorySnapshotOptions) =>
    getService().memory.snapshot(workspaceId, options),
  );
  handle("memory:search", (input: MemorySearchInput) => getService().memory.search(input));
  handle("memory:maintenance", (workspaceId?: string) => getService().memory.maintenance(workspaceId));
  handle(
    "memory:context",
    (input: {
      workspaceId: string;
      agentId?: string | null;
      taskId?: string | null;
      runId?: string | null;
      maxTokens?: number;
    }) => getService().memory.buildContext(input),
  );
  handle("board:create", (input: CreateMemoryBoardInput) => getService().memory.postBoard(input));
  handle("board:pin", (input: { workspaceId: string; entryId: string; pinned: boolean }) =>
    getService().memory.pin(input.workspaceId, input.entryId, input.pinned),
  );
  handle("board:verify", (input: { workspaceId: string; entryId: string; confidence?: "low" | "medium" | "high" }) =>
    getService().memory.verifyBoard(input.workspaceId, input.entryId, input.confidence),
  );
  handle("board:ttl", (input: { workspaceId: string; entryId: string; ttlDays: number | null }) =>
    getService().memory.setTtl(input.workspaceId, input.entryId, input.ttlDays),
  );
  handle(
    "board:archive-propose",
    (input: { workspaceId: string; entryId: string; reason?: "manual" | "stale"; note?: string }) =>
      getService().memory.proposeArchive(input.workspaceId, input.entryId, input.reason ?? "manual", input.note),
  );
  handle(
    "board:archive-decide",
    (input: { workspaceId: string; proposalId: string; decision: "approve" | "reject"; note?: string }) =>
      getService().memory.decideArchive(input.workspaceId, input.proposalId, input.decision, input.note),
  );
  handle("board:promote", (input: { workspaceId: string; entryId: string; kind?: "decision" | "fact" }) =>
    getService().memory.promoteBoard(input.workspaceId, input.entryId, input.kind ?? "decision"),
  );
  handle("board:restore", (input: { workspaceId: string; entryId: string }) =>
    getService().memory.restoreBoardEntry(input.workspaceId, input.entryId),
  );
  handle("memo:create", (input: CreateMemoryMemoInput) => getService().memory.createMemo(input));
  handle("memo:list", (workspaceId: string, agentId: string) =>
    getService().memory.listMemos(workspaceId, agentId),
  );
  handle("memo:verify", (input: { workspaceId: string; agentId: string; memoId: string }) =>
    getService().memory.verifyMemo(input.workspaceId, input.agentId, input.memoId),
  );
  handle("memo:archive", (input: { workspaceId: string; agentId: string; memoId: string }) =>
    getService().memory.archiveMemo(input.workspaceId, input.agentId, input.memoId),
  );
  handle("memo:promote", (input: { workspaceId: string; agentId: string; memoId: string; board: string }) =>
    getService().memory.promoteMemo(input.workspaceId, input.agentId, input.memoId, input.board),
  );
  handle("poll:list", (workspaceId: string, status?: PollStatus) =>
    getService().listPolls(workspaceId, status),
  );
  handle("poll:get", (workspaceId: string, pollId: string) =>
    getService().getPoll(workspaceId, pollId),
  );
  handle("poll:create", (input: CreatePollRequest) => getService().createPoll(input));
  handle("poll:cast", (workspaceId: string, input: CastPollRequest) =>
    getService().castPoll(workspaceId, input),
  );
  handle("poll:close", (workspaceId: string, input: ClosePollRequest) =>
    getService().closePoll(workspaceId, input),
  );
  // t58 IF-05：auto_risk 高风险 → 人类审批弹窗（主进程推送 + 人工回执，单次 requestId）。
  service?.onRiskApproval((request) => {
    win?.webContents.send("risk:approval", request);
  });
  handle("risk:approval_response", (requestId: string, approved: boolean) =>
    getService().respondRiskApproval(requestId, approved),
  );

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  service?.close();
});
