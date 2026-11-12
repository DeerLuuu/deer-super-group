/**
 * t389：真实 Electron + CDP 三档截图与 UI/aria 走查驱动。
 *
 * 前置：
 *   1) pnpm build（本 worktree）
 *   2) 播种：DSGITWRITE_SEED_DB/REPO/KIND pnpm vitest run scripts/seedGitwriteFixture.test.ts
 *   3) electron <worktree> --remote-debugging-port=9233 --user-data-dir=<SEED_DB 目录>
 *
 * 用法：node scripts/gitwrite-cdp.mjs <port> <mode: normal|unborn> <outDir>
 * 输出：<outDir>/t352-*.png 截图 + t389-walkthrough-<mode>.json 断言报告。
 * 任何断言失败 → exit 1 并列出失败项。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const port = Number(process.argv[2] ?? 9233);
const mode = process.argv[3] ?? "normal";
const outDir = process.argv[4] ?? "docs/team";
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
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`cdp timeout: ${method}`));
    }, 20_000);
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
// t389：窗口被遮挡时 rAF 会被节流；Dock variant 切换依赖 rAF，必须开启 focus emulation。
await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
await send("Page.bringToFront").catch(() => {});

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
  await send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(300);
  // CDP 的 device metrics 不会自动触发 app 的 resize 监听；必须显式通知 React，
  // 否则 Dock/侧栏仍按旧视口布局，截图会出现「480 像素图 + 1424 布局」。
  await evaluate("window.dispatchEvent(new Event('resize'))");
  await sleep(800);
}

async function shot(name) {
  const capture = await send("Page.captureScreenshot", { format: "png" });
  const file = path.join(outDir, name);
  writeFileSync(file, Buffer.from(capture.data, "base64"));
  console.log(`SHOT  ${file}`);
  return name;
}

/** 通过 CDP Input 管道发送真实键盘事件。 */
const VK = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 };
async function key(keyName, { code = keyName, modifiers = 0, text } = {}) {
  const vk = VK[keyName] ?? (code.length === 1 ? code.charCodeAt(0) : 0);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, modifiers, windowsVirtualKeyCode: vk, text: text ?? (keyName === "Enter" ? "\r" : undefined) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, modifiers, windowsVirtualKeyCode: vk });
  await sleep(120);
}

/** 等待包含 text 且未禁用的按钮出现后再点击（React 状态 flush 后按钮才可用）。 */
async function clickEnabled(text, { exclude, timeout = 12_000 } = {}) {
  const excludeClause = exclude ? ` && !b.textContent.includes(${JSON.stringify(exclude)})` : "";
  const found = await waitFor(
    `[...document.querySelectorAll('button')].some(b=>b.textContent.includes(${JSON.stringify(text)})${excludeClause} && !b.disabled)`,
    { timeout, label: `button ${text} enabled` },
  );
  if (!found) return false;
  return evaluate(
    `(async()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(text)})${excludeClause} && !b.disabled);if(!btn)return false;btn.scrollIntoView({block:'center'});btn.click();return true})()`,
  );
}

/** 勾选文件行 checkbox（限定 git 工作区文件列表）。 */
async function checkFileRow(fileName) {
  return evaluate(`(()=>{
    const labels=[...document.querySelectorAll('.git-check')];
    const row=labels.find(l=>l.textContent.includes(${JSON.stringify(fileName)}));
    if(!row) return false;
    const b=row.querySelector('input[type=checkbox]');
    if(!b) return false;
    b.scrollIntoView({block:'center'});
    if(!b.checked) b.click();
    return b.checked;
  })()`);
}

/** 用 CDP Input 真实鼠标事件点击按钮（走完整浏览器管线，含表单隐式提交）。 */
async function clickRealMouse(text, { exclude, timeout = 15_000 } = {}) {
  const excludeClause = exclude ? ` && !b.textContent.includes(${JSON.stringify(exclude)})` : "";
  const found = await waitFor(
    `[...document.querySelectorAll('button')].some(b=>b.textContent.includes(${JSON.stringify(text)})${excludeClause} && !b.disabled)`,
    { timeout, label: `button ${text} enabled` },
  );
  if (!found) return false;
  const rect = await evaluate(`(()=>{
    const b=[...document.querySelectorAll('button')].find(e=>e.textContent.includes(${JSON.stringify(text)})${excludeClause} && !e.disabled);
    if(!b) return null;
    b.scrollIntoView({block:'center'});
    const r=b.getBoundingClientRect();
    return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});
  })()`);
  if (!rect) return false;
  const { x, y } = JSON.parse(rect);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(150);
  return true;
}

/** 通过 form.requestSubmit() 触发提交（真实浏览器表单管线：约束校验 + submit 事件 + React onSubmit）。 */
async function submitCommitForm() {
  return evaluate(`(()=>{
    const form=document.querySelector('form[aria-label="提交已暂存文件"]');
    if(!form) return false;
    form.requestSubmit();
    return true;
  })()`);
}

async function fillCommitTitle(title) {
  return evaluate(`(()=>{
    const input=document.querySelector('form[aria-label="提交已暂存文件"] input');
    if(!input) return false;
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(input,${JSON.stringify(title)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
}

/** 填写提交标题并校验 React 受控回读；必要时重试（组件刷新竞争会重置 state）。 */
async function fillTitleVerified(title, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await fillCommitTitle(title);
    await sleep(250);
    if (await evaluate(`document.querySelector('form[aria-label="提交已暂存文件"] input')?.value === ${JSON.stringify(title)}`)) {
      return true;
    }
  }
  return false;
}

const stagedGroupText = `(()=>{const h=[...document.querySelectorAll('h4')].find(x=>x.textContent.includes('已暂存'));return h?h.textContent:''})()`;

/** 视口切换可能触发 Dock 重挂面板（view 重置）；关键步骤前确保回到「工作区」tab。 */
async function ensureWorkspaceTab() {
  await evaluate(`(()=>{
    if(!document.querySelector('[id="git-graph-tab-workspace"]')){
      const nav=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('版本图'));
      if(nav) nav.click();
    }
    return true;
  })()`);
  await waitFor(`!!document.querySelector('[id="git-graph-tab-workspace"]')`, { timeout: 15_000, label: "git tabs" });
  await evaluate(`(()=>{
    const tab=document.querySelector('[id="git-graph-tab-workspace"]');
    if(tab && tab.getAttribute('aria-selected')!=='true') tab.click();
    return true;
  })()`);
  return waitFor(`!!document.querySelector('.git-commit-box')`, { timeout: 15_000, label: "commit box" });
}

/** t389：视口切换后等 Dock 重挂 + 工作区数据真正就绪，避免截到加载骨架。 */
async function ensureWorkspaceSettled() {
  await ensureWorkspaceTab();
  await waitFor(
    `!!document.querySelector('.git-commit-box') && !document.body.innerText.includes('正在加载面板')`,
    { timeout: 20_000, label: "workspace panel settled" },
  );
  await sleep(350);
}

/** t389：窄窗截到写 UI 而不是只看到图/空态顶部。 */
async function scrollToWriteUi() {
  await evaluate(`(()=>{
    const target=document.querySelector('.git-commit-box') ?? document.querySelector('.git-group-head');
    target?.scrollIntoView({block:'start'});
    return true;
  })()`);
  await sleep(250);
}

/** t389：窄窗截图收起占高度的首用卡，并把工作区明细滚到分组头部。 */
async function prepareNarrowWriteShot() {
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>(e.textContent||'').trim()==='稍后');b?.click();return true;})()`);
  await sleep(350);
  await ensureWorkspaceSettled();
  await evaluate(`(()=>{const d=document.querySelector('.git-graph-detail'); if(d)d.scrollTop=0; const g=document.querySelector('.git-group-head'); g?.scrollIntoView({block:'start'}); return true;})()`);
  await sleep(250);
}

// ---------------------------------------------------------------------------
// 0. 等应用就绪，打开版本图面板 → 工作区 tab
// ---------------------------------------------------------------------------
const ready = await waitFor(`!!document.querySelector('[aria-label="版本图"], [id="git-graph-tab-workspace"]')`, {
  timeout: 25_000,
  label: "git graph entry",
});
record("app-ready", ready, "版本图入口已挂载");
await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('版本图'));if(b){b.click();return true}return false})()`);
await waitFor(`!!document.querySelector('[id="git-graph-tab-workspace"]')`, { timeout: 15_000, label: "git tabs" });
await evaluate(`document.querySelector('[id="git-graph-tab-workspace"]')?.click()`);
await waitFor(`!!document.querySelector('.git-commit-box')`, { timeout: 15_000, label: "commit box" });

// ---------------------------------------------------------------------------
// 1. aria / 键盘可达性
// ---------------------------------------------------------------------------
record("aria-select-all",
  await evaluate(`!!document.querySelector('input[aria-label="全选未暂存文件"]') && !!document.querySelector('input[aria-label="全选已暂存文件"]')`),
  "全选 checkbox 具备 aria-label");
record("aria-commit-form",
  await evaluate(`!!document.querySelector('form[aria-label="提交已暂存文件"]')`),
  "提交表单 aria-label");
record("aria-ignore-button",
  await evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('生成 .gitignore'))?.title`),
  ".gitignore 按钮带 title 说明");
record("tabs-roving",
  await evaluate(`!!document.querySelector('[role="tablist"][aria-label="版本视图"]')`),
  "版本视图 tablist 存在（roving tabindex 基线）");

await evaluate(`document.activeElement?.blur?.()`);
await key("Tab");
await key("Tab");
const tabFocusTarget = await evaluate(`document.activeElement ? document.activeElement.tagName + '.' + (document.activeElement.id || document.activeElement.className || '') : 'none'`);
record("keyboard-tab", tabFocusTarget !== "none" && tabFocusTarget !== "BODY.", `Tab 后焦点位于 ${tabFocusTarget}`);

// ---------------------------------------------------------------------------
// 2. 无暂存时提交禁用
// ---------------------------------------------------------------------------
const submitDisabledNoStaged = await evaluate(`(()=>{
  const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('个文件）'));
  return { disabled: btn?.disabled ?? null, text: btn?.textContent ?? null };
})()`);
record("submit-disabled-no-staged", submitDisabledNoStaged.disabled === true, JSON.stringify(submitDisabledNoStaged));

// ---------------------------------------------------------------------------
// 3. normal：勾选 → 暂存 → 分组迁移 → 三档截图 → guard → Modal → Enter → 闭环提交
// ---------------------------------------------------------------------------
if (mode === "normal") {
  const hasUnstaged = await waitFor(
    `[...document.querySelectorAll('.git-check')].some(l=>l.textContent.includes('.ts')||l.textContent.includes('.md'))`,
    { timeout: 12_000, label: "fixture changes" },
  );
  record("fixture-has-changes", hasUnstaged, "fixture 工作区改动出现在未暂存分组");

  const checked = await checkFileRow("feature.ts");
  record("checkbox-toggles", checked === true, "勾选 feature.ts 生效");

  const staged = await clickEnabled("暂存选中", { exclude: "取消" });
  const migrated = await waitFor(`(()=>{const t=${stagedGroupText};return t.includes('已暂存') && !t.includes('(0')})()`, { timeout: 15_000, label: "staged group non-empty" });
  record("group-migration", staged && migrated, `文件迁移到已暂存分组（${await evaluate(stagedGroupText)}）`);

  await setViewport(1440, 900);
  await ensureWorkspaceSettled();
  await shot("t352-1440-write-ui.png");
  await setViewport(960, 800);
  await prepareNarrowWriteShot();
  record("no-overflow-960", await evaluate(`document.documentElement.scrollWidth <= 961`), `960 档 scrollWidth=${await evaluate("document.documentElement.scrollWidth")}`);
  await shot("t352-960-write-ui.png");
  await setViewport(480, 800);
  await prepareNarrowWriteShot();
  record("no-overflow-480", await evaluate(`document.documentElement.scrollWidth <= 481`), `480 档 scrollWidth=${await evaluate("document.documentElement.scrollWidth")}`);
  await shot("t352-480-write-ui.png");
  await setViewport(1440, 900);

  // 4. CommitGuard inline 拒绝：stage .env → 提交 → role=alert
  await ensureWorkspaceTab();
  const envChecked = await checkFileRow(".env");
  const envStagedClick = await clickEnabled("暂存选中", { exclude: "取消" });
  const envInStaged = await waitFor(`(()=>{const t=${stagedGroupText};return t.includes('(2')})()`, { timeout: 12_000, label: "two staged" });
  record("env-staged", envChecked && envStagedClick && envInStaged, `.env 进入已暂存分组（${await evaluate(stagedGroupText)}）`);

  await ensureWorkspaceTab();
  // 先等上一轮写操作彻底结束（提交按钮恢复「提交（N 个文件）」且可点）。
  await waitFor(
    `!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('提交（') && !b.disabled)`,
    { timeout: 60_000, label: "commit btn idle" },
  );
  let fillOk = false;
  let titleEchoOk = false;
  let blocked = false;
  for (let attempt = 0; attempt < 3 && !titleEchoOk; attempt += 1) {
    fillOk = await fillCommitTitle("feat: should be blocked");
    await sleep(200);
    titleEchoOk = await evaluate(`document.querySelector('form[aria-label="提交已暂存文件"] input')?.value === 'feat: should be blocked'`);
  }
  if (titleEchoOk) {
    // 观测 2s：title 是否被重置 / 按钮是否被禁用（定位隐性重挂或 busy 竞争）。
    const monitor = [];
    for (let tick = 0; tick < 8; tick += 1) {
      await sleep(250);
      monitor.push(await evaluate(`(()=>{
        const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('提交') && b.textContent.includes('文件'));
        const input=document.querySelector('form[aria-label="提交已暂存文件"] input');
        return JSON.stringify({at:Date.now()%100000,v:input?input.value.slice(0,8):null,b:btn?{d:btn.disabled,x:btn.textContent.slice(0,10)}:null});
      })()`));
    }
    console.log("GUARD-MONITOR", monitor.join(" ; "));
    blocked = await submitCommitForm();
    if (blocked) {
      const after = [];
      for (let tick = 0; tick < 8; tick += 1) {
        await sleep(1000);
        after.push(await evaluate(`(()=>{
          const input=document.querySelector('form[aria-label="提交已暂存文件"] input');
          return JSON.stringify({v:input?input.value.slice(0,6):null,a:!!document.querySelector('[role=alert]'),ok:!!document.querySelector('.git-write-ok'),s:document.querySelector('.git-write-error')?.textContent?.slice(0,20)??null});
        })()`));
      }
      console.log("GUARD-AFTER", after.join(" ; "));
    }
  }
  const alertShown = await waitFor(`!!document.querySelector('[role=alert]')`, { timeout: 15_000, label: "guard alert" });
  const alertText = await evaluate(`document.querySelector('[role=alert]')?.textContent ?? ''`);
  record("guard-inline-alert", blocked && alertShown && alertText.includes(".env"), `fill=${fillOk} echo=${titleEchoOk} alert=${alertText.slice(0, 60)}`);
  await shot("t352-1440-guard-blocked.png");

  // 5. .gitignore 预览 Modal（含「仅追加」声明）→ Esc 关闭
  await ensureWorkspaceTab();
  const ignoreClicked = await clickEnabled("生成 .gitignore");
  const modalShown = await waitFor(`!!document.querySelector('[role="dialog"][aria-label="生成 .gitignore"]')`, { timeout: 10_000, label: "ignore modal" });
  record("ignore-modal", ignoreClicked && modalShown, ".gitignore 预览 Modal 打开");
  const modalText = await evaluate(`document.querySelector('[role="dialog"]')?.textContent ?? ''`);
  record("ignore-modal-append-only", modalText.includes("不覆盖任何现有文件") && modalText.includes("node_modules/"), "Modal 含「不覆盖现有文件」声明与模板行");
  await shot("t352-1440-ignore-modal.png");
  await setViewport(960, 800);
  await shot("t352-960-ignore-modal.png");
  await setViewport(1440, 900);
  await key("Escape");
  const modalClosed = await evaluate(`!document.querySelector('[role="dialog"]')`);
  record("ignore-modal-esc", modalClosed, "Esc 关闭 Modal（C25 焦点路径）");

  // 6. 键盘 Enter 激活「暂存选中」（真实 Input 管道；勾选「未暂存」分组的行）
  await ensureWorkspaceTab();
  const enterPrepared = await evaluate(`(()=>{
    const section=[...document.querySelectorAll('section')].find(s=>s.querySelector('h4')?.textContent.includes('未暂存'));
    if(!section) return false;
    const row=[...section.querySelectorAll('.git-check')].find(l=>!l.textContent.includes('node_modules') && !l.textContent.includes('.env'));
    if(!row) return false;
    const box=row.querySelector('input[type=checkbox]');
    if(!box) return false;
    if(!box.checked) box.click();
    return true;
  })()`);
  const enterBtnFocused = await evaluate(`(()=>{
    const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('暂存选中') && !b.textContent.includes('取消') && !b.disabled);
    if(!btn) return false; btn.focus(); return true;
  })()`);
  record("keyboard-enter-focusable", enterPrepared && enterBtnFocused, "已勾选文件且「暂存选中」可聚焦未禁用");
  const stagedBeforeEnter = await evaluate(stagedGroupText);
  await key("Enter");
  const enterWorked = await waitFor(
    `(()=>{const t=${stagedGroupText};return t!==${JSON.stringify(stagedBeforeEnter)} && !t.includes('(0')})()`,
    { timeout: 10_000, label: "enter-stage-effect" },
  );
  record("keyboard-enter-activate", enterWorked, `Enter 前后已暂存组：${stagedBeforeEnter} → ${await evaluate(stagedGroupText)}`);

  // 7. 完整闭环：取消暂存 .env → 只提交普通文件 → 真实 commit
  await ensureWorkspaceTab();
  const envStagedRow = await checkFileRow(".env");
  const unstageClicked = await clickEnabled("取消暂存");
  // 防御：若已暂存分组仍含 node_modules/ 等敏感项，一并取消暂存（guard 会拦）。
  for (let sweep = 0; sweep < 3; sweep += 1) {
    const hasSensitive = await evaluate(`(()=>{
      const section=[...document.querySelectorAll('section')].find(s=>s.querySelector('h4')?.textContent.includes('已暂存'));
      if(!section) return false;
      const rows=[...section.querySelectorAll('.git-check')].filter(l=>l.textContent.includes('node_modules'));
      if(rows.length===0) return false;
      rows.forEach(l=>{const b=l.querySelector('input[type=checkbox]');if(b&&!b.checked)b.click()});
      return true;
    })()`);
    if (!hasSensitive) break;
    await clickEnabled("取消暂存");
  }
  const envUnstaged = await waitFor(
    `(()=>{const staged=[...document.querySelectorAll('h4')].find(x=>x.textContent.includes('已暂存'));const unstaged=[...document.querySelectorAll('h4')].find(x=>x.textContent.includes('未暂存'));const inStagedRow=[...document.querySelectorAll('section')].filter(s=>s.querySelector('h4')?.textContent.includes('已暂存')).flatMap(s=>[...s.querySelectorAll('.git-check')]).some(l=>l.textContent.includes('.env'));return staged && unstaged && !inStagedRow && /\\([1-9]\\d*\\)/.test(staged.textContent)})()`,
    { timeout: 12_000, label: "env unstaged" },
  );
  record("unstage-env", envStagedRow && unstageClicked && envUnstaged, `.env 取消暂存回到未暂存分组（${await evaluate(stagedGroupText)}）`);

  const realFillOk = await fillTitleVerified("feat: real electron commit");
  // 刷新竞争兜底：提交未生效（无成功提示且无错误提示）时重试 fill+submit。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await submitCommitForm();
    const done = await waitFor(
      `!!document.querySelector('.git-write-ok, .git-write-error')`,
      { timeout: 6_000, label: `commit attempt ${attempt}` },
    );
    if (done) break;
    await fillTitleVerified("feat: real electron commit");
  }
  const committed = await waitFor(`!!document.querySelector('.git-write-ok')`, { timeout: 20_000, label: "commit ok" });
  const headOk = await evaluate(`(async()=>{const ws=await window.deer.listWorkspaces();const repo=await window.deer.gitRepo(ws[0].id);return repo.ok? repo.value.headSha?.slice(0,8) : 'err'})()`);
  const lastSubject = await evaluate(`(async()=>{const ws=await window.deer.listWorkspaces();const g=await window.deer.gitGraph(ws[0].id,{limit:1,offset:0});return g.ok? (g.value.commits[0]?.subject ?? '') : 'err'})()`);
  const realErr = await evaluate(`document.querySelector('.git-write-error')?.textContent ?? 'none'`);
  record("real-commit-ok", realFillOk && committed && lastSubject.includes("real electron commit"), `fill=${realFillOk} err=${realErr.slice(0, 50)} HEAD=${headOk} subject=${lastSubject}`);
  await shot("t352-1440-committed.png");

  // 8. .gitignore 应用后出现在未跟踪（完整 apply 路径）
  await ensureWorkspaceTab();
  await clickEnabled("生成 .gitignore");
  await waitFor(`!!document.querySelector('[role="dialog"]')`, { timeout: 10_000, label: "modal reopen" });
  const applied = await clickEnabled("追加缺失行");
  const appliedShown = await waitFor(`!document.querySelector('[role="dialog"]')`, { timeout: 10_000, label: "modal closed" });
  const ignoreUntracked = await waitFor(
    `[...document.querySelectorAll('.git-check')].some(l=>l.textContent.includes('.gitignore'))`,
    { timeout: 12_000, label: "ignore untracked" },
  );
  record("ignore-applied-untracked", applied && appliedShown && ignoreUntracked, ".gitignore 应用后出现在未跟踪分组");
  await shot("t352-1440-ignore-applied.png");
}

if (mode === "unborn") {
  // 首提三步引导 + unborn 场景截图
  const guide = await waitFor(`!!document.querySelector('.git-first-commit')`, { timeout: 12_000, label: "first-commit guide" });
  record("first-commit-guide", guide, "空仓库显示三步首提引导");
  await setViewport(1440, 900);
  await ensureWorkspaceSettled();
  await waitFor(`!!document.querySelector('[aria-label="首次提交引导"]')`, { timeout: 15_000, label: "first commit guide 1440" });
  await shot("t352-1440-first-commit.png");
  await setViewport(960, 800);
  await ensureWorkspaceSettled();
  await waitFor(`!!document.querySelector('[aria-label="首次提交引导"]')`, { timeout: 15_000, label: "first commit guide 960" });
  await evaluate(`(()=>{const d=document.querySelector('.git-graph-detail'); if(d)d.scrollTop=0; return true;})()`);
  await sleep(300);
  await shot("t352-960-first-commit.png");
  await setViewport(480, 800);
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>(e.textContent||'').trim()==='稍后');b?.click();return true;})()`);
  await sleep(400);
  await ensureWorkspaceSettled();
  await waitFor(`!!document.querySelector('[aria-label="首次提交引导"]')`, { timeout: 15_000, label: "first commit guide 480" });
  await evaluate(`(()=>{const g=document.querySelector('[aria-label="首次提交引导"]'); g?.scrollIntoView({block:'start'}); const d=document.querySelector('.git-graph-detail'); if(d)d.scrollTop=0; return true;})()`);
  await sleep(300);
  await shot("t352-480-first-commit.png");
  await setViewport(1440, 900);
  await ensureWorkspaceTab();
  // .gitignore Modal（unborn 上生成）
  const ignoreClicked = await clickEnabled("生成 .gitignore");
  const modalShown = await waitFor(`!!document.querySelector('[role="dialog"]')`, { timeout: 10_000, label: "ignore modal" });
  record("ignore-modal-unborn", ignoreClicked && modalShown, "unborn 仓库 .gitignore 预览 Modal");
  await shot("t352-1440-ignore-modal-unborn.png");
  await key("Escape");
  // unborn 首提：勾选 app.ts → 暂存 → 提交
  const checked = await checkFileRow("app.ts");
  const staged = await clickEnabled("暂存选中", { exclude: "取消" });
  const migrated = await waitFor(`(()=>{const t=${stagedGroupText};return t.includes('(1')})()`, { timeout: 12_000, label: "unborn staged" });
  const unbornFillOk = await fillTitleVerified("chore: first commit from electron");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await submitCommitForm();
    const done = await waitFor(
      `!!document.querySelector('.git-write-ok, .git-write-error')`,
      { timeout: 6_000, label: `first-commit attempt ${attempt}` },
    );
    if (done) break;
    await fillTitleVerified("chore: first commit from electron");
  }
  const firstCommitOk = await waitFor(`!!document.querySelector('.git-write-ok')`, { timeout: 20_000, label: "first commit ok" });
  const graphHasCommit = await waitFor(`(async()=>{const ws=await window.deer.listWorkspaces();const g=await window.deer.gitGraph(ws[0].id,{limit:5,offset:0});return g.ok && g.value.commits.length>=1})()`, { timeout: 15_000, label: "graph has commit" });
  record("unborn-first-commit", unbornFillOk && checked && staged && migrated && firstCommitOk && graphHasCommit, "unborn 仓库完成首个提交并出现在版本图");
  await shot("t352-1440-unborn-committed.png");
}

writeFileSync(path.join(outDir, `t389-walkthrough-${mode}.json`), JSON.stringify({ mode, at: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
if (failures.length) {
  console.error("FAILURES:", JSON.stringify(failures, null, 2));
  process.exit(1);
}
ws.close();
process.exit(0);
