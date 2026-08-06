import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Lang = 'zh' | 'en'

type Dict = Record<string, { zh: string; en: string }>

/** All UI strings. Keys are namespaced by feature; zh/en always paired. */
const DICT: Dict = {
  // common / app shell
  'common.you': { zh: '你', en: 'You' },
  'common.close': { zh: '关闭', en: 'Close' },
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'common.save': { zh: '保存', en: 'Save' },
  'common.default': { zh: '默认', en: 'Default' },
  'common.loading': { zh: '加载中', en: 'Loading' },
  'common.retry': { zh: '重试', en: 'Retry' },
  'common.refresh': { zh: '刷新', en: 'Refresh' },
  'app.splash.connecting': { zh: '正在连接…', en: 'Connecting…' },
  'app.splash.failed': { zh: '无法连接渲染进程：', en: 'Cannot reach the renderer: ' },
  'app.banner.recoverable': { zh: '可重试 — 发送新消息后继续', en: 'Retryable — send a new message to continue' },
  'app.noModels.title': { zh: '未找到可用模型', en: 'No models available' },
  'app.noModels.detail': { zh: '请检查模型 API 配置与登录状态，然后重新打开工作区。', en: 'Check model API configuration and sign-in, then reopen the workspace.' },
  'app.emptyWorkspace.title': { zh: '打开一个工作区', en: 'Open a workspace' },
  'app.emptyWorkspace.desc': { zh: '选择项目目录后，即可开始新任务、管理会话，并让 Pi 在真实代码上工作。', en: 'Pick a project directory to start new tasks, manage sessions, and let Pi work on real code.' },
  'app.emptyWorkspace.open': { zh: '打开目录', en: 'Open Folder' },
  'app.shortcut.openDir': { zh: '快捷键 ⇧⌘O', en: 'Shortcut ⇧⌘O' },
  'app.status.ready': { zh: '就绪', en: 'Ready' },
  'app.status.working': { zh: 'Pi 正在工作…', en: 'Pi is working…' },
  'app.status.compacting': { zh: '正在压缩上下文…', en: 'Compacting context…' },
  'app.status.retrying': { zh: '重试中（{n}/{max}）…', en: 'Retrying ({n}/{max})…' },
  'app.status.queue': { zh: '队列 +{n}', en: 'Queue +{n}' },
  'app.about.title': { zh: '关于 {name}', en: 'About {name}' },
  'app.about.version': { zh: '版本', en: 'Version' },
  'app.about.electron': { zh: 'Electron', en: 'Electron' },
  'app.about.platform': { zh: '平台', en: 'Platform' },
  'app.about.agentDir': { zh: 'Agent 目录', en: 'Agent directory' },
  'app.about.workspace': { zh: '工作区', en: 'Workspace' },
  'app.about.notOpen': { zh: '（未打开）', en: '(not open)' },
  'app.sessionStats.title': { zh: '会话统计', en: 'Session stats' },
  'app.sessionStats.id': { zh: '会话 ID', en: 'Session ID' },
  'app.sessionStats.name': { zh: '名称', en: 'Name' },
  'app.sessionStats.file': { zh: '文件', en: 'File' },
  'app.sessionStats.notFlushed': { zh: '（未落盘）', en: '(not persisted)' },
  'app.sessionStats.userMsgs': { zh: '用户消息', en: 'User messages' },
  'app.sessionStats.assistantMsgs': { zh: '助手消息', en: 'Assistant messages' },
  'app.sessionStats.toolCalls': { zh: '工具调用', en: 'Tool calls' },
  'app.sessionStats.totalMsgs': { zh: '总消息数', en: 'Total messages' },
  'app.sessionStats.inputTokens': { zh: '输入 Token', en: 'Input tokens' },
  'app.sessionStats.outputTokens': { zh: '输出 Token', en: 'Output tokens' },
  'app.sessionStats.cacheRead': { zh: '缓存读取', en: 'Cache read' },
  'app.sessionStats.cost': { zh: '费用', en: 'Cost' },
  'app.command.nameHint': { zh: '请提供会话名称，如 /name 重构计划', en: 'Provide a session name, e.g. /name refactor-plan' },
  'app.command.compacting': { zh: '正在压缩上下文…', en: 'Compacting context…' },
  'app.command.copied': { zh: '已复制最后一条回复', en: 'Copied last reply' },
  'app.command.nothingToCopy': { zh: '没有可复制的回复', en: 'Nothing to copy' },
  'app.command.exported': { zh: '已导出：{path}', en: 'Exported: {path}' },
  'app.command.exportCancelled': { zh: '已取消导出', en: 'Export cancelled' },
  'app.command.reloading': { zh: '正在重载扩展 / 技能 / 模板…', en: 'Reloading extensions / skills / templates…' },
  'app.command.unknown': { zh: '未知命令 /{cmd}', en: 'Unknown command /{cmd}' },

  // sidebar
  'sidebar.openDir': { zh: '打开目录', en: 'Open Folder' },
  'sidebar.newTask': { zh: '新任务', en: 'New Task' },
  'sidebar.settings': { zh: '设置', en: 'Settings' },
  'sidebar.sessionsLabel': { zh: '会话列表', en: 'Sessions' },
  'sidebar.noSessions': { zh: '暂无会话', en: 'No sessions yet' },
  'sidebar.openDirHint': { zh: '打开目录后显示会话', en: 'Open a folder to see sessions' },
  'sidebar.workspaceNotOpen': { zh: '未打开工作区', en: 'No workspace' },
  'sidebar.noMessages': { zh: '暂无消息', en: 'No messages yet' },
  'sidebar.messages': { zh: '{n} 条消息', en: '{n} messages' },
  'sidebar.groupToday': { zh: '今天', en: 'Today' },
  'sidebar.groupYesterday': { zh: '昨天', en: 'Yesterday' },
  'sidebar.groupEarlier': { zh: '更早', en: 'Earlier' },
  'sidebar.deleteSession': { zh: '删除会话', en: 'Delete session' },
  'sidebar.confirmDelete': { zh: '确认删除？', en: 'Confirm delete?' },
  'sidebar.deleteTitle': { zh: '删除会话：{title}', en: 'Delete session: {title}' },
  'sidebar.confirmDeleteTitle': { zh: '确认删除会话：{title}', en: 'Confirm delete session: {title}' },
  'sidebar.confirmDeleteHint': { zh: '再次点击确认删除', en: 'Click again to confirm' },

  // topbar
  'topbar.noModel': { zh: '无可用模型', en: 'No model' },
  'topbar.selectModel': { zh: '选择模型', en: 'Select model' },
  'topbar.error': { zh: '出错', en: 'Error' },
  'topbar.queueBadge': { zh: '排队', en: 'queued' },
  'topbar.thinking': { zh: '思考', en: 'Thinking' },
  'topbar.thinking.off': { zh: '关闭', en: 'Off' },
  'topbar.thinking.minimal': { zh: '最低', en: 'Minimal' },
  'topbar.thinking.low': { zh: '低', en: 'Low' },
  'topbar.thinking.medium': { zh: '中', en: 'Medium' },
  'topbar.thinking.high': { zh: '高', en: 'High' },
  'topbar.thinking.xhigh': { zh: '很高', en: 'Very high' },
  'topbar.thinking.max': { zh: '最高', en: 'Maximum' },
  'topbar.thinkingLabel': { zh: '思考强度', en: 'Thinking level' },
  'topbar.modelLabel': { zh: '模型', en: 'Model' },
  'topbar.approval.ask': { zh: '逐次确认', en: 'Ask each time' },
  'topbar.approval.managed': { zh: '全托管 · 非沙箱', en: 'Managed · not sandboxed' },
  'topbar.approval': { zh: '工具审批', en: 'Tool approval' },
  'topbar.expandSidebar': { zh: '展开侧栏', en: 'Expand sidebar' },
  'topbar.collapseSidebar': { zh: '收起侧栏', en: 'Collapse sidebar' },
  'topbar.expandPanel': { zh: '展开活动面板', en: 'Expand activity panel' },
  'topbar.collapsePanel': { zh: '收起活动面板', en: 'Collapse activity panel' },

  // composer
  'composer.aria': { zh: '消息输入', en: 'Message input' },
  'composer.placeholder.workspace': { zh: '请先打开工作区', en: 'Open a workspace first' },
  'composer.placeholder.noModels': { zh: '未找到可用模型，请检查 API 鉴权', en: 'No models — check API auth' },
  'composer.placeholder.followUp': { zh: '继续输入，发送后作为 follow-up 排队…', en: 'Keep typing; it will queue as a follow-up…' },
  'composer.placeholder.idle': { zh: '描述任务，Pi 将在当前工作区执行…', en: 'Describe the task; Pi will work in this workspace…' },
  'composer.send': { zh: '发送', en: 'Send' },
  'composer.sendHint': { zh: '发送 (Enter)', en: 'Send (Enter)' },
  'composer.stop': { zh: '停止运行', en: 'Stop' },
  'composer.stopHint': { zh: '停止运行 (Esc)', en: 'Stop (Esc)' },
  'composer.attachImage': { zh: '添加图片', en: 'Add image' },
  'composer.attachHint': { zh: '添加图片（或拖入/粘贴）', en: 'Add image (or drag/paste)' },
  'composer.removeImage': { zh: '移除图片 {n}', en: 'Remove image {n}' },
  'composer.previewImage': { zh: '预览图片 {n}', en: 'Preview image {n}' },
  'composer.attachmentAlt': { zh: '附件 {n}', en: 'Attachment {n}' },
  'composer.imageTooLarge': { zh: '图片不能超过 10MB', en: 'Images must be under 10MB' },
  'composer.readFailed': { zh: '读取图片失败', en: 'Failed to read image' },
  'composer.onlyImages': { zh: '仅支持粘贴或拖入图片文件', en: 'Only image files can be pasted or dropped' },
  'composer.maxImages': { zh: '最多附加 {n} 张图片', en: 'At most {n} images' },
  'composer.unsupportedType': { zh: '不支持的文件类型：{type}', en: 'Unsupported file type: {type}' },
  'composer.hint.running': { zh: '运行中 — 继续输入并发送将作为 follow-up 排队', en: 'Running — keep typing and send to queue a follow-up' },
  'composer.hint.idle': { zh: 'Enter 发送 · Shift+Enter 换行 · ⌘K 聚焦输入 · 可拖入/粘贴图片', en: 'Enter send · Shift+Enter newline · ⌘K focus · drag/paste images' },
  'composer.slashAria': { zh: '斜杠命令', en: 'Slash commands' },
  'composer.slash.groupSession': { zh: '会话', en: 'Session' },
  'composer.slash.groupConfig': { zh: '配置', en: 'Config' },
  'composer.slash.groupSystem': { zh: '系统', en: 'System' },
  'composer.slash.groupExtension': { zh: '扩展', en: 'Extension' },
  'composer.slash.groupPrompt': { zh: '模板', en: 'Template' },
  'composer.slash.groupSkill': { zh: '技能', en: 'Skill' },
  'composer.slash.new': { zh: '开始新任务（新会话）', en: 'Start a new task (session)' },
  'composer.slash.resume': { zh: '打开会话列表', en: 'Open session list' },
  'composer.slash.name': { zh: '重命名当前会话', en: 'Rename current session' },
  'composer.slash.compact': { zh: '手动压缩上下文', en: 'Compact context manually' },
  'composer.slash.copy': { zh: '复制最后一条回复', en: 'Copy last reply' },
  'composer.slash.export': { zh: '导出会话为 JSONL', en: 'Export session as JSONL' },
  'composer.slash.session': { zh: '查看会话统计', en: 'View session stats' },
  'composer.slash.model': { zh: '切换模型', en: 'Switch model' },
  'composer.slash.settings': { zh: '打开设置', en: 'Open settings' },
  'composer.slash.login': { zh: '配置 API Key / 登录', en: 'Configure API key / sign in' },
  'composer.slash.reload': { zh: '重载扩展 / 技能 / 模板', en: 'Reload extensions / skills / templates' },
  'composer.slash.quit': { zh: '退出应用', en: 'Quit app' },

  // messages
  'messages.thinking': { zh: '思考', en: 'Thinking' },
  'messages.thinkingInProgress': { zh: '进行中', en: 'In progress' },
  'messages.thinkingCount': { zh: '{n} 字', en: '{n} chars' },
  'messages.thinkingIdle': { zh: '正在思考…', en: 'Thinking…' },
  'messages.zoomImage': { zh: '点击放大图片', en: 'Click to zoom' },
  'messages.imageAlt': { zh: '用户附带的图片', en: 'User attached image' },
  'messages.welcome.title': { zh: '开始新任务', en: 'Start a new task' },
  'messages.welcome.desc': { zh: '描述你想让 Pi 在', en: 'Describe what you want Pi to do in' },
  'messages.welcome.desc2': { zh: '中完成的工作', en: ' to do' },
  'messages.welcome.shortcuts': { zh: '⌘N 新任务 · ⌘K 聚焦输入 · ⇧⌘O 打开目录 · Enter 发送 · Esc 停止', en: '⌘N new task · ⌘K focus input · ⇧⌘O open folder · Enter send · Esc stop' },
  'messages.suggest.explore': { zh: '探索这个项目，总结它的结构与主要模块', en: 'Explore this project and summarize its structure and modules' },
  'messages.suggest.test': { zh: '运行测试并修复失败的部分', en: 'Run the tests and fix what fails' },
  'messages.suggest.review': { zh: '审查最近的代码变更，指出潜在问题', en: 'Review recent code changes and flag issues' },

  // telemetry
  'telemetry.speed': { zh: '速度', en: 'Speed' },
  'telemetry.cacheHit': { zh: '缓存命中', en: 'Cache hit' },
  'telemetry.context': { zh: '上下文', en: 'Context' },
  'telemetry.ttft': { zh: 'TTFT', en: 'TTFT' },
  'telemetry.recentOutput': { zh: '最近输出', en: 'Latest output' },
  'telemetry.aria': { zh: '运行指标', en: 'Runtime metrics' },
  'telemetry.speedLive': { zh: '实时估算 token 速率', en: 'Live token rate estimate' },
  'telemetry.speedFinal': { zh: '本次输出最终速率', en: 'Final output rate' },
  'telemetry.speedNone': { zh: '暂无 token 速率数据', en: 'No token rate data' },
  'telemetry.cacheNone': { zh: '暂无缓存命中率数据', en: 'No cache hit data' },
  'telemetry.cacheFormula': { zh: '缓存命中率 = 缓存读取 /（输入 + 缓存读取 + 缓存写入）= {read} /（{input} + {read} + {write}）= {pct}%', en: 'Cache hit = cacheRead / (input + cacheRead + cacheWrite) = {read} / ({input} + {read} + {write}) = {pct}%' },
  'telemetry.cacheAria': { zh: '缓存命中率 {pct}%（缓存读取 {read} / 输入 {input} + 缓存读取 {read} + 缓存写入 {write}）', en: 'Cache hit {pct}% (read {read} / input {input} + read {read} + write {write})' },
  'telemetry.ctxNone': { zh: '暂无上下文用量数据', en: 'No context usage data' },
  'telemetry.ctxTitle': { zh: '上下文 {text}（{pct}%）', en: 'Context {text} ({pct}%)' },
  'telemetry.ttftTitle': { zh: '首字延迟 {dur}', en: 'Time to first token {dur}' },
  'telemetry.ttftNone': { zh: '暂无首字延迟数据', en: 'No TTFT data' },
  'telemetry.outputTitle': { zh: '最近一次输出的 token 数', en: 'Tokens in the latest output' },
  'telemetry.outputNone': { zh: '暂无输出 token 数据', en: 'No output token data' },

  // right panel
  'rightPanel.noActivity': { zh: '暂无活动', en: 'No activity' },
  'rightPanel.noActivitySub': { zh: '开始对话后，文件变更、工具运行与用量会显示在这里', en: 'File changes, tool runs and usage appear here once you chat' },
  'rightPanel.activity': { zh: '活动', en: 'Activity' },
  'rightPanel.patches': { zh: '变更', en: 'Changes' },
  'rightPanel.tools': { zh: '工具运行', en: 'Tool runs' },
  'rightPanel.usage': { zh: '用量', en: 'Usage' },
  'rightPanel.inputTokens': { zh: '输入 tokens', en: 'Input tokens' },
  'rightPanel.outputTokens': { zh: '输出 tokens', en: 'Output tokens' },
  'rightPanel.cacheRead': { zh: '缓存读取', en: 'Cache read' },
  'rightPanel.cacheWrite': { zh: '缓存写入', en: 'Cache write' },
  'rightPanel.cost': { zh: '成本', en: 'Cost' },
  'rightPanel.costZero': { zh: '成本为 0：provider 未报告价格时可能显示为 0，不代表免费', en: '0 cost: providers without reported prices may show 0 — not necessarily free' },
  'rightPanel.costFormula': { zh: '成本按 provider 报告的价格计算', en: 'Cost per provider-reported prices' },
  'rightPanel.total': { zh: '总处理', en: 'Total processed' },
  'rightPanel.totalTitle': { zh: '总处理 = 输入 + 输出 + 缓存读取 + 缓存写入', en: 'Total = input + output + cacheRead + cacheWrite' },
  'rightPanel.file': { zh: '文件', en: 'File' },

  // tool call
  'toolcall.args': { zh: '参数', en: 'Arguments' },
  'toolcall.output': { zh: '输出', en: 'Output' },
  'toolcall.patch': { zh: '补丁', en: 'Patch' },
  'toolcall.status.pending': { zh: '待执行', en: 'Pending' },
  'toolcall.status.running': { zh: '运行中', en: 'Running' },
  'toolcall.status.success': { zh: '成功', en: 'Success' },
  'toolcall.status.error': { zh: '失败', en: 'Error' },
  'toolcall.status.interrupted': { zh: '已中断', en: 'Interrupted' },
  'toolcall.copy': { zh: '复制', en: 'Copy' },
  'toolcall.copied': { zh: '已复制', en: 'Copied' },

  // markdown
  'markdown.copyCode': { zh: '复制代码', en: 'Copy code' },
  'markdown.codeCopied': { zh: '已复制到剪贴板', en: 'Copied to clipboard' },
  'markdown.copyFailed': { zh: '复制失败', en: 'Copy failed' },
  'markdown.codeCopiedLive': { zh: '代码已复制到剪贴板', en: 'Code copied to clipboard' },
  'markdown.copyFailedLive': { zh: '复制失败，请手动选择复制', en: 'Copy failed — select manually' },
  'markdown.blockedLink': { zh: '不允许打开的链接', en: 'Link not allowed' },
  'markdown.blockedImage': { zh: '不允许加载的图片', en: 'Image not allowed' },
  'markdown.image': { zh: '图片', en: 'Image' },

  // lightbox
  'lightbox.aria': { zh: '图片预览', en: 'Image preview' },
  'lightbox.close': { zh: '关闭图片预览', en: 'Close image preview' },
  'lightbox.closeHint': { zh: '关闭 (Esc)', en: 'Close (Esc)' },

  // settings
  'settings.title': { zh: '设置', en: 'Settings' },
  'settings.close': { zh: '关闭设置', en: 'Close settings' },
  'settings.loading': { zh: '正在加载设置…', en: 'Loading settings…' },
  'settings.loadFailed': { zh: '无法加载设置：', en: 'Failed to load settings: ' },
  'settings.appearance': { zh: '外观', en: 'Appearance' },
  'settings.appearanceHint': { zh: '界面语言与主题仅影响本应用显示。', en: 'Language and theme only affect this app.' },
  'settings.language': { zh: '界面语言', en: 'Language' },
  'settings.language.zh': { zh: '中文', en: 'Chinese' },
  'settings.language.en': { zh: 'English', en: 'English' },
  'settings.theme': { zh: '主题', en: 'Theme' },
  'settings.theme.system': { zh: '跟随系统', en: 'System' },
  'settings.theme.light': { zh: '明亮', en: 'Light' },
  'settings.theme.dark': { zh: '暗黑', en: 'Dark' },
  'settings.theme.sepia': { zh: '羊皮纸', en: 'Sepia' },
  'settings.theme.ocean': { zh: '深海', en: 'Ocean' },
  'settings.theme.forest': { zh: '森林', en: 'Forest' },
  'settings.providers': { zh: '模型提供商', en: 'Model providers' },
  'settings.newProvider': { zh: '新建供应商', en: 'New provider' },
  'settings.providersConfigured': { zh: '已配置供应商', en: 'Configured providers' },
  'settings.providersHint': { zh: '在此添加自定义供应商与模型；当前会话使用的供应商/模型由顶部选择器控制。', en: 'Add custom providers and models here; the active provider/model is controlled by the top selector.' },
  'settings.refreshModels': { zh: '刷新模型列表', en: 'Refresh models' },
  'settings.refreshing': { zh: '刷新中…', en: 'Refreshing…' },
  'settings.refreshingModels': { zh: '正在刷新模型列表…', en: 'Refreshing model list…' },
  'settings.modelsRefreshed': { zh: '模型列表已刷新', en: 'Model list refreshed' },
  'settings.defaults': { zh: '默认设置', en: 'Defaults' },
  'settings.defaultsHint': { zh: '默认模型会连同其提供商一起保存；当前会话模型仍由顶部选择器控制。', en: 'The default model carries its provider; the active model is still top-selector controlled.' },
  'settings.followLast': { zh: '跟随上次选择', en: 'Follow last choice' },
  'settings.noModelsHint': { zh: '暂无可用模型，请先配置 API Key 或运行 pi /login', en: 'No models — configure an API key or run pi /login' },
  'settings.defaultModel': { zh: '默认模型', en: 'Default model' },
  'settings.defaultThinking': { zh: '默认思考强度', en: 'Default thinking level' },
  'settings.autoCompact': { zh: '自动压缩上下文', en: 'Auto-compact context' },
  'settings.autoRetry': { zh: '自动重试', en: 'Auto-retry' },
  'settings.httpTimeout': { zh: 'HTTP 空闲超时（秒）', en: 'HTTP idle timeout (s)' },
  'settings.timeoutRange': { zh: '范围 {min}–{max} 秒，保存时转换为毫秒', en: 'Range {min}–{max} s; converted to ms on save' },
  'settings.readonly': { zh: '只读设置', en: 'Read-only settings' },
  'settings.reserveTokens': { zh: '压缩保留', en: 'Reserve' },
  'settings.keepRecent': { zh: '保留最近', en: 'Keep recent' },
  'settings.maxRetries': { zh: '最大重试', en: 'Max retries' },
  'settings.retryDelay': { zh: '重试延迟', en: 'Retry delay' },
  'settings.retries': { zh: '{n} 次', en: '{n}' },
  'settings.saveDefaults': { zh: '保存默认设置', en: 'Save defaults' },
  'settings.saving': { zh: '保存中…', en: 'Saving…' },
  'settings.saved': { zh: '默认设置已保存', en: 'Defaults saved' },
  'settings.savingDefaults': { zh: '正在保存默认设置…', en: 'Saving defaults…' },
  'settings.noChanges': { zh: '没有需要保存的更改', en: 'No changes to save' },
  'settings.timeoutInvalid': { zh: 'HTTP 空闲超时需在 {min}–{max} 秒之间', en: 'HTTP idle timeout must be between {min}–{max}s' },
  'settings.saveFailed': { zh: '保存设置失败', en: 'Failed to save settings' },
  'settings.customTitle': { zh: '添加自定义提供商', en: 'Add custom provider' },
  'settings.providerType': { zh: '供应商类型', en: 'Provider type' },
  'settings.providerTypeHint': { zh: '选择类型会自动填充 API 与常用地址，可再修改。', en: 'Picking a type pre-fills the API and a common base URL — you can edit them.' },
  'settings.type.ollama': { zh: 'Ollama', en: 'Ollama' },
  'settings.type.openai': { zh: 'OpenAI 兼容', en: 'OpenAI-compatible' },
  'settings.type.anthropic': { zh: 'Anthropic 兼容', en: 'Anthropic-compatible' },
  'settings.type.google': { zh: 'Google AI Studio', en: 'Google AI Studio' },
  'settings.type.custom': { zh: '自定义', en: 'Custom' },
  'settings.modelsList': { zh: '模型', en: 'Models' },
  'settings.modelsListHint': { zh: '输入模型 ID 后按回车添加，可随时移除。', en: 'Type a model ID and press Enter to add; remove anytime.' },
  'settings.modelIdPh': { zh: '模型 ID，如 llama3.1:8b', en: 'Model ID, e.g. llama3.1:8b' },
  'settings.modelIdAria': { zh: '模型 ID', en: 'Model ID' },
  'settings.addModel': { zh: '添加模型', en: 'Add model' },
  'settings.removeModel': { zh: '移除模型', en: 'Remove model' },
  'settings.modelIdRequired': { zh: '请先填写模型 ID', en: 'Enter a model ID first' },
  'settings.duplicateModel': { zh: '该模型已添加', en: 'Model already added' },
  'settings.customHint': { zh: '支持 Ollama / vLLM / LM Studio / 代理等 OpenAI 兼容或 Anthropic 兼容端点，写入 models.json。', en: 'Ollama / vLLM / LM Studio / proxies: OpenAI- or Anthropic-compatible endpoints, written to models.json.' },
  'settings.customId': { zh: '提供商 ID（必填）', en: 'Provider ID (required)' },
  'settings.customIdPh': { zh: '如 my-ollama', en: 'e.g. my-ollama' },
  'settings.customName': { zh: '显示名称（可选）', en: 'Display name (optional)' },
  'settings.customNamePh': { zh: '如 本地 Ollama', en: 'e.g. Local Ollama' },
  'settings.customUrl': { zh: 'Base URL（必填）', en: 'Base URL (required)' },
  'settings.customUrlPh': { zh: '如 http://localhost:11434/v1', en: 'e.g. http://localhost:11434/v1' },
  'settings.customApi': { zh: 'API 类型', en: 'API type' },
  'settings.customKey': { zh: 'API Key（可选）', en: 'API key (optional)' },
  'settings.customKeyPh': { zh: '留空则使用环境变量或运行 Key', en: 'Leave empty for env/runtime key' },
  'settings.customModels': { zh: '模型 ID（必填，每行一个）', en: 'Model IDs (required, one per line)' },
  'settings.customImage': { zh: '以上模型支持图片输入', en: 'These models support image input' },
  'settings.addProvider': { zh: '添加提供商', en: 'Add provider' },
  'settings.addingProvider': { zh: '添加中…', en: 'Adding…' },
  'settings.testConnection': { zh: '测试连接', en: 'Test connection' },
  'settings.testingConnection': { zh: '测试中…', en: 'Testing…' },
  'settings.testOk': { zh: '连接成功', en: 'Connected' },
  'settings.testAuth': { zh: '认证失败（HTTP {status}）', en: 'Auth failed (HTTP {status})' },
  'settings.testHttp': { zh: '服务器响应异常（HTTP {status}）', en: 'Server error (HTTP {status})' },
  'settings.testNetwork': { zh: '无法连接到服务器', en: 'Cannot reach server' },
  'settings.customValidation': { zh: '请填写提供商 ID、Base URL 和至少一个模型 ID', en: 'Provider ID, Base URL and at least one model ID are required' },
  'settings.customUrlInvalid': { zh: 'Base URL 需以 http:// 或 https:// 开头', en: 'Base URL must start with http:// or https://' },
  'settings.addingCustom': { zh: '正在添加自定义提供商…', en: 'Adding custom provider…' },
  'settings.customAdded': { zh: '已添加自定义提供商 {name}，可在顶部选择其模型', en: 'Custom provider {name} added — pick its models at the top' },
  'settings.unknownSaveError': { zh: '保存设置失败', en: 'Failed to save settings' },
  'settings.approval': { zh: '工具审批', en: 'Tool approval' },
  'settings.approvalPillManaged': { zh: '全托管', en: 'Managed' },
  'settings.approvalPillAsk': { zh: '逐次确认', en: 'Ask' },
  'settings.approvalManagedNote': { zh: '命令和文件修改将不再逐次确认；使用当前用户权限；不是沙箱；请仅在信任当前任务时开启。', en: 'Commands and file edits run without per-call confirmation, using your user permissions. Not a sandbox. Enable only for trusted tasks.' },
  'settings.approvalAskNote': { zh: '每次执行 bash / edit / write 前都会向你确认，命令与文件修改不会在未经确认时执行。', en: 'bash / edit / write are confirmed before every execution; nothing runs without approval.' },
  'settings.approvalSwitchTitle': { zh: '全托管模式', en: 'Managed mode' },
  'settings.approvalSwitchManaged': { zh: '已开启：bash / edit / write 不再逐次确认', en: 'On: bash / edit / write run without confirmation' },
  'settings.approvalSwitchAsk': { zh: '关闭：bash / edit / write 每次执行前确认', en: 'Off: bash / edit / write confirm every execution' },
  'settings.approvalAria': { zh: '全托管模式（工具免逐次确认）', en: 'Managed mode (no per-tool confirmation)' },
  'settings.approvalRequesting': { zh: '正在请求开启全托管模式…', en: 'Requesting managed mode…' },
  'settings.approvalDisabling': { zh: '正在关闭全托管模式…', en: 'Disabling managed mode…' },
  'settings.approvalEnabled': { zh: '已开启全托管模式', en: 'Managed mode on' },
  'settings.approvalDisabled': { zh: '已关闭全托管模式', en: 'Managed mode off' },
  'settings.approvalCancelled': { zh: '已取消：未开启全托管模式', en: 'Cancelled: managed mode not enabled' },
  'settings.approvalStillManaged': { zh: '仍处于全托管模式，请重试', en: 'Still managed — try again' },
  'settings.auth.stored': { zh: '已存储', en: 'Stored' },
  'settings.auth.runtime': { zh: '仅本次运行', en: 'Runtime' },
  'settings.auth.environment': { zh: '环境变量', en: 'Environment' },
  'settings.auth.fallback': { zh: '回退配置', en: 'Fallback' },
  'settings.auth.modelsJson': { zh: 'models.json', en: 'models.json' },
  'settings.auth.none': { zh: '未配置', en: 'Not configured' },
  'settings.auth.error': { zh: '鉴权异常', en: 'Auth error' },
  'settings.models': { zh: '{n} 个模型', en: '{n} models' },
  'settings.extensions': { zh: '扩展', en: 'Extensions' },
  'settings.extensionsHint': { zh: '扩展来自 ~/.pi/agent/extensions/ 或项目 .pi/extensions/，可注册命令、工具与事件处理。', en: 'Extensions from ~/.pi/agent/extensions/ or project .pi/extensions/ can register commands, tools and event handlers.' },
  'settings.noExtensions': { zh: '未加载任何扩展', en: 'No extensions loaded' },
  'settings.extensionsCommands': { zh: '{n} 命令', en: '{n} commands' },
  'settings.extensionsTools': { zh: '{n} 工具', en: '{n} tools' },
  'settings.extensionsHandlers': { zh: '{n} 处理器', en: '{n} handlers' },
  'settings.extensionsSource.user': { zh: '用户扩展', en: 'User extension' },
  'settings.extensionsSource.project': { zh: '项目扩展', en: 'Project extension' },
  'settings.extensionsSource.temporary': { zh: '内置', en: 'Built-in' },
  'settings.extensionsErrors': { zh: '加载错误', en: 'Load errors' },
  'settings.reloadExtensions': { zh: '重载扩展', en: 'Reload extensions' },
  'settings.addCustomFailed': { zh: '添加自定义提供商失败', en: 'Failed to add custom provider' },
  'settings.renameFailed': { zh: '重命名失败', en: 'Rename failed' },
}

const STORAGE_KEY = 'pi-studio-lang'

function detectLang(): Lang {
  // Test/CI override injected by the preload (PI_STUDIO_LANG); real installs
  // use the stored preference, then the OS language.
  try {
    const forced = (window as { desktop?: { lang?: string } }).desktop?.lang
    if (forced === 'zh' || forced === 'en') return forced
  } catch { /* ignore */ }
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'zh' || stored === 'en') return stored
  } catch { /* storage unavailable */ }
  try {
    return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}

interface I18nContextValue {
  lang: Lang
  t: (key: string, vars?: Record<string, string | number>) => string
  setLang: (lang: Lang) => void
}

const I18nContext = createContext<I18nContextValue>({
  lang: 'zh',
  t: (key) => key,
  setLang: () => undefined,
})

export function I18nProvider({ children, initialLang }: { children: ReactNode; initialLang?: Lang }) {
  const [lang, setLangState] = useState<Lang>(initialLang ?? detectLang)

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try { localStorage.setItem(STORAGE_KEY, next) } catch { /* ignore */ }
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en'
  }, [])

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      const entry = DICT[key]
      let text = entry ? entry[lang] : key
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.split(`{${name}}`).join(String(value))
        }
      }
      return text
    },
    [lang],
  )

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const value = useMemo(() => ({ lang, t, setLang }), [lang, t, setLang])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}

/** Tests: direct dict access. */
export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const entry = DICT[key]
  let text = entry ? entry[lang] : key
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}

/** Tests: every key must have both languages. */
export function i18nKeys(): string[] {
  return Object.keys(DICT)
}
