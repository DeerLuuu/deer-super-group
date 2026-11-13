/**
 * t458/t479 layout-persistence e2e harness (not shipped in the app).
 *
 * Usage from the repo root after `pnpm build`:
 *
 *   $env:DS_USERDATA = "$env:TEMP\t458-e2e-userdata"
 *   $env:DS_WS_B = "$env:TEMP\t458-ws-b"
 *   $env:DS_MODE = "hold"           # hold | set | verify | max
 *   $env:DS_BOUNDS = "1440x900"     # outer BrowserWindow size
 *   pnpm exec electron scripts/layout-persistence-e2e-wrapper.cjs --remote-debugging-port=9336
 *
 * The harness isolates Electron userData, optionally stubs the native folder
 * picker for a second workspace (the renderer click/service path stays real),
 * and sets the outer window to the requested size. `hold` leaves the app open
 * for CDP interaction; `set`/`max` save and close; `verify` prints the restored
 * bounds. The evidence JSON records the exact commands and outcomes.
 */
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, dialog } = require("electron");

const userData = process.env.DS_USERDATA;
if (!userData) {
  console.error("DS_USERDATA is required (isolated userData path)");
  process.exit(2);
}
app.setPath("userData", userData);

// The native directory picker cannot be automated reliably in a headless CDP
// run. Return a seeded workspace directory; the renderer still clicks the real
// button and the kernel still opens/registers the workspace.
if (process.env.DS_WS_B) {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.env.DS_WS_B] });
}

require(path.join(process.cwd(), "dist-electron/main.cjs"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stateFile = path.join(userData, "window-state.json");

app.whenReady().then(async () => {
  await sleep(2200);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.error("no BrowserWindow");
    app.exit(2);
    return;
  }
  if (process.env.DS_BOUNDS) {
    const [width, height] = process.env.DS_BOUNDS.split("x").map(Number);
    win.setBounds({ x: 40, y: 40, width, height });
    await sleep(700);
  }
  const mode = process.env.DS_MODE ?? "hold";
  if (mode === "hold") {
    await sleep(120000);
    return;
  }
  if (mode === "set" || mode === "max") {
    if (mode === "max") win.maximize();
    await sleep(900);
    console.log(
      "SAVED",
      fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : "missing",
      "isMaximized=" + win.isMaximized(),
    );
    win.close();
    setTimeout(() => app.quit(), 400);
    return;
  }
  console.log("RESTORED", JSON.stringify(win.getBounds()), "maximized=" + win.isMaximized());
  win.close();
  setTimeout(() => app.quit(), 400);
}).catch((error) => {
  console.error("ERR", error);
  app.exit(1);
});
