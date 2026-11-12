export type FirstRunActionKind =
  | "workspace"
  | "settings-model"
  | "settings-key"
  | "team"
  | "chat"
  | "plan";

export interface FirstRunCheck {
  key: "workspace" | "model" | "credentials" | "member";
  label: string;
  ok: boolean;
  detail: string;
}

export interface FirstRunState {
  ready: boolean;
  show: boolean;
  workspaceName: string;
  workspacePath: string;
  modelDetail: string;
  keyDetail: string;
  mock: boolean;
  workerCount: number;
  checks: FirstRunCheck[];
  action: { kind: FirstRunActionKind; label: string };
}

export function deriveFirstRunState(input: {
  workspaceName: string;
  workspacePath: string;
  tasksCount: number;
  messagesCount: number;
  workerCount: number;
  modelCount: number;
  modelId: string;
  modelLabel: string;
  mock: boolean;
  keyReady: boolean;
}): FirstRunState {
  const workspaceReady = input.workspacePath.trim().length > 0;
  const modelReady = input.modelCount > 0 && Boolean(input.modelId);
  const credentialsReady = input.mock || input.keyReady;
  const memberReady = input.workerCount > 0;
  const ready = workspaceReady && modelReady && credentialsReady && memberReady;
  const checks: FirstRunCheck[] = [
    {
      key: "workspace",
      label: "工作区",
      ok: workspaceReady,
      detail: workspaceReady ? input.workspacePath : "尚未打开工作区",
    },
    {
      key: "model",
      label: "模型",
      ok: modelReady,
      detail: modelReady ? input.modelLabel || input.modelId : "尚未添加模型",
    },
    {
      key: "credentials",
      label: "Key / Mock",
      ok: credentialsReady,
      detail: input.mock
        ? "Mock 模式：不调用真实 provider"
        : input.keyReady
          ? "Key 已配置（环境或本地）"
          : "未配置 Key",
    },
    {
      key: "member",
      label: "成员",
      ok: memberReady,
      detail: `${input.workerCount} 位可执行成员`,
    },
  ];
  let action: FirstRunState["action"];
  if (!workspaceReady) action = { kind: "workspace", label: "打开工作区" };
  else if (!modelReady) action = { kind: "settings-model", label: "去设置模型" };
  else if (!credentialsReady) action = { kind: "settings-key", label: "配置 API Key" };
  else if (!memberReady) action = { kind: "team", label: "创建团队成员" };
  else if (input.tasksCount === 0 && input.messagesCount === 0) {
    action = { kind: "chat", label: "开始对话" };
  } else action = { kind: "plan", label: "规划任务" };

  return {
    ready,
    show: !ready || (input.tasksCount === 0 && input.messagesCount === 0),
    workspaceName: input.workspaceName,
    workspacePath: input.workspacePath,
    modelDetail: modelReady ? input.modelLabel || input.modelId : "尚未添加模型",
    keyDetail: input.mock
      ? "Mock 模式"
      : input.keyReady
        ? "Key 已配置"
        : "未配置 Key",
    mock: input.mock,
    workerCount: input.workerCount,
    checks,
    action,
  };
}
