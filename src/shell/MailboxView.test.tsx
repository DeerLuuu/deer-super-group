// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
vi.mock("../Modal.js", () => ({
  default: ({ children }: { children: unknown }) => children,
}));
import { MailboxView } from "../App.js";
import type { MailboxMessage, Snapshot } from "../shared/types.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
      findAllByProps: (props: Record<string, unknown>) => Array<{ props: Record<string, unknown> }>;
    };
    update: (element: unknown) => unknown;
    toJSON: () => unknown;
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mail(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    id: "m1",
    workspaceId: "ws",
    threadId: "t1",
    from: "Router",
    to: ["Builder"],
    kind: "request",
    subject: "Launch checklist",
    body: "Ready to ship",
    refs: [],
    createdAt: "2026-01-01T00:00:01Z",
    ...overrides,
  };
}

function snapshot(messages: MailboxMessage[]): Snapshot {
  return {
    workspace: { id: "ws", name: "Workspace", path: "S:/workspace" },
    agents: [
      { id: "a1", name: "Router" },
      { id: "a2", name: "Builder" },
    ],
    messages,
  } as unknown as Snapshot;
}

function renderView({
  messages,
  readIds = new Set<string>(),
  selectedMessageId = null,
  onSelectMessage = vi.fn(),
  onMarkRead = vi.fn(),
  onSend = vi.fn(async () => true),
}: {
  messages: MailboxMessage[];
  readIds?: ReadonlySet<string>;
  selectedMessageId?: string | null;
  onSelectMessage?: (id: string) => void;
  onMarkRead?: (ids: string[]) => void;
  onSend?: (input: unknown) => Promise<boolean>;
}) {
  let renderer: ReturnType<typeof create> | null = null;
  act(() => {
    renderer = create(
      <MailboxView
        snapshot={snapshot(messages)}
        busy={false}
        selectedMessageId={selectedMessageId}
        onSelectMessage={onSelectMessage}
        autoOpenCompose={false}
        onAutoOpenHandled={vi.fn()}
        onSend={onSend}
        readIds={readIds}
        onMarkRead={onMarkRead}
      />,
    );
  });
  return renderer!;
}

describe("t356 MailboxView threads", () => {
  it("renders one thread for same thread_id with unread aggregate and participants", () => {
    const root = mail();
    const reply = mail({
      id: "m2",
      from: "Builder",
      to: ["Router"],
      body: "Reply body",
      createdAt: "2026-01-01T00:00:02Z",
    });
    const renderer = renderView({ messages: [root, reply] });
    const list = renderer.root.findAllByProps({ role: "listbox" });
    expect(list).toHaveLength(1);
    const rows = renderer.root.findAllByProps({ role: "option" });
    expect(rows).toHaveLength(1);
    expect(rows[0].props["aria-label"]).toContain("2 封未读");
    expect(rows[0].props["aria-label"]).toContain("2 封");
    expect(JSON.stringify(renderer.toJSON())).toContain("Router · Builder");
  });

  it("selects a thread, marks its messages read, and shows the full reply chain", async () => {
    const root = mail();
    const reply = mail({
      id: "m2",
      from: "Builder",
      to: ["Router"],
      body: "Reply body",
      parentId: root.id,
      createdAt: "2026-01-01T00:00:02Z",
    });
    const onSelectMessage = vi.fn();
    const onMarkRead = vi.fn();
    const renderer = renderView({ messages: [root, reply], onSelectMessage, onMarkRead });
    await act(() => {
      (renderer.root.findAllByProps({ role: "option" })[0].props.onClick as () => void)();
    });
    expect(onSelectMessage).toHaveBeenCalledWith(root.id);
    expect(onMarkRead).toHaveBeenCalledWith([root.id, reply.id]);
    const output = JSON.stringify(renderer.toJSON());
    expect(output).toContain("Ready to ship");
    expect(output).toContain("Reply body");
    expect(output).toContain("回复链");
  });

  it("marks all messages read and respects the read set", async () => {
    const root = mail();
    const onMarkRead = vi.fn();
    const renderer = renderView({ messages: [root], onMarkRead });
    const allRead = renderer.root
      .findAllByType("button")
      .find((button) => String(button.props.children ?? "").includes("全部标为已读"));
    expect(allRead).toBeTruthy();
    await act(() => {
      (allRead!.props.onClick as () => void)();
    });
    expect(onMarkRead).toHaveBeenCalledWith([root.id]);

    const readRenderer = renderView({ messages: [root], readIds: new Set([root.id]) });
    expect(JSON.stringify(readRenderer.toJSON())).toContain("全部已读");
  });

  it("filters by search and member and shows a no-results empty state", async () => {
    const first = mail({ id: "m1", threadId: "t1", subject: "Launch checklist" });
    const second = mail({
      id: "m2",
      threadId: "t2",
      subject: "Review notes",
      from: "Builder",
      to: ["Reviewer"],
    });
    const renderer = renderView({ messages: [first, second] });
    const search = renderer.root.findAllByProps({ "aria-label": "搜索邮件线程" })[0];
    await act(() => {
      (search.props.onChange as (event: unknown) => void)({ target: { value: "review" } });
    });
    expect(renderer.root.findAllByProps({ role: "option" })).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).toContain("Review notes");

    const member = renderer.root.findAllByProps({ "aria-label": "按成员过滤" })[0];
    await act(() => {
      (member.props.onChange as (event: unknown) => void)({ target: { value: "Reviewer" } });
    });
    expect(renderer.root.findAllByProps({ role: "option" })).toHaveLength(1);

    await act(() => {
      (search.props.onChange as (event: unknown) => void)({ target: { value: "no such mail" } });
    });
    expect(renderer.root.findAllByProps({ role: "option" })).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain("没有匹配的线程");
  });

  it("opens a thread reply with context and sends the existing thread id", async () => {
    const root = mail();
    const onSend = vi.fn(async () => true);
    const renderer = renderView({ messages: [root], selectedMessageId: root.id, onSend });
    const reply = renderer.root
      .findAllByType("button")
      .find((button) => String(button.props.children ?? "").includes("回复线程"));
    expect(reply).toBeTruthy();
    await act(() => {
      (reply!.props.onClick as () => void)();
    });
    const form = renderer.root.findAllByType("form")[0];
    expect(form).toBeTruthy();
    const subject = renderer.root.findAllByProps({ "aria-label": "邮件主题" })[0];
    expect(subject.props.value).toBe("Re: Launch checklist");
    const textarea = renderer.root.findAllByType("textarea")[0];
    await act(() => {
      (textarea.props.onChange as (event: unknown) => void)({ target: { value: "Follow up" } });
    });
    await act(async () => {
      await (form.props.onSubmit as (event: unknown) => Promise<void>)({
        preventDefault: vi.fn(),
      });
    });
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Re: Launch checklist",
        body: "Follow up",
        threadId: "t1",
      }),
    );
  });

  it("keeps the selected expanded thread when a newer thread arrives at the top", async () => {
    const root = mail({ id: "root", threadId: "t1", subject: "Selected thread" });
    const newer = mail({
      id: "newer",
      threadId: "t2",
      subject: "Newest thread",
      createdAt: "2026-01-01T00:00:09Z",
    });
    const renderer = renderView({ messages: [root], selectedMessageId: root.id });
    expect(renderer.root.findAllByProps({ role: "option" })[0].props["aria-selected"]).toBe(true);
    await act(() => {
      renderer.update(
        <MailboxView
          snapshot={snapshot([newer, root])}
          busy={false}
          selectedMessageId={root.id}
          onSelectMessage={vi.fn()}
          autoOpenCompose={false}
          onAutoOpenHandled={vi.fn()}
          onSend={vi.fn(async () => true)}
          readIds={new Set()}
          onMarkRead={vi.fn()}
        />,
      );
    });
    const rows = renderer.root.findAllByProps({ role: "option" });
    expect(rows).toHaveLength(2);
    expect(rows[0].props["aria-label"]).toContain("Newest thread");
    const selectedRow = rows.find((row) => row.props["aria-selected"] === true);
    expect(selectedRow?.props["aria-label"]).toContain("Selected thread");
    expect(selectedRow?.props["data-expanded"]).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain("Selected thread");
  });
});
