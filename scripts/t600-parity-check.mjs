/**
 * t600：v2 parity 五向拖拽 + 双轴 sash + 三档 side-by-side 证据。
 * 前置：应用以 --remote-debugging-port 启动；v2 通过 localStorage deer.dock.engine=v2 加载。
 * 用法：node scripts/t600-parity-check.mjs <cdp-port> [outDir]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const port = Number(process.argv[2] ?? 9258);
const outDir = process.argv[3] ?? "docs/team";
mkdirSync(outDir, { recursive: true });
const results = [];
const failures = [];
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
  if (!ok) failures.push({ id, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${detail ?? ""}`);
};

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((item) => item.type === "page");
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  }
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(expression, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await evaluate(expression)) return true;
    } catch {
      /* reload */
    }
    await sleep(200);
  }
  return false;
}

async function setViewport(width, height, reload = true) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: width,
    screenHeight: height,
  });
  if (reload) {
    await sleep(150);
    await send("Page.reload", { ignoreCache: false });
    await waitFor(`!!document.querySelector(".docktree-shell, .dockview-container, .dv-dockview")`);
    await sleep(700);
  } else {
    await sleep(500);
  }
}

async function capture(name, width, height) {
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width, height, scale: 1 },
    captureBeyondViewport: false,
  });
  const file = path.join(outDir, name);
  const buffer = Buffer.from(shot.data, "base64");
  writeFileSync(file, buffer);
  record(`t600-${name}-dimensions`, buffer.readUInt32BE(16) === width && buffer.readUInt32BE(20) === height, `${width}x${height}`);
}

async function resetLayout() {
  const ok = await evaluate(`(() => {
    const sash = document.querySelector(".docktree-sash");
    if (!sash) return false;
    sash.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(1300);
  return ok;
}

async function clickTab(label) {
  const ok = await evaluate(`(() => {
    const tab = [...document.querySelectorAll(".docktree-tab")].find((node) => node.textContent.trim() === ${JSON.stringify(label)});
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  await sleep(250);
  return ok;
}

async function groupState() {
  return evaluate(`(() => [...document.querySelectorAll(".docktree-group")].map((group) => {
    const rect = group.getBoundingClientRect();
    return {
      id: group.dataset.group,
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      tabs: [...group.querySelectorAll(".docktree-tab")].map((tab) => tab.textContent.trim()),
      active: group.querySelector(".docktree-tab.active")?.textContent.trim() ?? null,
    };
  }))()`);
}

async function splitState() {
  return evaluate(`(() => [...document.querySelectorAll(".docktree-split")].map((split) => {
    const rect = split.getBoundingClientRect();
    return { axis: split.dataset.axis, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }))()`);
}

async function wideRoot() {
  return evaluate(`(() => {
    const key = Object.keys(localStorage).find((item) => item.startsWith("deer.dock.layout.v2."));
    if (!key) return null;
    try { return JSON.parse(localStorage.getItem(key))?.variants?.wide?.root ?? null; } catch { return null; }
  })()`);
}

async function drop(sourceLabel, targetLabel, direction) {
  const dx = { left: 0.1, right: 0.9, center: 0.5 }[direction] ?? 0.5;
  const dy = { above: 0.1, below: 0.9 }[direction] ?? 0.5;
  const value = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const tabs = [...document.querySelectorAll(".docktree-tab")];
    const source = tabs.find((tab) => tab.textContent.trim() === ${JSON.stringify(sourceLabel)});
    const targetTab = tabs.find((tab) => tab.textContent.trim() === ${JSON.stringify(targetLabel)});
    const targetBody = targetTab?.closest(".docktree-group")?.querySelector(".docktree-body");
    if (!source || !targetBody) return { error: "missing source/target" };
    const rect = targetBody.getBoundingClientRect();
    const x = rect.left + rect.width * ${dx};
    const y = rect.top + rect.height * ${dy};
    const dt = new DataTransfer();
    const fire = (type) => targetBody.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    await sleep(80);
    fire("dragenter");
    await sleep(80);
    fire("dragover");
    await sleep(60);
    fire("drop");
    await sleep(1400);
    return { panel: dt.getData("application/x-deer-panel"), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, point: { x, y } };
  })()`);
  return value;
}

async function verifyDirection(direction) {
  await setViewport(1440, 1000);
  await resetLayout();
  const before = await groupState();
  const beforeRoot = await wideRoot();
  const dropped = await drop("对话", "团队", direction);
  const after = await groupState();
  const splits = await splitState();
  const root = await wideRoot();
  const sourceGroup = after.find((group) => group.tabs.includes("对话"));
  const targetGroup = after.find((group) => group.tabs.includes("团队"));
  const horizontal = splits.some((split) => split.axis === "horizontal");
  const vertical = splits.some((split) => split.axis === "vertical");
  const center = direction === "center";
  const directionCorrect = center
    ? Boolean(targetGroup?.tabs.includes("对话")) && after.length === before.length
    : Boolean(sourceGroup && targetGroup) &&
      (direction === "left" ? sourceGroup.x < targetGroup.x : true) &&
      (direction === "right" ? sourceGroup.x > targetGroup.x : true) &&
      (direction === "above" ? sourceGroup.y < targetGroup.y : true) &&
      (direction === "below" ? sourceGroup.y > targetGroup.y : true) &&
      (direction === "left" || direction === "right" ? horizontal : vertical);
  record(
    `t600-${direction}-drop`,
    Boolean(dropped.panel) && directionCorrect && Boolean(root),
    JSON.stringify({ before, after, splits, beforeRoot, root, dropped, directionCorrect }),
  );
  await resetLayout();
  return { direction, before, after, splits, root, dropped, directionCorrect, axis: center ? null : (direction === "left" || direction === "right" ? "horizontal" : "vertical") };
}

// Ensure v2 opt-in only; default dockview remains untouched.
await evaluate(`localStorage.setItem("deer.dock.engine", "v2"); Object.keys(localStorage).filter((key) => key.startsWith("deer.dock.layout.v2.")).forEach((key) => localStorage.removeItem(key)); true`);
await setViewport(1440, 1000);
await resetLayout();
const v2Start = await evaluate(`({ trees: document.querySelectorAll(".docktree-shell").length, dockview: !!document.querySelector(".dockview-container, .dv-dockview") })`);
record("t600-v2-opt-in", v2Start.trees === 1 && !v2Start.dockview, JSON.stringify(v2Start));

const directions = {};
for (const direction of ["left", "right", "above", "below", "center"]) {
  directions[direction] = await verifyDirection(direction);
}

// 双轴 sash：above/below 后存在 vertical sash；拖动它，检查高度和 store。
await setViewport(1440, 1000);
await resetLayout();
await drop("对话", "团队", "above");
const verticalBefore = await groupState();
const verticalSash = await evaluate(`(() => {
  const sash = document.querySelector('.docktree-sash[data-axis="vertical"]');
  if (!sash) return null;
  const rect = sash.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
})()`);
let verticalAfter = verticalBefore;
let verticalSizes = [null, null];
if (verticalSash) {
  const beforeSizes = await wideRoot();
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: verticalSash.x, y: verticalSash.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: verticalSash.x, y: verticalSash.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: verticalSash.x, y: verticalSash.y + 60, button: "left", buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: verticalSash.x, y: verticalSash.y + 60, button: "left", clickCount: 1 });
  await sleep(1400);
  verticalAfter = await groupState();
  verticalSizes = [beforeSizes, await wideRoot()];
}
const verticalChanged = verticalSash && verticalBefore.some((group, index) => Math.abs(group.height - (verticalAfter[index]?.height ?? group.height)) > 10);
record("t600-vertical-sash", Boolean(verticalSash) && verticalChanged && JSON.stringify(verticalSizes[0]) !== JSON.stringify(verticalSizes[1]), JSON.stringify({ verticalSash, verticalBefore, verticalAfter, verticalSizes }));
await resetLayout();

// 键盘 resize + 双击恢复。
await setViewport(1440, 1000);
await resetLayout();
const keyboardBefore = await evaluate(`(() => { const key = Object.keys(localStorage).find((item) => item.startsWith("deer.dock.layout.v2.")); return key ? JSON.parse(localStorage.getItem(key)).variants.wide.root.sizes : null; })()`);
await evaluate(`(() => { const sash = document.querySelector(".docktree-sash"); if (!sash) return false; sash.focus(); sash.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); return true; })()`);
await sleep(1200);
const keyboardAfter = await evaluate(`(() => { const key = Object.keys(localStorage).find((item) => item.startsWith("deer.dock.layout.v2.")); return key ? JSON.parse(localStorage.getItem(key)).variants.wide.root.sizes : null; })()`);
await resetLayout();
const resetSizes = await evaluate(`(() => { const key = Object.keys(localStorage).find((item) => item.startsWith("deer.dock.layout.v2.")); return key ? JSON.parse(localStorage.getItem(key)).variants.wide.root.sizes : null; })()`);
record(
  "t600-sash-keyboard-reset",
  JSON.stringify(keyboardBefore) !== JSON.stringify(keyboardAfter) &&
    Array.isArray(resetSizes) && Math.abs(resetSizes[0] - 0.58) < 0.02 && Math.abs(resetSizes[1] - 0.42) < 0.02,
  JSON.stringify({ keyboardBefore, keyboardAfter, resetSizes }),
);

// 三档 v2 截图 + 几何。
const v2Geometry = {};
for (const [width, height] of [[1440, 1000], [960, 900], [480, 900]]) {
  await setViewport(width, height);
  await sleep(1200);
  await capture(`t600-v2-${width}.png`, width, height);
  v2Geometry[width] = { groups: await groupState(), splits: await splitState(), scrollW: await evaluate("document.documentElement.scrollWidth") };
}
record("t600-v2-widths", [1440, 960, 480].every((width) => v2Geometry[width].scrollW === width), JSON.stringify(v2Geometry));

// dockview 默认对照（同一 workspace；清空 v1 fixture 后默认布局，同数据基线）。
await evaluate(`Object.keys(localStorage).filter((key) => key.startsWith("deer.dock.v1.")).forEach((key) => localStorage.removeItem(key)); localStorage.setItem("deer.dock.engine", "dockview")`);
await setViewport(1440, 1000);
const dockviewStart = await evaluate(`({ dockview: !!document.querySelector(".dockview-container, .dv-dockview"), trees: document.querySelectorAll(".docktree-shell").length })`);
record("t600-dockview-default", dockviewStart.dockview && dockviewStart.trees === 0, JSON.stringify(dockviewStart));
const dockGeometry = {};
for (const [width, height] of [[1440, 1000], [960, 900], [480, 900]]) {
  await setViewport(width, height);
  await capture(`t600-dockview-${width}.png`, width, height);
  dockGeometry[width] = await evaluate(`({
    scrollW: document.documentElement.scrollWidth,
    groups: document.querySelectorAll(".dv-groupview").length,
    tabs: document.querySelectorAll(".dv-tab").length,
  })`);
}
record("t600-dockview-widths", [1440, 960, 480].every((width) => dockGeometry[width].scrollW === width), JSON.stringify(dockGeometry));

writeFileSync(
  path.join(outDir, "t600-parity-walkthrough.json"),
  JSON.stringify({ results, failures, directions, vertical: { verticalSash, verticalBefore, verticalAfter, verticalSizes }, v2Geometry, dockGeometry, v2Start, dockviewStart, at: new Date().toISOString() }, null, 2),
);
ws.close();
console.log(failures.length === 0 ? "ALL PASS" : `FAILURES: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
