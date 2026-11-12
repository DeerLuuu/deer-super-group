// C12：hash 路由与深链。
// 格式：#/tasks?t=<taskId> · #/team?t=<taskId> · #/chat?task=<taskId> ·
//       #/mailbox?m=<messageId> · #/board?b=<boardName> · #/settings
// t69：任务页/Run 面板共享 `r=<runId>`（仅在 Run 面板激活时写入，见 App）。
// t103：Git 入口深链 #/tasks?t=<taskId>&merge=1（合并队列）/
//       &vcs=1（任务 VCS）· #/settings?git=1（设置 Git 区）。
// C10 已把 Router 页合并进任务/对话页，旧 #/router 深链重定向到 #/tasks。

export const ROUTE_TABS = [
  "tasks",
  "team",
  "chat",
  "mailbox",
  "board",
  "settings",
  "context",
  "polls",
  "watchdog",
] as const;

export type RouteTab = (typeof ROUTE_TABS)[number];

/** 旧 tab 名 → 新 tab（C10 合并 7→6 后的兼容重定向）。 */
const TAB_ALIASES: Record<string, RouteTab> = {
  router: "tasks",
};

export type Route = {
  tab: RouteTab;
  /** 任务/团队页选中的任务 id（`t` 参数）。 */
  task: string | null;
  /** 对话页锁定的任务上下文 id（`task` 参数）。 */
  chatTask: string | null;
  /** 邮箱选中的消息 id（`m` 参数）。 */
  message: string | null;
  /** 黑板选中的板块名（`b` 参数）。 */
  board: string | null;
  /** t69：Run 面板选中的 Run id（`r` 参数；tasks tab 可选）。 */
  run: string | null;
  /** t103：打开合并队列 Modal（`merge=1`）。 */
  mergeQueue: boolean;
  /** t103：设置页聚焦 Git 区（`git=1`）。 */
  gitSettings: boolean;
  /** t103：任务页聚焦 VCS 区（`vcs=1`）。 */
  taskVcs: boolean;
  /** t154：任务页聚焦行级评审区（`review=1`）。 */
  taskReview: boolean;
  /** 是否由旧深链（如 #/router）重定向而来。 */
  redirected: boolean;
  /** 打开只读版本图（#/git）。 */
  gitGraph: boolean;
};

export const DEFAULT_ROUTE: Route = {
  tab: "tasks",
  task: null,
  chatTask: null,
  message: null,
  board: null,
  run: null,
  mergeQueue: false,
  gitSettings: false,
  taskVcs: false,
  taskReview: false,
  redirected: false,
  gitGraph: false,
};

function isRouteTab(value: string): value is RouteTab {
  return (ROUTE_TABS as readonly string[]).includes(value);
}

/** 无效的辅助路径回退到 #/tasks；空 hash/根 hash 保持默认启动行为。 */
export function normalizeHash(hash: string): string {
  if (!hash || hash === "#" || hash === "#/") return hash;
  const raw = hash.replace(/^#\/?/, "");
  const segment = (raw.split("?")[0]?.split("/")[0] ?? "").toLowerCase();
  if (segment === "git" || segment === "merge" || isRouteTab(segment) || segment in TAB_ALIASES) {
    if (segment in TAB_ALIASES) return "#/tasks";
    return isRouteTab(segment) ? `#/${segment}${hash.includes("?") ? `?${raw.split("?")[1]}` : ""}` : hash;
  }
  return "#/tasks";
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = raw.split("?");
  const segment = (path.split("/")[0] ?? "").toLowerCase();
  const params = new URLSearchParams(query);
  const gitGraph = segment === "git";
  const redirected = gitGraph || (!isRouteTab(segment) && segment in TAB_ALIASES);
  const tab = gitGraph ? "tasks" : isRouteTab(segment) ? segment : (TAB_ALIASES[segment] ?? "tasks");
  return {
    tab,
    task: params.get("t"),
    chatTask: params.get("task"),
    message: params.get("m"),
    board: params.get("b"),
    run: params.get("r"),
    mergeQueue: params.get("merge") === "1",
    gitSettings: params.get("git") === "1",
    taskVcs: params.get("vcs") === "1",
    taskReview: params.get("review") === "1",
    redirected,
    gitGraph,
  };
}

export type RouteSelection = {
  task?: string | null;
  chatTask?: string | null;
  message?: string | null;
  board?: string | null;
  /** t69：Run 面板选中的 Run id（仅 tasks tab 写入）。 */
  run?: string | null;
  mergeQueue?: boolean;
  gitSettings?: boolean;
  taskVcs?: boolean;
  taskReview?: boolean;
  gitGraph?: boolean;
};

export function buildHash(tab: RouteTab, selection: RouteSelection = {}): string {
  if (selection.gitGraph) return "#/git";
  const params = new URLSearchParams();
  if (tab === "tasks" || tab === "team") {
    if (selection.task) params.set("t", selection.task);
    if (tab === "tasks" && selection.run) params.set("r", selection.run);
    if (selection.mergeQueue) params.set("merge", "1");
    if (tab === "tasks" && selection.taskVcs) params.set("vcs", "1");
    if (tab === "tasks" && selection.taskReview) params.set("review", "1");
  } else if (tab === "chat") {
    if (selection.chatTask) params.set("task", selection.chatTask);
  } else if (tab === "mailbox") {
    if (selection.message) params.set("m", selection.message);
  } else if (tab === "board") {
    if (selection.board) params.set("b", selection.board);
  } else if (tab === "settings") {
    if (selection.gitSettings) params.set("git", "1");
  }
  const query = params.toString();
  return `#/${tab}${query ? `?${query}` : ""}`;
}
