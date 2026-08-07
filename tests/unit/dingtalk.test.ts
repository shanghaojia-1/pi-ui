/** @vitest-environment node */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DingtalkConfig, DingtalkStatus } from '../../src/shared/contracts'
import { DingtalkBridge } from '../../src/main/dingtalk'

// --- dingtalk-stream SDK fake: the bridge is tested against a stub client ---
// Defined inside vi.hoisted so the mock factory (hoisted above this file's
// imports) can reference the class without a TDZ error.
const fakeModule = vi.hoisted(() => {
  /** Set to true to make the credential probe reject (bad AppKey/AppSecret). */
  let failProbe = false
  type Downstream = { headers: { messageId: string }; data: string }
  class FakeDWClient {
    connected = false
    config: { clientId: string; clientSecret: string }
    callback: ((downstream: Downstream) => void) | null = null
    getAccessToken = vi.fn().mockImplementation(async () => {
      if (failProbe) throw new Error('invalid appKey or appSecret')
      return 'fake-access-token'
    })
    connect = vi.fn().mockImplementation(async () => { this.connected = true })
    disconnect = vi.fn().mockImplementation(() => { this.connected = false })
    socketCallBackResponse = vi.fn()

    constructor(opts: { clientId: string; clientSecret: string }) {
      this.config = opts
      instances.push(this)
    }

    registerCallbackListener(_topic: string, callback: (downstream: Downstream) => void): void {
      this.callback = callback
    }

    /** Test helper: deliver one BOT_MESSAGE downstream. */
    deliver(messageId: string, payload: Record<string, unknown>): void {
      this.callback?.({ headers: { messageId }, data: JSON.stringify(payload) })
    }
  }
  const instances: FakeDWClient[] = []
  return { FakeDWClient, instances, failProbe: () => { failProbe = true }, clearProbe: () => { failProbe = false } }
})

vi.mock('dingtalk-stream', () => ({
  DWClient: fakeModule.FakeDWClient,
  TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
  EventAck: { SUCCESS: 'SUCCESS' },
}))

type FakeDWClient = InstanceType<typeof fakeModule.FakeDWClient>
const dwClientInstances: FakeDWClient[] = fakeModule.instances

// --- minimal PiRuntime fake driven by a mutable snapshot ---
type FakeSnapshot = {
  runState: string
  workspace: { path: string; name: string } | null
  activeSessionPath: string | null
  messages: { role: string; blocks: { type: string; text?: string }[] }[]
  sessions: { path: string; title: string }[]
  activeModel: string | null
  queueCount: number
  toolApprovalMode: 'ask' | 'managed'
  error: { message: string; detail?: string; recoverable: boolean } | null
}

const BASE_SNAPSHOT: FakeSnapshot = {
  runState: 'idle',
  workspace: { path: '/ws', name: 'ws' },
  activeSessionPath: '/ws/session.jsonl',
  messages: [],
  sessions: [{ path: '/ws/session.jsonl', title: '远程会话' }],
  activeModel: 'anthropic:claude-sonnet',
  queueCount: 0,
  toolApprovalMode: 'ask',
  error: null,
}

function makeRuntime(snapshot: FakeSnapshot) {
  return {
    snapshot: () => snapshot,
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  }
}

const emptyConfig = (over: Partial<DingtalkConfig> = {}): DingtalkConfig => ({
  enabled: true, clientId: 'app-key', clientSecret: 'app-secret', allowList: [], ...over,
})

/** Collects replies sent through the session webhook. */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('DingtalkBridge helpers', () => {
  it('strips a leading @mention token', async () => {
    const { stripAtMention } = await import('../../src/main/dingtalk')
    expect(stripAtMention('@Pi 帮我看看')).toBe('帮我看看')
    expect(stripAtMention('@bot  task')).toBe('task')
    expect(stripAtMention('没有艾特')).toBe('没有艾特')
  })

  it('extracts the last assistant text and clips long payloads', async () => {
    const { lastAssistantText, clip } = await import('../../src/main/dingtalk')
    const messages = [
      { role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: '  first  ' }, { type: 'tool', id: 't', name: 'bash', status: 'success' as const, input: 'x' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'second' }] },
    ]
    expect(lastAssistantText(messages)).toBe('second')
    expect(lastAssistantText([{ role: 'user', blocks: [] }])).toBe('')
    expect(clip('a'.repeat(100), 10)).toContain('已截断')
    expect(clip('short', 100)).toBe('short')
  })
})

describe('DingtalkBridge config persistence', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dingtalk-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('fails closed to disabled on missing or corrupt config', () => {
    const runtime = makeRuntime({ ...BASE_SNAPSHOT })
    const bridge = new DingtalkBridge(runtime as never, dir)
    bridge.load()
    expect(bridge.getStatus().state).toBe('disabled')
    writeFileSync(join(dir, 'dingtalk.json'), 'not json{')
    bridge.load()
    expect(bridge.getStatus().state).toBe('disabled')
  })

  it('persists config atomically with restricted permissions', async () => {
    const runtime = makeRuntime({ ...BASE_SNAPSHOT })
    const bridge = new DingtalkBridge(runtime as never, dir)
    bridge.load()
    await bridge.saveConfig(emptyConfig())
    const raw = readFileSync(join(dir, 'dingtalk.json'), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ enabled: true, clientId: 'app-key', clientSecret: 'app-secret' })
    expect(existsSync(join(dir, 'dingtalk.json.tmp'))).toBe(false)
    // macOS/Windows permission semantics differ; only assert POSIX mode bits.
    if (process.platform === 'linux') {
      expect(statSync(join(dir, 'dingtalk.json')).mode & 0o777).toBe(0o600)
    }
    // A saved config loads back into the stopped state (enabled).
    bridge.load()
    expect(bridge.getStatus().state).toBe('stopped')
  })

  it('reloads a previously saved config', async () => {
    writeFileSync(join(dir, 'dingtalk.json'), JSON.stringify(emptyConfig({ allowList: ['staff-9'] })))
    const runtime = makeRuntime({ ...BASE_SNAPSHOT })
    const bridge = new DingtalkBridge(runtime as never, dir)
    bridge.load()
    expect(bridge.getConfig()).toMatchObject({ enabled: true, allowList: ['staff-9'] })
    expect(bridge.getStatus().state).toBe('stopped')
  })
})

describe('DingtalkBridge connection lifecycle', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dingtalk-test-')); dwClientInstances.length = 0 })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.useRealTimers() })

  it('refuses to start without credentials', async () => {
    const runtime = makeRuntime({ ...BASE_SNAPSHOT })
    const bridge = new DingtalkBridge(runtime as never, dir)
    bridge.load()
    await bridge.start()
    expect(bridge.getStatus().state).toBe('error')
    expect(bridge.getStatus().detail).toContain('Client ID')
    expect(dwClientInstances.length).toBe(0)
  })

  it('fails fast with a fixed message when the credential probe rejects', async () => {
    writeFileSync(join(dir, 'dingtalk.json'), JSON.stringify(emptyConfig()))
    fakeModule.failProbe()
    const runtime = makeRuntime({ ...BASE_SNAPSHOT })
    const bridge = new DingtalkBridge(runtime as never, dir)
    bridge.load()
    await bridge.start()
    fakeModule.clearProbe()
    expect(bridge.getStatus().state).toBe('error')
    expect(bridge.getStatus().detail).toContain('凭证校验失败')
    expect(dwClientInstances[0]!.connect).not.toHaveBeenCalled()
  })

  it('connects, reports connected via polling, and stops cleanly', async () => {
    vi.useFakeTimers()
    const runtime = makeRuntime({ ...BASE_SNAPSHOT })
    const bridge = new DingtalkBridge(runtime as never, dir)
    bridge.load()
    await bridge.saveConfig(emptyConfig())
    await bridge.start()
    expect(bridge.getStatus().state).toBe('connecting')
    const client = dwClientInstances[0]!
    expect(client.getAccessToken).toHaveBeenCalled()
    expect(client.connect).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4000)
    expect(bridge.getStatus().state).toBe('connected')
    expect(bridge.getStatus().connectedAt).not.toBeNull()
    await bridge.stop()
    expect(client.disconnect).toHaveBeenCalled()
    expect(bridge.getStatus().state).toBe('stopped')
  })

  it('reconnects and notifies subscribers on state changes', async () => {
    vi.useFakeTimers()
    const runtime = makeRuntime({ ...BASE_SNAPSHOT })
    const bridge = new DingtalkBridge(runtime as never, dir)
    bridge.load()
    const seen: DingtalkStatus[] = []
    bridge.subscribe((status) => seen.push(status))
    await bridge.saveConfig(emptyConfig())
    await bridge.start()
    await vi.advanceTimersByTimeAsync(4000)
    expect(seen.some((s) => s.state === 'connected')).toBe(true)
    dwClientInstances[0]!.connected = false // simulate a dropped socket
    await vi.advanceTimersByTimeAsync(4000)
    expect(bridge.getStatus().state).toBe('connecting')
    expect(seen.some((s) => s.state === 'connecting' && s.detail?.includes('重连'))).toBe(true)
  })

  it('restarts the client when credentials change on save', async () => {
    const runtime = makeRuntime({ ...BASE_SNAPSHOT })
    const bridge = new DingtalkBridge(runtime as never, dir)
    bridge.load()
    await bridge.saveConfig(emptyConfig())
    expect(dwClientInstances.length).toBe(1)
    // Allowlist-only change must NOT reconnect.
    await bridge.saveConfig(emptyConfig({ allowList: ['staff-1'] }))
    expect(dwClientInstances.length).toBe(1)
    await bridge.saveConfig(emptyConfig({ clientSecret: 'new-secret' }))
    expect(dwClientInstances.length).toBe(2)
    expect(dwClientInstances[1]!.config.clientSecret).toBe('new-secret')
  })
})

describe('DingtalkBridge message routing', () => {
  let dir: string
  let fetchMock: ReturnType<typeof vi.fn>
  let runtime: ReturnType<typeof makeRuntime>
  let bridge: DingtalkBridge
  let client: FakeDWClient
  let snapshot: FakeSnapshot

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dingtalk-test-'))
    dwClientInstances.length = 0
    vi.useFakeTimers()
    fetchMock = stubFetch()
    snapshot = { ...BASE_SNAPSHOT, messages: [] }
    runtime = makeRuntime(snapshot)
    bridge = new DingtalkBridge(runtime as never, dir)
    bridge.load()
    void bridge.saveConfig(emptyConfig({ allowList: ['staff-1'] }))
    void bridge.start()
    client = dwClientInstances[0]!
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const botMessage = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    msgtype: 'text',
    text: { content: '@Pi 帮我看看' },
    senderStaffId: 'staff-1',
    senderNick: '张三',
    sessionWebhook: 'https://webhook.example/session',
    conversationType: 'group',
    isInAtList: true,
    ...over,
  })

  it('ignores group chatter that does not @ the bot', async () => {
    client.deliver('m1', botMessage({ isInAtList: false }))
    await vi.advanceTimersByTimeAsync(100)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts single-chat messages without any @mention (DingTalk type "1")', async () => {
    client.deliver('m1', botMessage({ conversationType: '1', isInAtList: undefined }))
    await vi.advanceTimersByTimeAsync(100)
    expect(runtime.prompt).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).markdown.text).toContain('已收到任务')
  })

  it('accepts group @mentions with DingTalk type "2" and string "true" flag', async () => {
    client.deliver('m1', botMessage({ conversationType: '2', isInAtList: 'true' }))
    await vi.advanceTimersByTimeAsync(100)
    expect(runtime.prompt).toHaveBeenCalledTimes(1)
  })

  it('denies senders outside the allowlist with a fixed message', async () => {
    client.deliver('m1', botMessage({ senderStaffId: 'staff-2' }))
    await vi.advanceTimersByTimeAsync(100)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)
    expect(body.markdown.text).toContain('没有远程操控')
    expect(body.at.atUserIds).toEqual(['staff-2'])
    // The message was acked so the server never re-pushes it.
    expect(client.socketCallBackResponse).toHaveBeenCalledWith('m1', expect.anything())
  })

  it('answers /ping from an allowed sender', async () => {
    client.deliver('m2', botMessage({ text: { content: '/ping' } }))
    await vi.advanceTimersByTimeAsync(100)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)
    expect(body.markdown.text).toContain('pong')
  })

  it('routes a plain prompt through the runtime and reports the final answer', async () => {
    runtime.prompt.mockImplementation(async () => {
      snapshot.runState = 'running'
      snapshot.messages = [{ role: 'assistant', blocks: [{ type: 'text', text: '正在思考…' }] }]
    })
    const p = (bridge as unknown as { runRemotePrompt(webhook: string, staffId: string, text: string): Promise<void> })
      .runRemotePrompt('https://webhook.example/session', 'staff-1', '帮我看看代码')
    await vi.advanceTimersByTimeAsync(100) // prompt resolves + ack reply flushes
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).markdown.text).toContain('已收到任务')
    // Running state: no progress yet (interval not reached).
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Long task: progress reply after the interval.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).markdown.text).toContain('正在执行')
    // Settled: run returns to idle with a final assistant message.
    snapshot.runState = 'idle'
    snapshot.messages = [{ role: 'assistant', blocks: [{ type: 'text', text: '最终答案' }] }]
    await vi.advanceTimersByTimeAsync(2000)
    await p
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const final = JSON.parse(fetchMock.mock.calls[2]![1]!.body as string)
    expect(final.markdown.text).toContain('任务完成')
    expect(final.markdown.text).toContain('最终答案')
  })

  it('reports run failures from the snapshot error', async () => {
    runtime.prompt.mockImplementation(async () => {
      snapshot.runState = 'error'
      snapshot.error = { message: 'Run failed', detail: 'provider timeout', recoverable: true }
    })
    const p = (bridge as unknown as { runRemotePrompt(webhook: string, staffId: string, text: string): Promise<void> })
      .runRemotePrompt('https://webhook.example/session', 'staff-1', '跑一下')
    await vi.advanceTimersByTimeAsync(2000)
    await p
    const lastCall = fetchMock.mock.calls.at(-1)!
    expect(JSON.parse(lastCall[1]!.body as string).markdown.text).toContain('任务失败')
    expect(JSON.parse(lastCall[1]!.body as string).markdown.text).toContain('provider timeout')
  })

  it('refuses a second task while the agent is busy', async () => {
    snapshot.runState = 'running'
    client.deliver('m3', botMessage({ text: { content: '再来一个' } }))
    await vi.advanceTimersByTimeAsync(100)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).markdown.text).toContain('正在执行其他任务')
    expect(runtime.prompt).not.toHaveBeenCalled()
  })

  it('aborts the current run on /abort', async () => {
    client.deliver('m4', botMessage({ text: { content: '/abort' } }))
    await vi.advanceTimersByTimeAsync(100)
    expect(runtime.abort).toHaveBeenCalled()
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).markdown.text).toContain('已中止')
  })

  it('ignores non-text messages', async () => {
    client.deliver('m5', botMessage({ msgtype: 'picture' }))
    await vi.advanceTimersByTimeAsync(100)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(runtime.prompt).not.toHaveBeenCalled()
  })
})
