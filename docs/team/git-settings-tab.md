# Git 设置独立 Tab（t182）

设置弹窗左侧导航新增 `Git`，Git 开发配置不再附在其它设置页底部。

## 内容

- 仓库模式：auto / github / manual / local / off
- Provider：auto / github / manual / local
- 基线分支
- 最大运行时 worktree（1–3）
- checks 命令与超时
- 合并前批准、自动合并、自动创建 PR
- 取消时推送 WIP、取消时保留 worktree
- 合并方式：squash / merge / rebase
- 保存 Git 设置

## 深链

`gitSettingsFocus` 深链仍可用：

- 打开设置时 `initialSection="git"`；
- 效果钩子滚动/聚焦 `#settings-git`。

## 边界

- Token 仍只来自 `gh` 登录或环境变量，不在 UI 输入或展示。
- Git 设置按 workspace 持久化，沿用既有 `getGitSettings/saveGitSettings` API。
