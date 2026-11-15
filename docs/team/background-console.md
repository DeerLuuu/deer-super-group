# 后台任务浮窗 + 多 tab 命令控制台（G12 / t448）

## 范围

- 主进程 `ConsoleManager`：非 PTY spawn、stdout/stderr 流、stdin、stop/kill、状态/exitCode、2MB 环形缓冲、50ms/16KB 批流、退出清理。
- 内存会话注册表：id/workspace/title/command/cwd/source/startedAt/status/pid/exitCode/seq/truncated；每 workspace 6 活跃/20 历史，全局 12 活跃/32 session。
- `console:list/start/stop/input/clear/snapshot/cwds` + `console:event`；zod strict；仅 preload 人类 UI，不注册 Agent 工具。
- Chat 头部「后台任务」按钮 + 运行 badge → 浮窗 → 点击定位 `console` Dock 面板 tab。
- console 多 tab、新建/停止/重启/清屏/复制/stdin/关闭确认/错误态/截断/480 横滚与固定输入。
- 不引入 node-pty/xterm，不写 DB/文件，不做 PTY/TUI、不做 Agent 自动执行。

## 进程与安全

- Windows：`cmd.exe /d /s /c <command>`；POSIX：`/bin/sh -lc <command>`；`shell:false`、`windowsHide:true`、POSIX `detached` 进程组。
- cwd：仅相对路径，拒绝绝对路径/`..`/NUL/控制字符；`resolve` + `realpath` 双检，必须目录且在 workspace 根内；`console:cwds` 只列根+安全一级目录。
- env：allowlist（PATH/PATHEXT/HOME/USERPROFILE/SystemRoot/ComSpec/TEMP/TMP/LANG/...）+ 固定 `CI=1/TERM=dumb/NO_COLOR=1/FORCE_COLOR=0`；不继承全量 env，显式剔除 `*_TOKEN`/`*_API_KEY`/GITHUB_TOKEN/SSH_AUTH_SOCK 等。
- 提权命令（sudo/runas/gsudo/pkexec/Start-Process -Verb RunAs）直接 `CONSOLE_ELEVATION_REJECTED`，不请求 UAC。
- 危险命令（递归删除、format、diskpart、mkfs、shutdown、reg delete、takeown 等）第一次返回 `CONSOLE_CONFIRM_REQUIRED` + 60s 一次性 token + reasons；第二次 command/cwd/hash 必须一致，token 消费即删。UI `alertdialog` 默认取消。
- 输出：`StringDecoder` + 2MB ring；flush 前 `redactSecrets` best-effort；UI 只保留尾部 2k 行/256KB；跨 chunk secret 可能漏，文档明确不是沙箱。
- stop：POSIX SIGTERM（进程组）→ 3s SIGKILL；Windows `child.kill` → 3s `taskkill /PID /T /F`；幂等。`before-quit` 阻止退出等待 `closeAll()`（≤3s）。

## IPC 契约

```text
console:list      workspaceId -> ConsoleSession[]（无输出）
console:start     workspaceId, {command,title?,cwd?,confirmToken?} -> ConsoleResult<Session>
console:stop      workspaceId, sessionId -> ConsoleResult<Session>
console:input     workspaceId, sessionId, data(≤4KB) -> ConsoleResult<{accepted}>
console:clear     workspaceId, sessionId -> ConsoleResult<Session>
console:snapshot  workspaceId, sessionId -> ConsoleResult<{session,output,truncated,droppedBytes,seq}>
console:cwds      workspaceId -> ConsoleResult<CwdOption[]>
console:event     主→渲染 {type:output|status|cleared,...}
```

`src/shared/console.ts` 提供 zod strict schema（workspace/session/command/title/cwd/input 边界、未知字段拒绝）、`CONSOLE_LIMITS`、类型与错误码。preload 仅 `window.deer.console*`/`onConsoleEvent`；`src/kernel/tools.ts` 无 console 工具。

## UI

- `BackgroundTasksButton`：Chat `.panel-head` 右侧，`aria-label="后台任务，N 个运行中"`；列表 `role=listbox`，项状态点/title/command/cwd/状态/exit 或时长；空态打开控制台；Esc 回焦；480 CSS bottom sheet。
- `ConsolePanel`：Dock key `console`（defaultClosed, onlyWhenVisible, min 420×320）：
  - tablist/tab/aria-selected/aria-controls，Arrow/Home/End；关闭运行中 tab 二次确认「停止并关闭」；已退出 tab 直接隐藏。
  - 工具栏 stop/restart/clear/copy；status/duration/exit/cwd；`role=alert` 错误。
  - `role=log aria-live=polite` 输出，尾部 2k 行；截断 banner；自动滚动仅在底部。
  - 新建命令 textarea + cwd select + title；危险确认 `alertdialog`；stdin Enter 发送/Shift+Enter 换行。
  - 480 tab 横滚、输入 sticky 底部、无页面横滚。
- `ConsoleStore` external store：App 级单例；list/meta 与 per-session output 分开订阅；Chat 只订阅 meta（badge），输出事件不触发 Chat rerender。

## 测试

```text
pnpm typecheck
pnpm build
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
```

- `electron/console/consoleManager.test.ts`（12，含 Windows taskkill 强杀）：real spawn stdout/exit、非零 exit、stdin、stop+幂等+closeAll、cwd、env token 剔除、elevation/danger token、active/history limits、2MB 截断、16KB chunk、spawn error。
- `electron/console/consoleWiring.test.ts`：7 个 IPC/preload API；main consoleManager/closeAll；Agent tools 无 console。
- `src/shared/console.test.ts`：zod strict/长度/未知字段。
- `src/shell/console/consoleStore.test.ts`：list/snapshot、output 不通知 Chat meta、status/clear、新建/隐藏/尾部上限。
- `src/shell/console/consoleUi.test.tsx`（5）：Chat badge/浮窗/打开 session、tablist/log/aria、stdin、stop/restart/clear、关闭确认、危险确认 token、空态新建+cwd。
- `src/shell/chat/chatViewIsolation.test.tsx`：Chat 头部按钮 badge+点击打开 session；既有 t443 历史/rail 不回归。

## 三档真实截图

| 截图 | 尺寸 | 内容 |
|---|---|---|
| `docs/team/t448-chat-popover-1440.png` | 1424×881 | Chat 后台任务 badge/浮窗，2 个运行中 session |
| `docs/team/t448-console-1440.png` | 1424×881 | 多 tab + 输出 + stdin + 工具栏 |
| `docs/team/t448-console-960.png` | 960×900 | 960 单列，无横向溢出 |
| `docs/team/t448-console-480.png` | 480×900 | 480 tab 横滚、输入 sticky 底部、无横向 |

真实 Electron（隔离 userData，`--remote-debugging-port`）+ CDP；截图窗口实际 1424×881（1440 指标经窗口装饰裁剪，已在 JSON/正文披露），960/480 为 CDP emulation。启动命令为本地 `node console-demo.js` 演示脚本（已删除，不落库）；真实 session 通过 human preload `consoleStart` 启动，非 mock。证据见 `docs/team/t448-evidence.json`。

## 已知边界

- 非 PTY：没有 TTY/job control/ANSI 全保真；需要 TTY 的程序可能不工作。
- 输出/会话不持久化；应用重启清空；关闭 Dock 面板不杀任务。
- 危险命令检测不是穷举/沙箱，命令以当前用户权限执行；不提供管理员/UAC。
- 480/960 截图用 CDP emulation；真实 1440 截图窗口内尺寸 1424×881。
- 复制当前 UI 尾部（≤256KB），不是完整 2MB ring；清屏/重启会新建 session（重启不复用 id）。
- 不新增依赖；不改 Git/Task/PR/merge/gate/permission。


验证：typecheck 0；build 0（463 modules）；serial test 164 files / 1077 tests。
