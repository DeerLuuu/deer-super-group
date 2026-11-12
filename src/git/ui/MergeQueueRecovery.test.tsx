// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MergeQueuePanel } from "./MergeQueuePanel";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => { root: any; toJSON: () => unknown; unmount: () => void };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function EntryHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" aria-label="sidebar-merge-queue" onClick={() => setOpen(true)}>sidebar</button>
      <button type="button" aria-label="team-merge-queue" onClick={() => setOpen(true)}>team</button>
      <button type="button" aria-label="launcher-merge-queue" onClick={() => setOpen(true)}>launcher</button>
      <button type="button" aria-label="close-merge-queue" onClick={() => setOpen(false)}>close</button>
      {open ? <MergeQueuePanel workspaceId="ws" items={[]} onReload={() => undefined} /> : null}
    </div>
  );
}

function click(root: any, label: string) {
  const button = root.findByProps({ "aria-label": label });
  expect(button).toBeTruthy();
  act(() => button.props.onClick());
}

describe("t315 MergeQueue entry recovery clicks", () => {
  it("reopens from sidebar, Team and launcher after close", () => {
    (globalThis as { window?: unknown }).window = { deer: {} };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<EntryHarness />);
    });
    const root = renderer.root;
    click(root, "sidebar-merge-queue");
    expect(JSON.stringify(renderer.toJSON())).toContain("队列为空");
    click(root, "close-merge-queue");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("队列为空");
    click(root, "team-merge-queue");
    expect(JSON.stringify(renderer.toJSON())).toContain("队列为空");
    click(root, "close-merge-queue");
    click(root, "launcher-merge-queue");
    expect(JSON.stringify(renderer.toJSON())).toContain("队列为空");
    act(() => renderer.unmount());
  });
});
