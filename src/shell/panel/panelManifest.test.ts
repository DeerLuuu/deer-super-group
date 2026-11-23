import { describe, expect, it } from "vitest";
import {
  PANEL_MANIFESTS,
  getPanelManifest,
  indexPanelManifests,
  type PanelManifest,
} from "./panelManifest";
import { PANEL_LOADERS, isLazyPanelKey } from "./panelLoaders";
import { PANEL_DEFS, type PanelKey } from "../dock/panelRegistry";

describe("t568 MF1-1 PanelManifest", () => {
  it("covers every registry panel with title/group/icon/loader and preserves legacy metadata", () => {
    const registryKeys = Object.keys(PANEL_DEFS).sort();
    const manifestKeys = PANEL_MANIFESTS.map((manifest) => manifest.key).sort();
    expect(manifestKeys).toEqual(registryKeys);
    for (const manifest of PANEL_MANIFESTS) {
      expect(manifest.version).toBe(1);
      expect(manifest.title.trim()).not.toBe("");
      expect(manifest.group).toBeTruthy();
      expect(manifest.icon.trim()).not.toBe("");
      expect(manifest.loader).toBeTruthy();
      expect(manifest.minWidth).toBeGreaterThan(0);
      expect(manifest.minHeight).toBeGreaterThan(0);
      expect(PANEL_DEFS[manifest.key as PanelKey]).toMatchObject({
        key: manifest.key,
        title: manifest.title,
        component: manifest.component,
        routeTab: manifest.routeTab,
        renderer: manifest.renderer,
        minWidth: manifest.minWidth,
        minHeight: manifest.minHeight,
        closable: manifest.closable,
        defaultGroup: manifest.defaultGroup,
      });
    }
  });

  it("rejects duplicate keys and returns null for unknown panels", () => {
    const duplicate = [...PANEL_MANIFESTS, PANEL_MANIFESTS[0]!] as readonly PanelManifest[];
    expect(() => indexPanelManifests(duplicate)).toThrow("duplicate panel manifest");
    expect(getPanelManifest("nope")).toBeNull();
    expect(getPanelManifest("chat")?.key).toBe("chat");
  });

  it("maps every lazy manifest to the existing dynamic importer and keeps eager panels eager", async () => {
    const lazyManifests = PANEL_MANIFESTS.filter((manifest) => manifest.loader.kind === "lazy");
    expect(lazyManifests.map((manifest) => manifest.key).sort()).toEqual(
      Object.keys(PANEL_LOADERS).sort(),
    );
    for (const manifest of lazyManifests) {
      expect(isLazyPanelKey(manifest.key)).toBe(true);
      if (manifest.loader.kind === "lazy") {
        expect(typeof manifest.loader.load).toBe("function");
      }
    }
    const gitGraph = await PANEL_LOADERS.gitGraph();
    expect(typeof gitGraph.default).toBe("function");
    const mergeQueue = await PANEL_LOADERS.mergeQueue();
    expect(typeof mergeQueue.default).toBe("function");
  });
});
