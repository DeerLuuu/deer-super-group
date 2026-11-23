/**
 * t548 DW1-3：真实 Electron + CDP 走查。
 * v2 引擎（默认）：三档截图、tab 点击激活、nav 打开、关闭、sash aria、
 * v2 store 持久化 + 重启恢复；切 dockview 引擎对照。
 * 用法：node scripts/t548-cdp.mjs <port> <outDir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const port = Number(process.argv[2] ?? 9233);
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
const page = list.find((t) => t.type === "page");
if (!page) { console.error("no page target"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
let wsClosed = false;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (wsClosed) { reject(new Error("cdp socket closed")); return; }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, 20_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.onclose = () => { wsClosed = true; console.error("CDP socket closed"); };
ws.onerror = () => { wsClosed = true; console.error("CDP socket error"); };
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};
await new Promise((resolve) => { ws.onopen = resolve; });
await send("Page.enable");
await send("Runtime.enable");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(`evaluate failed: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ""}`);
  }
  return result.result.value;
}

async function waitFor(expression, { timeout = 15_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await evaluate(expression)) return true;
    } catch { /* transient */ }
    await sleep(250);
  }
  return false;
}

async function setViewport(width, height) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
}

async function screenshot(name) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(outDir, name), Buffer.from(shot.data, "base64"));
}

// v2 引擎渲染检查。
const hasTree = await waitFor(`!!document.querySelector(".docktree-root")`);
record("t548-v2-engine-active", hasTree, hasTree ? "docktree-root rendered (DOCK_ENGINE=v2 default)" : "no docktree-root");

if (hasTree) {
  const tabCount = await evaluate(`document.querySelectorAll(".docktree-tab").length`);
  record("t548-tabs-rendered", tabCount >= 2, `tabs=${tabCount}`);
  const sashCount = await evaluate(`document.querySelectorAll('.docktree-sash[role="separator"]').length`);
  record("t548-sash-aria", sashCount >= 1, `role=separator sash=${sashCount}`);

  // tab 点击激活（aria-selected 迁移）——点击后等待 React 重渲染再断言。
  const tabClicked = await evaluate(`(() => {
    const tab = [...document.querySelectorAll(".docktree-tab")].find((t) => (t.textContent ?? "").includes("任务"));
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  await sleep(400);
  const activated = tabClicked
    ? await evaluate(`(() => {
        const tab = [...document.querySelectorAll(".docktree-tab")].find((t) => (t.textContent ?? "").includes("任务"));
        return tab?.getAttribute("aria-selected") ?? "missing";
      })()`)
    : "no-tab";
  record("t548-tab-activate", activated === "true", `aria-selected=${activated}`);

  // nav 打开默认关闭面板（记忆）。
  const boardNav = await evaluate(`(() => {
    const b = [...document.querySelectorAll("nav button, .nav-item")].find((x) => /记忆|黑板/.test(x.textContent ?? ""));
    if (b) { b.click(); return true; } return false;
  })()`);
  record("t548-nav-open-board", boardNav, "board nav clicked");
  await sleep(900);

  // 关闭当前面板（Ctrl+Alt+W）。
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", ctrlKey: true, altKey: true, bubbles: true }))`);
  await sleep(900);

  // v2 store 写入（轮询等待 debounce 400ms + 渲染）。
  const v2Written = await waitFor(
    `Object.keys(localStorage).some((k) => k.startsWith("deer.dock.layout.v2."))`,
    { timeout: 6000 },
  );
  const v2Keys = await evaluate(`Object.keys(localStorage).filter((k) => k.startsWith("deer.dock.layout.v2."))`);
  record("t548-v2-store-written", v2Written && v2Keys.length > 0, `keys=${JSON.stringify(v2Keys)}`);

  // 三档截图 + 无溢出。
  for (const [w, h, name] of [
    [1440, 900, "t548-v2-1440.png"],
    [960, 900, "t548-v2-960.png"],
    [480, 800, "t548-v2-480.png"],
  ]) {
    await setViewport(w, h);
    await screenshot(name);
    const overflow = await evaluate(`document.documentElement.scrollWidth > window.innerWidth + 1`);
    record(`t548-${w}-no-overflow`, !overflow, `scrollWidth check at ${w}×${h}`);
  }

  // 持久化 → 刷新恢复（v2 store 读回）。
  const variantAfterReload = await evaluate(`(() => { location.reload(); return "reloading"; })()`);
  void variantAfterReload;
  await sleep(2500);
  const restored = await waitFor(`!!document.querySelector(".docktree-root")`);
  record("t548-reload-v2-restored", restored, "docktree-root after reload");
  const v2KeysAfter = await evaluate(`Object.keys(localStorage).filter((k) => k.startsWith("deer.dock.layout.v2."))`);
  record("t548-v2-store-survives-reload", v2KeysAfter.length > 0, `keys=${v2KeysAfter.length}`);

  // 切旧引擎对照：localStorage 标记 + reload → dockview 容器。
  await evaluate(`localStorage.setItem("deer.dock.engine", "dockview")`);
  await evaluate(`location.reload()`);
  await sleep(3000);
  const legacy = await evaluate(`!!document.querySelector(".dockview-container") || !!document.querySelector(".dockview-drag-overlay") || !!document.querySelector(".dv-") || document.querySelectorAll("[data-panel]").length > 0`);
  record("t548-legacy-engine-switchable", legacy, "dockview engine renders after deer.dock.engine=dockview");
  await setViewport(1440, 900);
  await screenshot("t548-legacy-1440.png");
  // 切回 v2。
  await evaluate(`localStorage.setItem("deer.dock.engine", "v2")`);
  await evaluate(`location.reload()`);
  await sleep(2500);
}

writeFileSync(
  path.join(outDir, "t548-walkthrough.json"),
  JSON.stringify({ results, failures, at: new Date().toISOString() }, null, 2),
);
console.log(failures.length === 0 ? "ALL PASS" : `FAILURES: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
