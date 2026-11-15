# 主进程 EPIPE / 未捕获异常防护（G16）

- **任务**：t468 — 主进程 EPIPE/未捕获异常防护
- **背景**：以捕获管道启动 Electron（或父进程先退出）后，主进程 stdout/stderr 的管道断开；随后任何 `console.error` 写入触发 `EPIPE: broken pipe`，未处理的 stream error 变成 `Uncaught Exception`，Electron 弹默认错误框。
- **原则**：管道错误是运行环境事件，不是业务异常；记录后继续运行。真实未捕获异常保留 fail-fast（记录 + exit 1），不静默吞掉。
- **范围**：仅主进程入口/防护模块/测试/文档；不改业务、权限、IPC、数据库、窗口或 UI。

## 1. 安装顺序

`electron/main.ts` 在静态 import 完成后、创建 `BrowserWindow`/`AppService` 之前立即：

```ts
installProcessGuards({ logPath: path.join(app.getPath("userData"), "main-process.log") });
```

- `app.getPath("userData")` 失败时退回 `process.cwd()/main-process.log`。
- 安装发生在任何窗口/服务初始化之前；日志写文件，不在 handler 中使用 `console.*`，避免递归 EPIPE。
- 只安装一次；不注册第二套 handler。

## 2. 错误分类

`isIgnorablePipeError(error)`（纯函数）：

| 输入 | 结果 |
|---|---|
| `{code:"EPIPE"}` / `new Error("EPIPE: broken pipe")` | true |
| `{code:"EIO"}` | true |
| `{code:"ERR_STREAM_DESTROYED"}` | true |
| 带 `cause` 的上述错误 | true（递归取 code） |
| 普通 `Error("boom")` / 非对象 / 其他 code | false |

## 3. 行为矩阵

| 事件 | 管道错误（EPIPE/EIO/DESTROYED） | 其他错误 |
|---|---|---|
| `process.stdout.on("error")` / stderr | 写 `main-process.log` 的 `stream:stdout:pipe` / `stream:stderr:pipe`，**不抛出、不弹框** | 记录 `stream:*:error`；不写 console |
| `uncaughtException` | 记录 `uncaughtException:pipe`，**继续运行** | 记录 `uncaughtException`，然后 `process.exit(1)`（保留 fatal 语义；不弹 Electron 错误框） |
| `unhandledRejection` | 记录 `unhandledRejection:pipe`，继续运行 | 记录 `unhandledRejection`（不静默吞掉；保持 Node/Electron 默认继续策略） |

- 日志行格式：`[ISO timestamp] kind: stack/message`。
- `appendFileSync` 失败（目录不可写/磁盘满等）直接静默返回 false；handler 不因此再写 stdout/stderr。
- 非管道 `uncaughtException` 的 `exit(1)` 是显式 fail-fast；避免 Electron 默认未捕获异常弹框，同时日志保留完整 stack。

## 4. 验证

- `electron/processGuards.test.ts`（9 例）：
  - code/message/cause 分类；普通 Error false。
  - fake stdout/stderr 发射 EPIPE/EIO 不抛、不写 console，日志含 `stream:*:pipe`。
  - `uncaughtException`/`unhandledRejection` 管道错误不 exit；普通异常记录并 `exit(1)`；普通 rejection 记录。
  - 日志写失败静默返回 false；非 Error 格式化。
- `electron/processGuardsWiring.test.ts`：main 在 `createWindow` 前安装 guard；guard 模块无 `console.*`。

## 5. 真实 Electron harness（t483）

```powershell
$env:DS_USERDATA = "$env:TEMP\t483-epipe-userdata"
pnpm exec electron scripts/main-process-epipe-harness.cjs
# 退出码 0；产物：
# docs/team/t483-epipe-harness.json
# docs/team/t483-main-process.log
# docs/team/t483-epipe-alive-1440.png
```

harness 以隔离 userData 启动真实 `dist-electron/main.cjs`，在 1440×900 BrowserWindow 后依次注入：

- `process.stdout.emit("error", EPIPE)`；
- `process.stderr.emit("error", EIO)`；
- `process.emit("uncaughtException", EPIPE)`；
- `process.emit("unhandledRejection", EPIPE)`；
- 另加普通 `unhandledRejection`（`t483 ordinary rejection`）。

断言结果（`t483-epipe-harness.json`）：

| 项 | 结果 |
|---|---|
| `alive` / `windows` / `appReady` | `true` / `1` / `true` |
| `dialog.showErrorBox` 调用 | `0`（harness 覆盖 JS 入口；无 Electron 错误框） |
| 真实 preload IPC `window.deer.listWorkspaces()` | `ok:true`，`count:0`（空隔离 DB） |
| `main-process.log` pipe 记录 | 4 条：`stream:stdout:pipe`、`stream:stderr:pipe`、`uncaughtException:pipe`、`unhandledRejection:pipe` |
| 普通 rejection | `unhandledRejection: Error: t483 ordinary rejection...` 已记录，进程未退出 |
| 关闭路径 | 所有断言后 `win.close()`，harness 退出码 0 |
| 截图 | `t483-epipe-alive-1440.png`（1424×861 content，窗口 outer 1440×900） |

- `t483-main-process.log` 是真实 `userData/main-process.log` 的原样副本，包含 4 条 pipe stack + 普通 rejection 行。
- 无 schema/IPC/权限/业务变更；harness 仅测试脚本，不在应用中使用。

## 6. 回滚

- 回滚仅需移除 main 顶层 `installProcessGuards` 调用；`processGuards.ts`/测试/docs 可独立删除。
- 不涉及 DB schema、IPC、权限或用户数据迁移。

## 7. 命令

```text
pnpm typecheck
pnpm build
pnpm test -- --testTimeout=20000 --maxWorkers=1
```
