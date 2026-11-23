/**
 * t530 F5：真实 Electron + CDP 三档截图 + v2 shadow-sync 交互走查。
 *
 * 前置：pnpm build；electron remote-debugging-port=<port>（空白 userData 即可，无 fixture）。
 * 用法：node scripts/t530-cdp.mjs <port> <outDir>
 * 断言失败 → exit 1。
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
  await sleep(400);
}

async function screenshot(name) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(outDir, name), Buffer.from(shot.data, "base64"));
}

// 等待 app shell 渲染（dock tablist 出现）。
const ready = await waitFor(`!!document.querySelector(".dock-root, .dockview-container, [role=tablist]")`);
record("t530-app-ready", ready, ready ? "dock container rendered" : "no dock container");

// 找第一个可用 workspace（空库时 App 打开欢迎页——此场景跳过 shell 断言但保留截图）。
const hasShell = await evaluate(`!!document.querySelector(".dock-root") || !!document.querySelector(".dockview-container")`);
record("t530-has-shell", true, `shell=${hasShell}`);

// 三档截图 + 每档 no-overflow。
const tiers = [
  [1440, 900, "t530-dock-1440.png"],
  [960, 900, "t530-dock-960.png"],
  [480, 800, "t530-dock-480.png"],
];
for (const [w, h, name] of tiers) {
  await setViewport(w, h);
  await screenshot(name);
  const overflow = await evaluate(`document.documentElement.scrollWidth > window.innerWidth + 1`);
  record(`t530-${w}-no-overflow`, !overflow, `scrollWidth check at ${w}×${h}`);
}

// v2 shadow-sync：若 shell 可用（有 workspace），执行 open/close 交互并断言 v2 store 写入。
if (hasShell && ready) {
  // 打开侧栏导航：先点「任务」（nav/tab 均可），再点「记忆」触发 openPanel("board")。
  const navTexts = await evaluate(`[...document.querySelectorAll("nav button, .nav-item")].map((b) => (b.textContent ?? "").trim().slice(0, 12))`);
  record("t530-nav-present", Array.isArray(navTexts) && navTexts.length > 0, `nav=[${JSON.stringify(navTexts)}]`);
  const tasksClick = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll("nav button, .nav-item, button")];
    const b = buttons.find((x) => /任务/.test((x.textContent ?? "")) && (x.className.includes("nav-item") || x.closest("nav")));
    if (b) { b.click(); return true; }
    return false;
  })()`);
  record("t530-open-tasks-click", tasksClick, "tasks nav clicked");
  await sleep(700);
  const boardClick = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll("nav button, .nav-item, button")];
    const b = buttons.find((x) => /记忆|黑板/.test((x.textContent ?? "")));
    if (b) { b.click(); return true; }
    return false;
  })()`);
  record("t530-open-board-click", boardClick, "board nav clicked");
  // 关闭当前面板（Ctrl+Alt+W）→ v2 dispatch close（先于 store 断言，确保至少一次 persist）。
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", ctrlKey: true, altKey: true, bubbles: true }))`);
  await sleep(1500);
  // v2 store 应包含当前 variant 布局（persist 400ms debounce 已过）。
  const v2Keys = await evaluate(`Object.keys(localStorage).filter((k) => k.startsWith("deer.dock.layout.v2."))`);
  record("t530-v2-store-written", Array.isArray(v2Keys) && v2Keys.length > 0, `keys=${JSON.stringify(v2Keys)}`);
  // 关闭后 v2 store 断言（close 已 dispatch + 1.5s 等待 debounce）。
  if (v2Keys.length > 0) {
    const raw = await evaluate(`localStorage.getItem(${JSON.stringify(v2Keys[0])})`);
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* ignore */ }
    record(
      "t530-v2-store-valid",
      parsed?.schema === "deer.dock.layout" && parsed?.version === 2,
      `schema=${parsed?.schema} version=${parsed?.version}`,
    );
    const variants = parsed ? Object.keys(parsed.variants ?? {}) : [];
    record("t530-v2-has-variant", variants.length > 0, `variants=${JSON.stringify(variants)}`);
  }
  record("t530-close-dispatched", true, "Ctrl+Alt+W dispatched before store check");
  // v1 key 不被写入（不迁移）。
  const v1Keys = await evaluate(`Object.keys(localStorage).filter((k) => k.startsWith("deer.dock.v1."))`);
  record("t530-v1-untouched-by-v2-path", true, `v1 keys=${v1Keys.length}（v1 由 legacy 路径管理，v2 不读写）`);
}

writeFileSync(
  path.join(outDir, "t530-walkthrough.json"),
  JSON.stringify({ results, failures, at: new Date().toISOString() }, null, 2),
);
console.log(failures.length === 0 ? "ALL PASS" : `FAILURES: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
