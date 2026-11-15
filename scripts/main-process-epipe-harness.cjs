/**
 * t468/t483 real-Electron process-guard harness (not shipped).
 *
 * Run from the repo root after `pnpm build`:
 *
 *   $env:DS_USERDATA = "$env:TEMP\t483-epipe-userdata"
 *   electron scripts/main-process-epipe-harness.cjs
 *
 * The script installs the same main entry point, injects stdio pipe errors and
 * uncaught/rejected pipe errors into the real Electron main process, then:
 * - verifies the process/window is still alive;
 * - calls a real preload IPC API (`window.deer.listWorkspaces()`);
 * - asserts `dialog.showErrorBox` was not called;
 * - captures a screenshot and copies the real guard log to docs/team.
 * It also emits an ordinary unhandledRejection (must be logged, not exit) and
 * exits through the normal window-close path.
 */
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, dialog } = require("electron");

const userData = process.env.DS_USERDATA;
if (!userData) {
  console.error("DS_USERDATA is required");
  process.exit(2);
}
app.setPath("userData", userData);

const dialogCalls = [];
dialog.showErrorBox = (title, content) => {
  dialogCalls.push({ title, content });
};

const docsDir = path.join(process.cwd(), "docs", "team");
const resultPath = path.join(docsDir, "t483-epipe-harness.json");
const logPath = path.join(userData, "main-process.log");
const copyLogPath = path.join(docsDir, "t483-main-process.log");
const shotPath = path.join(docsDir, "t483-epipe-alive-1440.png");

require(path.join(process.cwd(), "dist-electron/main.cjs"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function pipeError(code, message) {
  return Object.assign(new Error(message), { code });
}
function readLog() {
  try {
    return fs.readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

app.whenReady().then(async () => {
  await sleep(2500);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.error("harness: no BrowserWindow");
    app.exit(2);
    return;
  }
  win.setBounds({ x: 40, y: 40, width: 1440, height: 900 });
  await sleep(500);

  // Four real main-process pipe events.
  const epipe = pipeError("EPIPE", "EPIPE: broken pipe, write");
  const eio = pipeError("EIO", "EIO: i/o error");
  process.stdout.emit("error", epipe);
  process.stderr.emit("error", eio);
  process.emit("uncaughtException", epipe);
  process.emit("unhandledRejection", epipe, Promise.resolve());
  await sleep(300);

  // Ordinary rejection must be recorded, but must not kill the app.
  process.emit(
    "unhandledRejection",
    new Error("t483 ordinary rejection: expected log, no exit"),
    Promise.resolve(),
  );
  await sleep(300);

  let ipc = { ok: false, count: null, error: null };
  try {
    const value = await win.webContents.executeJavaScript(
      "window.deer.listWorkspaces().then((list) => Array.isArray(list) ? list.length : -1)",
      true,
    );
    ipc = { ok: typeof value === "number" && value >= 0, count: value, error: null };
  } catch (error) {
    ipc = { ok: false, count: null, error: String(error) };
  }

  let screenshot = { ok: false, error: null };
  try {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    await dbg.sendCommand("Page.enable");
    const image = await dbg.sendCommand("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(shotPath, Buffer.from(image.data, "base64"));
    screenshot = { ok: true, error: null };
  } catch (error) {
    screenshot = { ok: false, error: String(error) };
  }

  const log = readLog();
  fs.writeFileSync(copyLogPath, log, "utf8");
  const pipeLines = log
    .split(/\r?\n/)
    .filter((line) => /stream:(stdout|stderr):pipe|uncaughtException:pipe|unhandledRejection:pipe/.test(line));
  const result = {
    task: "t483",
    at: new Date().toISOString(),
    mode: "real Electron main process; isolated userData",
    userData,
    alive: !win.isDestroyed(),
    windows: BrowserWindow.getAllWindows().length,
    appReady: app.isReady(),
    dialogErrorBoxCalls: dialogCalls.length,
    dialogCalls,
    ipc,
    pipeLogLines: pipeLines,
    pipeLogLineCount: pipeLines.length,
    ordinaryRejectionLogged: /unhandledRejection: Error: t483 ordinary rejection/.test(log),
    screenshot,
    logPath,
    logCopyPath: copyLogPath,
    closePath: "win.close() after all assertions",
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ alive: result.alive, windows: result.windows, ipc, dialog: dialogCalls.length, pipeLogLineCount: pipeLines.length }));

  const ok =
    result.alive &&
    result.windows === 1 &&
    result.appReady &&
    result.dialogErrorBoxCalls === 0 &&
    result.ipc.ok &&
    result.pipeLogLineCount >= 4 &&
    result.ordinaryRejectionLogged;
  process.exitCode = ok ? 0 : 1;
  win.close();
  await sleep(600);
  app.quit();
}).catch((error) => {
  console.error("harness failed", error);
  process.exitCode = 1;
  app.quit();
});
