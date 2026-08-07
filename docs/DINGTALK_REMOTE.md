# 钉钉远程控制（DingTalk Remote）

Pi Studio 内置钉钉机器人桥接（类似龙虾的能力），让你在钉钉群里 `@机器人` 就能远程操控
Pi Agent：直接发消息即可让 Pi 在当前工作区执行任务，也可以用命令查询状态、中止任务。

## 原理

采用钉钉 **Stream 模式**（官方 `dingtalk-stream` SDK）：

- 应用主动外联钉钉网关（`api.dingtalk.com:443` + `wss-open-connection.dingtalk.com:443`），
  **不需要公网 IP、不需要端口映射、不需要 webhook 加签**；
- 收到的消息通过 `sessionWebhook` + `x-acs-dingtalk-access-token` 回复，回复会 @ 发送者；
- 远程任务走与 GUI 输入框完全相同的 `PiRuntime.prompt()` 路径：会话历史、流式输出、
  工具审批、错误处理全部共用。

## 开通步骤（一次性）

1. 打开 [钉钉开发者后台](https://open-dev.dingtalk.com) → 创建**企业内部应用**；
2. 应用信息里记下 **Client ID（AppKey）** 与 **Client Secret（AppSecret）**；
3. 应用内添加**机器人**能力，消息接收模式选择 **Stream 模式**，发布应用；
4. 把机器人拉进一个群（或使用机器人单聊）；
5. Pi Studio → 设置 → **钉钉远程控制**：填入 Client ID / Client Secret，建议同时填写
   「允许的发送者」（每行一个钉钉 staffId，可在机器人收到的消息里看到发送者 ID）；
6. 打开开关 → **保存配置**，状态变为「已连接」即可使用。

## 使用方式

在群里 `@机器人` 发送消息（机器人单聊不需要 @）：

| 内容 | 行为 |
| --- | --- |
| 任意任务描述 | 交给 Pi 在当前工作区/会话执行，完成后回复结果 |
| `/status` | 查看工作区、会话、模型、运行状态、审批模式 |
| `/abort` 或 `/stop` | 中止当前任务 |
| `/ping` | 连通性检查 |
| `/help` | 帮助信息 |

执行期间每 20 秒最多汇报一次进度；单条回复截断为 3500 字符；单次远程任务最长等待
30 分钟（超时后 Pi 仍在后台继续，只是不再回复）。

## 安全说明

- **@ 门禁**：群聊里只有 `@机器人` 的消息才会触发，普通群消息被忽略；
- **允许列表**：填写发送者 staffId 后，只有列表内的人能操控；留空 = 任何 @ 机器人的
  人都可以操控（Pi 可以执行任意命令），设置页会给出警告；
- **审批联动**：默认「每次询问」审批模式下，远程触发的 bash/edit/write 仍会在
  Pi Studio 窗口弹出确认框；如需无人值守，先在设置 → 工具审批中开启**全托管模式**；
- **凭据存储**：Client Secret 保存在 `<userData>/dingtalk.json`（0600 权限，原子写入），
  与 models.json 存 API Key 同级；错误文案统一脱敏，不会回显密钥。

## 架构

- `src/main/dingtalk.ts` — `DingtalkBridge`：连接管理、消息路由、远程任务执行与回复；
- `src/shared/contracts.ts` — `DingtalkConfig` / `DingtalkStatus` 契约、IPC 通道、校验器；
- `src/main/index.ts` — IPC 注册（保存配置仅限主窗口）、启动自连、退出清理；
- `src/preload/index.ts`、`src/renderer/src/components/SettingsPanel.tsx` — 设置 UI；
- `tests/unit/dingtalk.test.ts` — 桥接层单测（SDK 以桩替身注入）。
