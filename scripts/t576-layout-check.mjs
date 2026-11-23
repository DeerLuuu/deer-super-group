/**
 * t576：在真实 Electron/Chromium DOM 中验证 DockTree 面板根撑满 group body。
 *
 * 用法：node scripts/t576-layout-check.mjs <cdp-port> [outDir]
 * 前置：以 --remote-debugging-port=<port> 启动应用。
 *
 * 断言（不是只看 group 外框）：
 *   active .docktree-panel 的直接 panel 根 clientWidth / .docktree-body clientWidth >= 0.95
 * 覆盖 chat / tasks / board / team；并截 1440/960/480 图。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const port = Number(process.argv[2] ?? 9255);
const outDir = process.argv[3] ?? "docs/team";
mkdirSync(outDir, { recursive: true });

const results = [];
const failures = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  if (!ok) failures.push({ id, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${detail ?? ""}`);
}

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((item) => item.type === "page");
if (!page) {
  console.error("no page target");
  process.exit(1);
}
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
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
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

async function waitFor(expression, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await evaluate(expression)) return true;
    } catch {
      // execution context may be replaced by reload
    }
    await sleep(200);
  }
  return false;
}

async function setViewport(width, height) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: width,
    screenHeight: height,
  });
  // Emulation 改变 innerWidth 不会稳定触发 App 的 resize state；reload 让
  // windowWidth/dockWidth 以真实新视口初始化（测试夹具，不修改布局存档）。
  await sleep(150);
  await send("Page.reload", { ignoreCache: false });
  await waitFor(`!!document.querySelector(".docktree-shell")`);
  await sleep(900);
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
  const pngWidth = buffer.readUInt32BE(16);
  const pngHeight = buffer.readUInt32BE(20);
  record(`t576-${name}-dimensions`, pngWidth === width && pngHeight === height, `${pngWidth}x${pngHeight}`);
}

async function clickTab(label) {
  const found = await evaluate(`(() => {
    const tab = [...document.querySelectorAll(".docktree-tab")].find((node) => node.textContent.trim() === ${JSON.stringify(label)});
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  if (!found) return false;
  await sleep(350);
  return true;
}

async function measure(label, slug) {
  const value = await evaluate(`(() => {
    const tab = [...document.querySelectorAll(".docktree-tab")].find((node) => node.textContent.trim() === ${JSON.stringify(label)});
    if (!tab) return { error: "tab missing" };
    const group = tab.closest(".docktree-group");
    const body = group?.querySelector(".docktree-body");
    const panel = group?.querySelector(".docktree-panel.active");
    const child = panel?.firstElementChild;
    if (!body || !panel || !child) return { error: "panel/body missing" };
    return {
      panel: panel.dataset.panel,
      panelWidth: panel.clientWidth,
      panelHeight: panel.clientHeight,
      bodyWidth: body.clientWidth,
      bodyHeight: body.clientHeight,
      childClass: child.className,
      childWidth: child.clientWidth,
      childHeight: child.clientHeight,
      ratio: body.clientWidth > 0 ? child.clientWidth / body.clientWidth : 0,
    };
  })()`);
  record(`t576-${slug}-stretch`, !value.error && value.ratio >= 0.95 && value.childWidth > 0, JSON.stringify(value));
  return value;
}

await send("Page.enable");
await send("Runtime.enable");
await evaluate(`Object.keys(localStorage).filter((key) => key.startsWith("deer.dock.layout.v2.")).forEach((key) => localStorage.removeItem(key)); true`);
await setViewport(1440, 1000);
const ready = await evaluate(`!!document.querySelector(".docktree-shell")`);
record("t576-docktree-ready", ready, ready ? "docktree-shell" : "not found");

const panels = [
  ["对话", "chat"],
  ["任务", "tasks"],
  ["记忆", "board"],
  ["团队", "team"],
];
const measurements = {};
for (const [label, slug] of panels) {
  const clicked = await clickTab(label);
  record(`t576-${slug}-tab`, clicked, label);
  if (!clicked) continue;
  measurements[slug] = await measure(label, slug);
  await capture(`t576-${slug}-1440.png`, 1440, 1000);
}

for (const [width, height] of [
  [960, 900],
  [480, 900],
]) {
  await setViewport(width, height);
  for (const [label, slug] of panels) {
    const clicked = await clickTab(label);
    record(`t576-${slug}-${width}-tab`, clicked, label);
    if (!clicked) continue;
    measurements[`${slug}${width}`] = await measure(label, `${slug}-${width}`);
    await capture(`t576-${slug}-${width}.png`, width, height);
  }
}

async function resetLayout() {
  const ok = await evaluate(`(() => {
    const sash = document.querySelector(".docktree-sash");
    if (!sash) return false;
    sash.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(1500);
  return ok;
}

async function readWideSizes() {
  return evaluate(`(() => {
    const key = Object.keys(localStorage).find((item) => item.startsWith("deer.dock.layout.v2."));
    if (!key) return null;
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
      return parsed?.variants?.wide?.root?.sizes ?? null;
    } catch {
      return null;
    }
  })()`);
}

async function groupRects() {
  return evaluate(`[...document.querySelectorAll(".docktree-group")].map((group) => ({
    id: group.dataset.group,
    width: group.getBoundingClientRect().width,
    x: group.getBoundingClientRect().x,
  }))`);
}

await setViewport(1440, 1000);
await resetLayout();

// 普通 hover 时没有落点提示；拖拽目标 dragover 才按指针显示唯一 position。
const hoverNormal = await evaluate(`(() => ({
  active: document.querySelectorAll(".docktree-drop-position.active").length,
  total: document.querySelectorAll(".docktree-drop-position").length,
}))()`);
record("t576-dropzone-normal-hidden", hoverNormal.active === 0, JSON.stringify(hoverNormal));

const dragState = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const tabs = [...document.querySelectorAll(".docktree-tab")];
  const source = tabs.find((tab) => tab.textContent.trim() === "任务");
  const targetTab = tabs.find((tab) => tab.textContent.trim() === "团队");
  const targetGroup = targetTab?.closest(".docktree-group");
  const targetBody = targetGroup?.querySelector(".docktree-body");
  const rect = targetBody?.getBoundingClientRect();
  const dt = new DataTransfer();
  const fire = (x, y, type) => targetBody.dispatchEvent(new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    dataTransfer: dt,
    clientX: x,
    clientY: y,
  }));
  source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
  await sleep(100);
  const afterStart = targetGroup.querySelectorAll(".docktree-drop-position.active").length;
  fire(rect.left + rect.width / 2, rect.top + rect.height / 2, "dragenter");
  await sleep(80);
  fire(rect.left + rect.width * 0.1, rect.top + rect.height * 0.5, "dragover");
  await sleep(80);
  const left = [...targetGroup.querySelectorAll(".docktree-drop-position.active")].map((node) => node.dataset.position);
  fire(rect.left + rect.width * 0.9, rect.top + rect.height * 0.5, "dragover");
  await sleep(80);
  const right = [...targetGroup.querySelectorAll(".docktree-drop-position.active")].map((node) => node.dataset.position);
  fire(rect.left + rect.width * 0.5, rect.top + rect.height * 0.5, "dragover");
  await sleep(80);
  const center = [...targetGroup.querySelectorAll(".docktree-drop-position.active")].map((node) => node.dataset.position);
  targetBody.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, dataTransfer: dt }));
  source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
  await sleep(80);
  return { afterStart, left, right, center, afterEnd: targetGroup.querySelectorAll(".docktree-drop-position.active").length };
})()`);
record(
  "t576-dropzone-single-position",
  dragState.afterStart === 0 &&
    dragState.left.length === 1 && dragState.left[0] === "left" &&
    dragState.right.length === 1 && dragState.right[0] === "right" &&
    dragState.center.length === 1 && dragState.center[0] === "center" &&
    dragState.afterEnd === 0,
  JSON.stringify(dragState),
);
await resetLayout();

// sash 指针拖动：真实 CDP mouse 事件 → group 宽度 + v2 store 都变化。
const sashBefore = await evaluate(`(() => {
  const sash = document.querySelector(".docktree-sash");
  if (!sash) return null;
  const rect = sash.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
})()`);
const rectsBefore = await groupRects();
const sizesBefore = await readWideSizes();
if (sashBefore) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sashBefore.x, y: sashBefore.y });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: sashBefore.x,
    y: sashBefore.y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: sashBefore.x + 90,
    y: sashBefore.y,
    button: "left",
    buttons: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: sashBefore.x + 90,
    y: sashBefore.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(1500);
}
const rectsAfter = await groupRects();
const sizesAfter = await readWideSizes();
const widthDelta = Math.abs((rectsAfter[1]?.width ?? 0) - (rectsBefore[1]?.width ?? 0));
record(
  "t576-sash-drag",
  Boolean(sashBefore) && widthDelta > 20 && JSON.stringify(sizesBefore) !== JSON.stringify(sizesAfter),
  JSON.stringify({ rectsBefore, rectsAfter, sizesBefore, sizesAfter, widthDelta }),
);

// 双击恢复默认 0.58/0.42。
await resetLayout();
const sizesReset = await readWideSizes();
record(
  "t576-sash-double-click-reset",
  Array.isArray(sizesReset) &&
    Math.abs(sizesReset[0] - 0.58) < 0.02 &&
    Math.abs(sizesReset[1] - 0.42) < 0.02,
  JSON.stringify(sizesReset),
);

// 键盘 ArrowRight 改变尺寸；随后双击恢复。
const keyboardBefore = await readWideSizes();
await evaluate(`document.querySelector(".docktree-sash")?.focus()`);
await evaluate(`(() => {
  const sash = document.querySelector(".docktree-sash");
  if (!sash) return false;
  sash.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  return true;
})()`);
await sleep(1200);
const keyboardAfter = await readWideSizes();
record(
  "t576-sash-keyboard",
  JSON.stringify(keyboardBefore) !== JSON.stringify(keyboardAfter),
  JSON.stringify({ keyboardBefore, keyboardAfter }),
);
await resetLayout();

// tab 拖入另一 group center：任务进入团队组；随后双击恢复。
const centerDrop = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const tabs = [...document.querySelectorAll(".docktree-tab")];
  const source = tabs.find((tab) => tab.textContent.trim() === "任务");
  const targetTab = tabs.find((tab) => tab.textContent.trim() === "团队");
  const target = targetTab?.closest(".docktree-group")?.querySelector(".docktree-body");
  if (!source || !target) return { error: "missing" };
  const rect = target.getBoundingClientRect();
  const dt = new DataTransfer();
  const fire = (x, y, type) => target.dispatchEvent(new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    dataTransfer: dt,
    clientX: x,
    clientY: y,
  }));
  source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
  await sleep(100);
  fire(rect.left + rect.width / 2, rect.top + rect.height / 2, "dragenter");
  await sleep(100);
  fire(rect.left + rect.width / 2, rect.top + rect.height / 2, "dragover");
  fire(rect.left + rect.width / 2, rect.top + rect.height / 2, "drop");
  source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
  return { panel: dt.getData("application/x-deer-panel") };
})()`);
await sleep(600);
const centerGroups = await groupRects();
const centerHasTasks = await evaluate(`[...document.querySelectorAll(".docktree-group")].some((group) => group.dataset.group !== "group-main" && [...group.querySelectorAll(".docktree-tab")].some((tab) => tab.textContent.trim() === "任务"))`);
record("t576-tab-drop-center", Boolean(centerDrop.panel) && centerHasTasks && centerGroups.length === 2, JSON.stringify({ centerDrop, centerGroups, centerHasTasks }));
await resetLayout();

// tab 拖到 team 组右侧 edge：产生第三个 group；随后双击恢复。
const edgeDrop = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const tabs = [...document.querySelectorAll(".docktree-tab")];
  const source = tabs.find((tab) => tab.textContent.trim() === "对话");
  const targetTab = tabs.find((tab) => tab.textContent.trim() === "团队");
  const targetGroup = targetTab?.closest(".docktree-group");
  const targetBody = targetGroup?.querySelector(".docktree-body");
  if (!source || !targetBody) return { error: "missing" };
  const rect = targetBody.getBoundingClientRect();
  const dt = new DataTransfer();
  const fire = (x, y, type) => targetBody.dispatchEvent(new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    dataTransfer: dt,
    clientX: x,
    clientY: y,
  }));
  source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
  await sleep(100);
  fire(rect.left + rect.width / 2, rect.top + rect.height / 2, "dragenter");
  await sleep(100);
  fire(rect.right - 8, rect.top + rect.height / 2, "dragover");
  await sleep(80);
  fire(rect.right - 8, rect.top + rect.height / 2, "drop");
  source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
  return { panel: dt.getData("application/x-deer-panel") };
})()`);
await sleep(600);
const edgeGroups = await groupRects();
record("t576-tab-drop-edge", Boolean(edgeDrop.panel) && edgeGroups.length === 3, JSON.stringify({ edgeDrop, edgeGroups }));
await resetLayout();

// t604：settings 不是默认 tab（仍可通过启动器打开）；默认不应出现关闭设置按钮。
const settingsState = await evaluate(`(() => {
  const tab = [...document.querySelectorAll(".docktree-tab")].find((node) => node.textContent.trim() === "设置");
  const group = tab?.closest(".docktree-group");
  return { present: Boolean(tab), active: group?.querySelector(".docktree-tab.active")?.textContent.trim(), closeButtons: group?.querySelectorAll(".docktree-group-close").length ?? 0 };
})()`);
record("t576-settings-not-default", !settingsState.present, JSON.stringify(settingsState));
await resetLayout();
const store = await evaluate(`(() => {
  const key = Object.keys(localStorage).find((item) => item.startsWith("deer.dock.layout.v2."));
  if (!key) return { key: null };
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
    const variant = parsed?.variants?.wide;
    return { key, wideSizes: variant?.root?.sizes ?? null, variant: variant?.variant ?? null };
  } catch {
    return { key, parseError: true };
  }
})()`);
record(
  "t576-store-sizes",
  Array.isArray(store.wideSizes) &&
    store.wideSizes.length === 2 &&
    Math.abs(store.wideSizes[0] - 0.58) < 0.02 &&
    Math.abs(store.wideSizes[1] - 0.42) < 0.02,
  JSON.stringify(store),
);

await clickTab("团队");
const beforeClose = (await groupRects()).length;
const closeResult = await evaluate(`(() => {
  const tab = [...document.querySelectorAll(".docktree-tab")].find((node) => node.textContent.trim() === "团队");
  const group = tab?.closest(".docktree-group");
  const button = group?.querySelector(".docktree-group-close");
  if (!button) return { closed: false, reason: "no button" };
  button.click();
  return { closed: true };
})()`);
await sleep(600);
const afterClose = (await groupRects()).length;
record("t576-close-tab", closeResult.closed && afterClose === beforeClose - 1, JSON.stringify({ closeResult, beforeClose, afterClose }));
await clickTab("对话");
const activeChat = await evaluate(`document.querySelector(".docktree-panel.active")?.dataset.panel`);
record("t576-activate-tab", activeChat === "chat", String(activeChat));

writeFileSync(
  path.join(outDir, "t576-layout-walkthrough.json"),
  JSON.stringify({ results, failures, measurements, store, at: new Date().toISOString() }, null, 2),
);
ws.close();
console.log(failures.length === 0 ? "ALL PASS" : `FAILURES: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
