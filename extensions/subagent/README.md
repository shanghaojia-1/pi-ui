# Pi Studio Subagent Extension (fork)

Pi Studio（Electron GUI）专用的可观察 subagent 扩展。基于 pi 官方
`examples/extensions/subagent` fork，并针对 GUI 生命周期做了完整适配：

1. **移除 TUI 渲染**：官方版用 `@earendil-works/pi-tui` 组件渲染工具调用/结果
   （`renderCall`/`renderResult`），GUI 用不到，已删除；
2. **子进程定位**：官方版假定自己运行在 pi CLI 进程内（`process.execPath`），
   在 Electron 里会错误地启动 Electron 实例。本版解析顺序：
   `PI_SUBAGENT_CLI` 环境变量 → PATH 中的 `pi` 命令 → 原回退逻辑；
3. **结构化实时状态**：JSONL 的消息和工具事件被转换成 queued / thinking /
   running_tool / streaming / completed 等状态，GUI 无需解析文本；
4. **受控进程生命周期**：支持总超时、静默超时、TERM→KILL 取消升级、错误传播和
   工作区 cwd 边界；GUI 可停止单个任务或整批任务；
5. **项目级 agent 安全确认**：Pi Studio 在真正执行前显示宿主级确认框，模型参数
   无法绕过；其他宿主必须处于可信项目或使用 TUI 确认。

## 安装（开发环境）

```bash
# 扩展本体（symlink 整个目录）
mkdir -p ~/.pi/agent/extensions
ln -sfn "$PWD/extensions/subagent" ~/.pi/agent/extensions/subagent

# 内置 agent 定义（scout / planner / reviewer / worker）
mkdir -p ~/.pi/agent/agents
for f in extensions/subagent/agents/*.md; do
  ln -sf "$PWD/$f" ~/.pi/agent/agents/$(basename "$f")
done
```

Pi Studio 启动时会通过 `DefaultResourceLoader` 自动加载用户扩展
（`noExtensions: false`）。装好后在设置页"扩展"分区应能看到 `subagent`。

## 子进程依赖

子代理以独立 `pi` 进程运行（`--mode json -p --no-session`）。Pi Studio 会在启动时
自动把 `PI_SUBAGENT_ENGINE` 指向**用户配置的同一个引擎包**，扩展通过 Electron 的
`ELECTRON_RUN_AS_NODE` 模式直接运行引擎自带的 `dist/cli.js` ——
**无需全局安装 pi CLI**。解析顺序：

1. `PI_SUBAGENT_CLI` 环境变量（显式指定命令，可覆盖一切）；
2. `PI_SUBAGENT_ENGINE`（GUI 自动注入的已配置引擎包路径）；
3. PATH 中的 `pi` 命令（独立 CLI 环境）。

注意：子代理是独立进程，但 API key 会自动传递。扩展只把本次实际使用 provider
的认证环境注入子进程，并移除其他已知 provider 的 Key；不会把全部模型凭据广播给
每一个子代理。

内置 agent（scout/planner/reviewer/worker）不再绑定模型 —— 子代理跟随
GUI 的默认模型（设置 → 默认设置），也可以在设置 → 子代理 中为每个 agent
单独选择模型或工具。

## Agent 定义

`agents/*.md` 是 frontmatter + 系统提示词：

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-sonnet-4-5   # 可选；不写则用主会话模型
---

System prompt for the agent goes here.
```

- 用户级：`~/.pi/agent/agents/*.md`（默认加载）
- 项目级：`.pi/agents/*.md`（需要 `agentScope: "both"`/`"project"` 且模型显式放行，
  GUI 会逐次向用户确认）

每个任务的 `cwd` 必须位于当前工作区内。任务正文通过 stdin 传给子进程，不会放进
命令行参数。默认总超时为 30 分钟，10 分钟没有任何 JSONL 事件会视为卡死；可用
`PI_SUBAGENT_TIMEOUT_MS` 和 `PI_SUBAGENT_IDLE_TIMEOUT_MS` 调整。

## 使用

模型会自行决定何时调用 `subagent` 工具（单任务 / 并行 tasks / 链式 chain）。
也可以直接指示：

- `Use scout to find all authentication code`
- `Run 2 scouts in parallel: one for models, one for providers`
- `Use a chain: scout → planner → worker`
