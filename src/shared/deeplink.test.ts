import { describe, expect, it } from "vitest";
import { buildHash, parseHash } from "./deeplink";

describe("parseHash（C12 深链解析）", () => {
  it("空 hash 落到任务页", () => {
    expect(parseHash("")).toEqual({
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
    });
  });

  it("解析 6 个合法 tab", () => {
    for (const tab of ["tasks", "team", "chat", "mailbox", "board", "settings"] as const) {
      expect(parseHash(`#/${tab}`).tab).toBe(tab);
    }
  });

  it("解析任务深链 #/tasks?t=t3", () => {
    const route = parseHash("#/tasks?t=t3");
    expect(route.tab).toBe("tasks");
    expect(route.task).toBe("t3");
  });

  it("解析 Run 面板深链 #/tasks?t=t3&r=run-2", () => {
    const route = parseHash("#/tasks?t=t3&r=run-2");
    expect(route.tab).toBe("tasks");
    expect(route.task).toBe("t3");
    expect(route.run).toBe("run-2");
  });

  it("解析对话任务上下文 #/chat?task=t5", () => {
    const route = parseHash("#/chat?task=t5");
    expect(route.tab).toBe("chat");
    expect(route.chatTask).toBe("t5");
  });

  it("解析邮箱与黑板深链", () => {
    expect(parseHash("#/mailbox?m=m1").message).toBe("m1");
    expect(parseHash("#/board?b=general").board).toBe("general");
  });

  it("解析 Git 入口深链：合并队列 / 设置 Git 区 / 任务 VCS", () => {
    expect(parseHash("#/tasks?t=t3&merge=1")).toMatchObject({
      tab: "tasks",
      task: "t3",
      mergeQueue: true,
      gitSettings: false,
      taskVcs: false,
    });
    expect(parseHash("#/settings?git=1")).toMatchObject({
      tab: "settings",
      gitSettings: true,
      mergeQueue: false,
      taskVcs: false,
    });
    expect(parseHash("#/tasks?t=t3&vcs=1")).toMatchObject({
      tab: "tasks",
      task: "t3",
      taskVcs: true,
      mergeQueue: false,
    });
    expect(parseHash("#/tasks?t=t3&review=1")).toMatchObject({
      tab: "tasks",
      task: "t3",
      taskReview: true,
    });
    // 非 1 值不误开
    expect(parseHash("#/tasks?t=t3&vcs=0").taskVcs).toBe(false);
  });

  it("解析 #/git 版本图深链", () => {
    const route = parseHash("#/git");
    expect(route.tab).toBe("tasks");
    expect(route.gitGraph).toBe(true);
    expect(route.redirected).toBe(true);
    expect(buildHash("tasks", { gitGraph: true })).toBe("#/git");
  });

  it("旧 #/router 深链重定向到任务页（C10 合并 7→6）", () => {
    const route = parseHash("#/router");
    expect(route.tab).toBe("tasks");
    expect(route.redirected).toBe(true);
  });

  it("未知 tab 回退到任务页且不标记重定向", () => {
    const route = parseHash("#/nope");
    expect(route.tab).toBe("tasks");
    expect(route.redirected).toBe(false);
  });
});

describe("buildHash（C12 深链生成）", () => {
  it("任务页携带选中任务", () => {
    expect(buildHash("tasks", { task: "t3" })).toBe("#/tasks?t=t3");
  });

  it("任务页携带 Run 选中（t69 Run 面板）", () => {
    expect(buildHash("tasks", { task: "t3", run: "run-2" })).toBe(
      "#/tasks?t=t3&r=run-2",
    );
    expect(parseHash("#/tasks?t=t3&r=run-2").run).toBe("run-2");
  });

  it("对话页携带任务上下文", () => {
    expect(buildHash("chat", { chatTask: "t5" })).toBe("#/chat?task=t5");
  });

  it("邮箱与黑板携带各自选中", () => {
    expect(buildHash("mailbox", { message: "m1" })).toBe("#/mailbox?m=m1");
    expect(buildHash("board", { board: "general" })).toBe("#/board?b=general");
  });

  it("非当前页的选中参数不会写入 hash", () => {
    expect(buildHash("settings", { task: "t3", message: "m1" })).toBe("#/settings");
    expect(buildHash("team", { task: null })).toBe("#/team");
  });

  it("永不生成旧 #/router 深链", () => {
    // router 不是 ROUTE_TABS 成员，类型层面即禁止；运行时防御检查：
    expect(buildHash("tasks")).not.toContain("router");
  });

  it("生成 Git 入口深链并往返一致", () => {
    const merge = buildHash("tasks", { task: "t3", mergeQueue: true });
    expect(merge).toBe("#/tasks?t=t3&merge=1");
    expect(parseHash(merge)).toMatchObject({ mergeQueue: true, task: "t3" });

    const git = buildHash("settings", { gitSettings: true });
    expect(git).toBe("#/settings?git=1");
    expect(parseHash(git).gitSettings).toBe(true);

    const vcs = buildHash("tasks", { task: "t3", taskVcs: true });
    expect(vcs).toBe("#/tasks?t=t3&vcs=1");
    expect(parseHash(vcs).taskVcs).toBe(true);
    const review = buildHash("tasks", { task: "t3", taskReview: true });
    expect(review).toBe("#/tasks?t=t3&review=1");
    expect(parseHash(review).taskReview).toBe(true);

    // team 只写 merge，不写 vcs；settings 不写任务参数
    expect(buildHash("team", { task: "t3", mergeQueue: true, taskVcs: true })).toBe(
      "#/team?t=t3&merge=1",
    );
    expect(buildHash("settings", { task: "t3", taskVcs: true, gitSettings: true })).toBe(
      "#/settings?git=1",
    );
  });

  it("parse(build(route)) 往返一致", () => {
    const hash = buildHash("chat", { chatTask: "t9" });
    const route = parseHash(hash);
    expect(route.tab).toBe("chat");
    expect(route.chatTask).toBe("t9");
  });
});
