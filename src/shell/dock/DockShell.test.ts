import { describe, expect, it } from "vitest";
import { reconcileSingleLayout } from "./DockShell";

type FakePanel = {
  group: { id: string };
  api: { close: () => void; setActive?: () => void };
};

describe("t212 reconcile legacy single dock layout", () => {
  it("moves a right-split Team into the main tab group and keeps it active", () => {
    const mainGroup = { id: "main" };
    const rightGroup = { id: "right" };
    const chat: FakePanel = { group: mainGroup, api: { close: () => {} } };
    const closed: string[] = [];
    const activated: string[] = [];
    let team: FakePanel | undefined = {
      group: rightGroup,
      api: {
        close: () => {
          closed.push("team");
          team = undefined;
        },
      },
    };
    const api = {
      activePanel: { id: "team" },
      getPanel(id: string) {
        if (id === "chat") return chat;
        if (id === "team") return team;
        return undefined;
      },
    };

    reconcileSingleLayout(api as never, "single", () => {
      team = {
        group: mainGroup,
        api: { close: () => {}, setActive: () => activated.push("team") },
      };
    });

    expect(closed).toEqual(["team"]);
    expect(team?.group).toBe(mainGroup);
    expect(team?.group).not.toBe(rightGroup);
    expect(activated).toEqual(["team"]);
    // active 仍是恢复后的 Team，而不是被 close 后落到 chat。
    expect(api.activePanel.id).toBe("team");
  });

  it("does nothing when Team is already a main-group tab", () => {
    const mainGroup = { id: "main" };
    const chat: FakePanel = { group: mainGroup, api: { close: () => {} } };
    const team: FakePanel = { group: mainGroup, api: { close: () => {} } };
    const api = {
      activePanel: { id: "chat" },
      getPanel: (id: string) => (id === "chat" ? chat : id === "team" ? team : undefined),
    };
    reconcileSingleLayout(api as never, "single", () => {
      throw new Error("must not re-add team");
    });
    expect(team.group).toBe(mainGroup);
  });

  it("leaves right splits alone on non-single variants", () => {
    const mainGroup = { id: "main" };
    const rightGroup = { id: "right" };
    const chat: FakePanel = { group: mainGroup, api: { close: () => {} } };
    const team: FakePanel = { group: rightGroup, api: { close: () => {} } };
    const api = {
      activePanel: { id: "chat" },
      getPanel: (id: string) => (id === "chat" ? chat : id === "team" ? team : undefined),
    };
    reconcileSingleLayout(api as never, "wide", () => {
      throw new Error("must not move team on wide");
    });
    expect(team.group).toBe(rightGroup);
  });
});
