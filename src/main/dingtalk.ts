/**
 * DingTalk robot remote-control bridge (Stream mode).
 *
 * The bridge connects to DingTalk's Stream gateway with an enterprise-app
 * credential pair (Client ID = AppKey, Client Secret = AppSecret) over an
 * outbound WebSocket — no public IP, no webhook signing. Group members who
 * @-mention the bot (or the bot's single chat) can drive the Pi agent that
 * Pi Studio is running: free-form prompts run through the exact same
 * PiRuntime path as the GUI composer (approval dialogs, streaming and
 * session history all apply), plus a small command set (/help /status
 * /abort) for remote housekeeping.
 *
 * Security model:
 * - Messages are only accepted when the bot was @-mentioned (group) or is in
 *   a single chat; the bridge never reacts to ambient group chatter.
 * - An optional sender allowlist (staffId) restricts who may drive Pi; an
 *   empty allowlist accepts any @-mention and the settings UI warns about it.
 * - Tool approval still applies: with the default 'ask' policy every
 *   bash/edit/write call waits for a native confirmation in the GUI; remote
 *   unattended operation requires switching to 'managed' in the GUI first.
 * - Replies are rate-capped (a running task reports progress at most every
 *   PROGRESS_INTERVAL_MS) and truncated to REPLY_MAX_CHARS.
 *
 * Config is persisted at <userData>/dingtalk.json with an atomic tmp+rename
 * write; a corrupt or missing file fails closed to disabled.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream'
import { isDingtalkConfig, type DingtalkConfig, type DingtalkStatus, type DingtalkState } from '../shared/contracts'
import type { PiRuntime } from './runtime'

const CONFIG_FILE = 'dingtalk.json'
/** A remote task stops being awaited after this long. */
const REMOTE_RUN_TIMEOUT_MS = 30 * 60 * 1000
/** Minimum gap between progress replies of one running task. */
const PROGRESS_INTERVAL_MS = 20_000
/** Poll cadence for the SDK's connection flag (the SDK emits no status events). */
const STATUS_POLL_MS = 3_000
/** Per-message markdown payload cap (DingTalk messages are size-limited). */
const REPLY_MAX_CHARS = 3500
const PROGRESS_MAX_CHARS = 600
const ERROR_MAX_CHARS = 1200
/** Grace period after a prompt preflight accepts before 'idle' counts as settled. */
const IDLE_SETTLE_GRACE_MS = 3000

const RUN_STATE_LABELS: Record<string, string> = {
  idle: '空闲', running: '执行中', retrying: '重试中', compacting: '压缩上下文中', error: '错误',
}

const HELP_TEXT = [
  '**Pi Agent 远程控制**',
  '',
  '直接发消息即可让 Pi 在当前工作区执行任务（与 GUI 输入框等效）。',
  '',
  '可用命令：',
  '- `/status` 查看 Pi 当前状态',
  '- `/abort` 或 `/stop` 中止当前任务',
  '- `/ping` 连通性检查',
  '- `/help` 本帮助',
  '',
  '提示：默认审批模式下，bash/edit/write 等工具调用仍需在 Pi Studio 窗口内确认；如需无人值守请在设置中开启全托管模式。',
].join('\n')

/** Bounded text clip with a truncation marker. */
export const clip = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit)}\n… (已截断)` : value

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Strips a leading "@机器人名 " mention token DingTalk leaves in group text. */
export const stripAtMention = (text: string): string => text.replace(/^@\S+\s*/, '').trim()

/** Text of the last assistant message in a snapshot (live stream included). */
export const lastAssistantText = (messages: { role: string; blocks: { type: string; text?: string }[] }[]): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || message.role !== 'assistant') continue
    return message.blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim()
  }
  return ''
}

/** 0-based assistant message count; used to detect a new turn during a run. */
const countAssistantMessages = (messages: { role: string }[]): number =>
  messages.reduce((count, message) => count + (message.role === 'assistant' ? 1 : 0), 0)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Fixed-text error conversion: raw SDK errors must never reach the UI. */
const fixedError = (error: unknown, fallback: string): string => {
  const text = error instanceof Error ? error.message : String(error)
  const stripped = text.replace(/\b(secret|appSecret|clientSecret)\b\s*[=:]\s*\S+/gi, '$1: [REDACTED]')
  return clip(stripped.trim() === '' ? fallback : stripped, 240)
}

export class DingtalkBridge {
  private config: DingtalkConfig = { enabled: false, clientId: '', clientSecret: '', allowList: [] }
  private client: DWClient | null = null
  private state: DingtalkState = 'disabled'
  private detail: string | null = null
  private connectedAt: number | null = null
  private lastMessageAt: number | null = null
  private lastSender: string | null = null
  private readonly listeners = new Set<(status: DingtalkStatus) => void>()
  private statusTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly runtime: PiRuntime,
    private readonly userDataDir: string,
  ) {}

  /** Loads persisted config; missing/corrupt file fails closed to disabled. */
  load(): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(this.userDataDir, CONFIG_FILE), 'utf8'))
      if (isDingtalkConfig(parsed)) this.config = parsed
    } catch { /* fail closed */ }
    this.setState(this.config.enabled ? 'stopped' : 'disabled', null)
  }

  getConfig(): DingtalkConfig {
    return this.config
  }

  getStatus(): DingtalkStatus {
    return {
      state: this.state,
      detail: this.detail,
      connectedAt: this.connectedAt,
      lastMessageAt: this.lastMessageAt,
      lastSender: this.lastSender,
    }
  }

  subscribe(listener: (status: DingtalkStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Persists a validated config. A change of enabled/credentials restarts the
   * connection; an allowlist-only change applies live without a reconnect.
   */
  async saveConfig(config: DingtalkConfig): Promise<DingtalkStatus> {
    const previous = this.config
    this.config = { ...config, allowList: [...config.allowList] }
    this.persist()
    const restartNeeded = previous.enabled !== config.enabled
      || previous.clientId !== config.clientId
      || previous.clientSecret !== config.clientSecret
    if (!restartNeeded) {
      if (config.enabled && this.state === 'error') void this.start()
      return this.getStatus()
    }
    await this.stop()
    if (config.enabled) await this.start()
    return this.getStatus()
  }

  /** Connects the Stream channel; a credential probe fails fast with a fixed message. */
  async start(): Promise<void> {
    if (this.client) return
    const { clientId, clientSecret } = this.config
    if (clientId === '' || clientSecret === '') {
      this.setState('error', '请先填写 Client ID 与 Client Secret')
      return
    }
    this.setState('connecting', '正在连接钉钉…')
    const client = new DWClient({ clientId, clientSecret })
    this.client = client
    client.registerCallbackListener(TOPIC_ROBOT, (downstream) => {
      // Ack immediately: without a response the server re-pushes after ~60s.
      client.socketCallBackResponse(downstream.headers.messageId, { status: 'SUCCESS' })
      void this.handleMessage(downstream)
    })
    try {
      // Credential probe: an invalid AppKey/AppSecret must surface right away
      // instead of looping the SDK's silent reconnect forever.
      await client.getAccessToken()
    } catch (error) {
      this.client = null
      try { client.disconnect() } catch { /* best-effort */ }
      this.setState('error', `钉钉凭证校验失败：${fixedError(error, '请检查 Client ID / Client Secret')}`)
      return
    }
    void client.connect().catch(() => { /* the SDK retries internally; polling tracks state */ })
    this.startStatusPolling()
  }

  /** Disconnects the Stream channel; config stays persisted. */
  async stop(): Promise<void> {
    this.stopStatusPolling()
    const client = this.client
    this.client = null
    if (client) {
      try { client.disconnect() } catch { /* best-effort */ }
    }
    this.setState(this.config.enabled ? 'stopped' : 'disabled', null)
  }

  dispose(): void {
    this.stopStatusPolling()
    this.listeners.clear()
    const client = this.client
    this.client = null
    if (client) {
      try { client.disconnect() } catch { /* best-effort */ }
    }
  }

  private persist(): void {
    try {
      writeFileSync(join(this.userDataDir, `${CONFIG_FILE}.tmp`), JSON.stringify(this.config, null, 2), { mode: 0o600 })
      renameSync(join(this.userDataDir, `${CONFIG_FILE}.tmp`), join(this.userDataDir, CONFIG_FILE))
    } catch { /* a failed persist keeps the in-memory config; next save retries */ }
  }

  private setState(state: DingtalkState, detail: string | null): void {
    this.state = state
    this.detail = detail
    if (state !== 'connected') this.connectedAt = null
    this.notify()
  }

  private notify(): void {
    const status = this.getStatus()
    for (const listener of this.listeners) {
      try { listener(status) } catch { /* a listener must never break the bridge */ }
    }
  }

  /** The SDK exposes no status events; poll its connection flag cheaply. */
  private startStatusPolling(): void {
    this.stopStatusPolling()
    this.statusTimer = setInterval(() => {
      const client = this.client
      if (!client) return
      if (client.connected && this.state !== 'connected') {
        this.connectedAt = Date.now()
        this.setState('connected', null)
      } else if (!client.connected && this.state === 'connected') {
        this.setState('connecting', '连接已断开，正在自动重连…')
      }
    }, STATUS_POLL_MS)
    this.statusTimer.unref?.()
  }

  private stopStatusPolling(): void {
    if (this.statusTimer !== null) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }
  }

  private async handleMessage(downstream: DWClientDownStream): Promise<void> {
    try {
      await this.routeMessage(downstream)
    } catch (error) {
      // The ack already went out; log so a silent no-reply stays diagnosable.
      console.error('[dingtalk] message routing failed:', error instanceof Error ? error.message : error)
    }
  }

  private async routeMessage(downstream: DWClientDownStream): Promise<void> {
    let payload: unknown
    try {
      payload = JSON.parse(downstream.data)
    } catch {
      console.error('[dingtalk] ignored: unparseable payload')
      return
    }
    if (!isRecord(payload)) {
      console.error('[dingtalk] ignored: non-object payload')
      return
    }
    const msgId = typeof payload.msgId === 'string' ? payload.msgId : '?'
    if (payload.msgtype !== 'text') {
      console.log(`[dingtalk] ignored msg ${msgId}: msgtype=${String(payload.msgtype)}`)
      return
    }
    const textPart = payload.text
    const content = isRecord(textPart) && typeof textPart.content === 'string' ? textPart.content.trim() : ''
    if (content === '') {
      console.log(`[dingtalk] ignored msg ${msgId}: empty text content`)
      return
    }
    const senderStaffId = typeof payload.senderStaffId === 'string' ? payload.senderStaffId : ''
    const senderNick = typeof payload.senderNick === 'string' && payload.senderNick !== '' ? payload.senderNick : '未知用户'
    const sessionWebhook = typeof payload.sessionWebhook === 'string' ? payload.sessionWebhook : ''
    // DingTalk conversationType: '1' = single chat, '2' = group chat (also
    // accept the human-readable aliases some gateways send).
    const conversationType = typeof payload.conversationType === 'string' ? payload.conversationType : '2'
    const isSingleChat = conversationType === '1' || conversationType === 'single'
    const isInAtList = payload.isInAtList === true || payload.isInAtList === 'true'
    if (sessionWebhook === '' || senderStaffId === '') {
      console.log(`[dingtalk] ignored msg ${msgId}: missing sessionWebhook/senderStaffId`)
      return
    }

    this.lastMessageAt = Date.now()
    this.lastSender = senderNick
    this.notify()

    // At-gate: single chat needs no mention; group chat requires @-mention.
    if (!isSingleChat && !isInAtList) {
      console.log(`[dingtalk] ignored msg ${msgId}: group message without @mention (isInAtList=${String(payload.isInAtList)})`)
      return
    }

    const allowList = this.config.allowList
    if (allowList.length > 0 && !allowList.includes(senderStaffId)) {
      console.log(`[dingtalk] denied msg ${msgId}: sender ${senderStaffId} not in allowlist`)
      await this.reply(sessionWebhook, senderStaffId, '⚠️ 你没有远程操控 Pi Agent 的权限（发送者不在允许列表）。')
      return
    }
    console.log(`[dingtalk] handling msg ${msgId}: sender=${senderNick}(${senderStaffId}) type=${conversationType} text=${JSON.stringify(stripAtMention(content).slice(0, 80))}`)

    const text = stripAtMention(content)
    if (text === '') return
    const command = text.split(/\s+/)[0]?.toLowerCase() ?? ''

    if (command === '/help') {
      await this.reply(sessionWebhook, senderStaffId, HELP_TEXT)
      return
    }
    if (command === '/ping') {
      await this.reply(sessionWebhook, senderStaffId, `pong · Pi Studio · ${this.state}`)
      return
    }
    if (command === '/status') {
      await this.reply(sessionWebhook, senderStaffId, this.statusMarkdown())
      return
    }
    if (command === '/abort' || command === '/stop') {
      await this.runtime.abort()
      await this.reply(sessionWebhook, senderStaffId, '⏹ 已中止当前任务。')
      return
    }
    await this.runRemotePrompt(sessionWebhook, senderStaffId, text)
  }

  /** Snapshot-based status card for /status. */
  private statusMarkdown(): string {
    const snap = this.runtime.snapshot()
    const session = snap.activeSessionPath
      ? snap.sessions.find((item) => item.path === snap.activeSessionPath) ?? null
      : null
    const approval = snap.toolApprovalMode === 'managed'
      ? '全托管（工具调用自动放行）'
      : '每次询问（工具调用需在 Pi Studio 窗口确认）'
    return [
      '**Pi Agent 远程状态**',
      `- 工作区：${snap.workspace?.name ?? '未选择'}`,
      `- 会话：${session?.title ?? '无'}`,
      `- 模型：${snap.activeModel ?? '未设置'}`,
      `- 运行状态：${RUN_STATE_LABELS[snap.runState] ?? snap.runState}`,
      `- 排队任务：${snap.queueCount}`,
      `- 审批模式：${approval}`,
      `- 消息数：${snap.messages.length}`,
    ].join('\n')
  }

  /**
   * Runs a remote prompt through the shared PiRuntime and reports the final
   * assistant text back. Completion is detected by polling snapshots (the
   * runtime's prompt() promise settles at preflight accept, not at run end):
   * the run counts as settled once runState leaves 'idle' and returns, the
   * run errors, or the grace window passes after the preflight accepted.
   * Progress text is reported at most every PROGRESS_INTERVAL_MS.
   */
  private async runRemotePrompt(sessionWebhook: string, senderStaffId: string, text: string): Promise<void> {
    const pre = this.runtime.snapshot()
    if (pre.runState !== 'idle') {
      await this.reply(sessionWebhook, senderStaffId, `⏳ Pi 正在执行其他任务（${RUN_STATE_LABELS[pre.runState] ?? pre.runState}），请稍后再试。`)
      return
    }
    if (!pre.workspace || !pre.activeSessionPath) {
      await this.reply(sessionWebhook, senderStaffId, '⚠️ Pi 尚未打开工作区或会话，请先在 Pi Studio 中选择工作区。')
      return
    }
    await this.reply(sessionWebhook, senderStaffId, `✅ 已收到任务，Pi 开始执行。\n\n> ${clip(text.replace(/\n+/g, ' '), 200)}`)
    const baselineCount = countAssistantMessages(pre.messages)
    const startedAt = Date.now()
    try {
      await this.runtime.prompt(text)
    } catch { /* run failures surface through the snapshot below */ }
    let lastProgressAt = 0
    let lastProgressText = ''
    let final = ''
    for (;;) {
      await sleep(1000)
      const snap = this.runtime.snapshot()
      const assistantText = lastAssistantText(snap.messages)
      if (snap.runState === 'error') {
        final = assistantText
        break
      }
      const elapsed = Date.now() - startedAt
      if (snap.runState === 'idle' && (countAssistantMessages(snap.messages) > baselineCount || elapsed > IDLE_SETTLE_GRACE_MS)) {
        final = assistantText
        break
      }
      if (elapsed > REMOTE_RUN_TIMEOUT_MS) {
        await this.reply(sessionWebhook, senderStaffId, '⏰ 任务超时（30 分钟），Pi 仍在后台继续，不再等待回复。')
        return
      }
      if (assistantText !== '' && assistantText !== lastProgressText && elapsed - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        lastProgressAt = elapsed
        lastProgressText = assistantText
        await this.reply(sessionWebhook, senderStaffId, `⏳ 正在执行…\n\n${clip(assistantText, PROGRESS_MAX_CHARS)}`)
      }
    }
    const error = this.runtime.snapshot().error
    if (error) {
      const detail = typeof error.detail === 'string' && error.detail !== '' ? `\n${error.detail}` : ''
      await this.reply(sessionWebhook, senderStaffId, `❌ 任务失败：${clip(`${error.message}${detail}`, ERROR_MAX_CHARS)}`)
    } else if (final !== '') {
      await this.reply(sessionWebhook, senderStaffId, `✅ 任务完成\n\n${final}`)
    } else {
      await this.reply(sessionWebhook, senderStaffId, '任务已结束，但没有产生文本输出（可能已被中止）。')
    }
  }

  /** POSTs a markdown reply to the message's session webhook, @-mentioning the sender. */
  private async reply(sessionWebhook: string, atUserId: string, markdown: string): Promise<void> {
    const client = this.client
    if (!client) return
    try {
      const token = await client.getAccessToken()
      const accessToken = typeof token === 'string' && token !== '' ? token : ''
      if (accessToken === '') {
        console.error('[dingtalk] reply failed: empty access token')
        return
      }
      const response = await fetch(sessionWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': accessToken,
        },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { title: 'Pi Agent', text: clip(markdown, REPLY_MAX_CHARS) },
          at: { atUserIds: [atUserId], isAtAll: false },
        }),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        console.error(`[dingtalk] reply HTTP ${response.status}: ${detail.slice(0, 300)}`)
      }
    } catch (error) {
      // A failed reply must never break the run loop, but must stay diagnosable.
      console.error('[dingtalk] reply failed:', error instanceof Error ? error.message : error)
    }
  }
}
