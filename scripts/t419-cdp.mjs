/**
 * t419 G6：真实 Electron + CDP 星图单击/双击走查与三档截图。
 *
 * 前置：pnpm build；播种 scripts/seedT419Fixture.test.ts；electron --user-data-dir=<seed db dir>。
 * 用法：node scripts/t419-cdp.mjs <port> <outDir>
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

async function waitFor(expression, { timeout = 15_000, label = expression } = {}) {
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
  await sleep(450);
}

async function shot(name) {
  const capture = await send("Page.captureScreenshot", { format: "png" });
  const file = path.join(outDir, name);
  writeFileSync(file, Buffer.from(capture.data, "base64"));
  console.log(`SHOT  ${file}`);
}

async function key(keyName, { code = keyName, modifiers = 0 } = {}) {
  const VK = { Enter: 13, Tab: 9, Escape: 27 };
  const vk = VK[keyName] ?? (code.length === 1 ? code.charCodeAt(0) : 0);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, modifiers, windowsVirtualKeyCode: vk, text: keyName === "Enter" ? "\r" : undefined });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, modifiers, windowsVirtualKeyCode: vk });
  await sleep(150);
}

const activePanel = `(async()=>{const ws=await window.deer.listWorkspaces();void ws;return location.hash})()`;
const nodeByTitle = (title) => `[...document.querySelectorAll('[data-star-node]')].find(b=>(b.getAttribute('aria-label')||'').startsWith(${JSON.stringify(title)}))`;

// 打开团队面板
await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('团队'));if(b)b.click();return true})()`);
const mapReady = await waitFor(`!!document.querySelector('[data-star-node]')`, { timeout: 25_000, label: "star nodes" });
record("starmap-ready", mapReady, "团队面板星图已渲染（3 节点依赖链）");

// aria 提示
record("aria-hint", await evaluate(`!!(${nodeByTitle("铺设基础接口")}) && ${nodeByTitle("铺设基础接口")}.getAttribute('aria-label').includes('单击查看概览，双击打开任务')`),
  "节点 aria-label 含单击/双击提示");

const hashBefore = await evaluate(activePanel);

// --- 单击：只弹浮窗，不切面板 ---
await setViewport(1440, 900);
await evaluate(`(()=>{const n=${nodeByTitle("铺设基础接口")};n.scrollIntoView({block:'center'});n.click();return true})()`);
const popoverShown = await waitFor(`!!document.querySelector('[aria-label^="任务概述：铺设基础接口"]')`, { timeout: 10_000, label: "popover" });
const hashAfterClick = await evaluate(activePanel);
record("single-click-popover", popoverShown, "单击打开概览浮窗");
// C12 深链：选中写入 ?t= 参数，但面板保持 team（不切 tasks / 不打开任务工作区）。
record("single-click-no-nav", hashAfterClick.startsWith("#/team") && !hashAfterClick.startsWith("#/tasks"), `单击后仍在团队面板（${hashBefore} → ${hashAfterClick}，仅附加选中参数）`);
await shot("t419-1440-popover.png");

// 浮窗两动作存在
record("popover-actions", await evaluate(`(()=>{const p=[...document.querySelectorAll('[aria-label^="任务概述"]')][0];if(!p)return false;const t=p.textContent;return t.includes('打开会话')&&t.includes('在任务页打开')})()`),
  "浮窗含「打开会话 / 在任务页打开」动作");

// Esc 关闭浮窗（焦点可能在浮窗或画布，两者都会走关闭路径）
await evaluate(`(()=>{const p=document.querySelector('[aria-label^="任务概述"]');if(p){const b=p.querySelector('button');if(b)b.focus()}})()`);
await key("Escape");
const escClosed = await waitFor(`!document.querySelector('[aria-label^="任务概述"]')`, { timeout: 4_000, label: "esc close" });
record("popover-esc", escClosed, "Esc 关闭浮窗");

// --- 双击：进入任务工作区 ---
await evaluate(`(()=>{const n=${nodeByTitle("补充集成测试")};n.scrollIntoView({block:'center'});n.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return true})()`);
const hashAfterDbl = await evaluate(activePanel);
const tasksPanelActive = await waitFor(`location.hash.startsWith('#/tasks')`, { timeout: 12_000, label: "tasks hash" });
record("double-click-nav", tasksPanelActive && hashAfterDbl.startsWith("#/tasks"), `双击后进入任务页（${hashAfterDbl}）`);
await shot("t419-1440-after-doubleclick.png");

// 回团队面板：键盘 Ctrl+Enter 等价
await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('团队'));if(b)b.click();return true})()`);
await waitFor(`!!document.querySelector('[data-star-node]')`, { timeout: 20_000, label: "star nodes again" });
await setViewport(1440, 900);
const focused = await evaluate(`(()=>{const n=${nodeByTitle("发布与文档")};n.focus();return document.activeElement===n})()`);
record("node-focusable", focused, "节点可聚焦");
await key("Enter", { modifiers: 2 });
const ctrlEnterNav = await waitFor(`location.hash.startsWith('#/tasks')`, { timeout: 12_000, label: "ctrl-enter nav" });
record("ctrl-enter-nav", ctrlEnterNav, "Ctrl+Enter 与双击等价（进入任务页）");

// --- 三档截图（团队面板星图 + 单击浮窗态）---
for (const width of [960, 480]) {
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('团队'));if(b)b.click();return true})()`);
  await waitFor(`!!document.querySelector('[data-star-node]')`, { timeout: 20_000, label: `nodes ${width}` });
  await setViewport(width, 800);
  await sleep(300);
  record(`no-overflow-${width}`, await evaluate(`document.documentElement.scrollWidth <= ${width + 1}`), `${width} 档 scrollWidth=${await evaluate("document.documentElement.scrollWidth")}`);
  await shot(`t419-${width}-starmap.png`);
}

writeFileSync(path.join(outDir, "t419-walkthrough.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
if (failures.length) {
  console.error("FAILURES:", JSON.stringify(failures, null, 2));
  process.exit(1);
}
ws.close();
process.exit(0);
