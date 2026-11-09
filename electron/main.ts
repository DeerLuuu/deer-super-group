import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { AppService } from "../src/kernel/service.js";
import type {
  AnswerChatQuestionInput,
  CancelChatQuestionInput,
  CreateAgentInput,
  CreateTaskInput,
  LlmSettings,
  UpdateAgentInput,
  PostBoardInput,
  SendMessageInput,
} from "../src/shared/types.js";

let win: BrowserWindow | null = null;
let service: AppService | null = null;

function getService(): AppService {
  if (!service) {
    throw new Error("service is not ready");
  }
  return service;
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
  handle("agent:create", (input: CreateAgentInput) => getService().createAgent(input));
  handle("agent:update", (input: UpdateAgentInput) => getService().updateAgent(input));
  handle("task:create", (input: CreateTaskInput) => getService().createTask(input));
  handle("task:run", (taskId: string) => getService().runTask(taskId));
  handle("task:trace", (taskId: string) => getService().getTaskTrace(taskId));
  handle("router:plan", (workspaceId: string, goal: string) => getService().plan(workspaceId, goal));
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
  handle("chat:send", (workspaceId: string, message: string) =>
    getService().sendChat(workspaceId, message),
  );
  handle("chat:cancel", (workspaceId: string) => getService().cancelChat(workspaceId));
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
