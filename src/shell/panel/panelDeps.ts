import type { PanelDeps } from "./PanelHost";

/**
 * R2 panel domain deps（可测试的真实生产实现）。
 * App 每次 render 传入当前 slices；PanelHostProvider 按数组元素引用比较。
 *
 * 注意：新增 panel 消费字段时必须同步加入对应数组，否则该 panel 会读到旧内容。
 * mailbox 的收件人列表来自 agents，因此 mailbox deps 必须含 agents。
 */
export type PanelDepsInput = {
  agents?: unknown;
  chatRouter?: unknown;
  tasks?: unknown;
  workspace?: unknown;
  workspaceId?: unknown;
  runs?: unknown;
  settings?: unknown;
  boardEntries?: unknown;
  messages?: unknown;

  selectedTask?: unknown;
  selectedTaskId?: unknown;
  trace?: unknown;
  busy?: unknown;
  taskStatusFilter?: unknown;
  createIntent?: unknown;
  scheduler?: unknown;
  schedulerLoading?: unknown;
  schedulerError?: unknown;
  taskRuns?: unknown;
  runsLoading?: unknown;
  runsError?: unknown;
  selectedRunId?: unknown;
  actionBusy?: unknown;
  actionError?: unknown;
  watchdogAlerts?: unknown;
  watchdogHandoffs?: unknown;
  taskWorkspaceSource?: unknown;
  starmapFocus?: unknown;

  planDraft?: unknown;
  planSource?: unknown;
  planIssues?: unknown;
  planBusy?: unknown;
  planError?: unknown;
  planConfirming?: unknown;

  chatMessages?: unknown;
  chatTurnsByAssistant?: unknown;
  chatTurnByUser?: unknown;
  questionsByKey?: unknown;
  questionsLoaded?: unknown;
  pendingQuestions?: unknown;
  chatBusy?: unknown;
  chatInput?: unknown;
  chatView?: unknown;
  chatTrajectory?: unknown;
  chatTrajectoryLoading?: unknown;
  contextTaskId?: unknown;
  contextSource?: unknown;
  chatContextBusy?: unknown;
  chatFullThrottle?: unknown;
  workspaceOverview?: unknown;

  context?: unknown;
  selectedMessageId?: unknown;
  selectedBoard?: unknown;
  pollIntent?: unknown;
  watchdogSnapshot?: unknown;
  watchdogCosts?: unknown;
};

export function buildPanelDeps(input: PanelDepsInput): PanelDeps {
  return {
    planDraft: [
      input.planDraft,
      input.planSource,
      input.planIssues,
      input.planBusy,
      input.planError,
      input.planConfirming,
      input.agents,
    ],
    tasks: [
      input.tasks,
      input.agents,
      input.workspace,
      input.selectedTask,
      input.selectedTaskId,
      input.trace,
      input.busy,
      input.taskStatusFilter,
      input.createIntent,
      input.scheduler,
      input.schedulerLoading,
      input.schedulerError,
      input.taskRuns,
      input.runsLoading,
      input.runsError,
      input.selectedRunId,
      input.actionBusy,
      input.actionError,
      input.watchdogAlerts,
      input.watchdogHandoffs,
      input.taskWorkspaceSource,
    ],
    team: [
      input.tasks,
      input.agents,
      input.runs,
      input.workspace,
      input.busy,
      input.scheduler,
      input.starmapFocus,
      input.createIntent,
      // t276：TeamDashboard 的成员模型下拉读 snapshot.settings.models/providers。
      input.settings,
    ],
    runs: [
      input.tasks,
      input.runs,
      input.agents,
      input.scheduler,
      input.schedulerLoading,
      input.schedulerError,
      input.taskRuns,
      input.runsLoading,
      input.runsError,
      input.trace,
      input.selectedTaskId,
      input.selectedRunId,
      input.actionBusy,
      input.taskWorkspaceSource,
    ],
    chat: [
      input.chatMessages,
      input.chatTurnsByAssistant,
      input.chatTurnByUser,
      input.questionsByKey,
      input.questionsLoaded,
      input.pendingQuestions,
      input.chatBusy,
      input.chatInput,
      input.chatView,
      input.chatTrajectory,
      input.chatTrajectoryLoading,
      input.contextTaskId,
      input.contextSource,
      input.chatContextBusy,
      input.chatFullThrottle,
      input.chatRouter,
      input.settings,
      input.workspaceOverview,
    ],
    context: [input.context, input.contextTaskId],
    // t270 F1：MailboxComposeModal 收件人列表来自 agents；成员增删改必须 bump mailbox。
    mailbox: [
      input.messages,
      input.busy,
      input.selectedMessageId,
      input.createIntent,
      input.agents,
    ],
    board: [input.boardEntries, input.agents, input.selectedBoard, input.createIntent],
    polls: [input.workspaceId, input.agents, input.pollIntent],
    watchdog: [input.watchdogSnapshot, input.watchdogCosts, input.selectedTaskId],
    settings: [input.settings],
    gitGraph: [input.workspaceId],
  };
}
