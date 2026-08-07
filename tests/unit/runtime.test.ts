import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionEvent, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { BrowserWindow } from 'electron'
import type { SettingsPatch, ToolBlock } from '../../src/shared/contracts'
import { PiRuntime } from '../../src/main/runtime'

const mocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  getAgentDir: vi.fn(),
  ModelRuntime: { create: vi.fn() },
  SessionManager: { create: vi.fn(), open: vi.fn(), list: vi.fn(), listAll: vi.fn() },
  DefaultResourceLoader: vi.fn(),
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  app: { getAppPath: vi.fn(() => '/tmp/pi-app'), getVersion: vi.fn(() => '0.1.0') },
}))

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {},
  dialog: mocks.dialog,
  app: mocks.app,
}))

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: mocks.createAgentSession,
  DefaultResourceLoader: mocks.DefaultResourceLoader,
  getAgentDir: mocks.getAgentDir,
  ModelRuntime: mocks.ModelRuntime,
  SessionManager: mocks.SessionManager,
}))

// The runtime now reaches the SDK through the engine loader; keep the mocked
// SDK surface in play by serving it from the mocked loader.
vi.mock('../../src/main/engine-loader', () => ({
  getEngineApi: () => ({
    createAgentSession: mocks.createAgentSession,
    DefaultResourceLoader: mocks.DefaultResourceLoader,
    getAgentDir: mocks.getAgentDir,
    ModelRuntime: mocks.ModelRuntime,
    SessionManager: mocks.SessionManager,
    DefaultPackageManager: class DefaultPackageManager {},
    // Minimal frontmatter parser: --- block of `key: value` lines + body.
    parseFrontmatter: (content: string) => {
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
      if (!match) return { frontmatter: {}, body: content }
      const frontmatter: Record<string, string> = {}
      for (const line of match[1]!.split('\n')) {
        const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
        if (m) frontmatter[m[1]!] = m[2]!
      }
      return { frontmatter, body: match[2] ?? '' }
    },
  }),
  getEnginePackagePath: () => '/tmp/pi-engine',
}))

const TMP = realpathSync(tmpdir())

class FakeWindow {
  webContents = { send: vi.fn() }
  isDestroyed(): boolean { return false }
}

class FakeSettingsManager {
  defaultProvider: string | undefined
  defaultModel: string | undefined
  defaultThinkingLevel = 'medium'
  compactionEnabled = false
  retryEnabled = false
  httpIdleTimeoutMs = 300_000
  compaction = { reserveTokens: 3000, keepRecentTokens: 5000 }
  retry: { maxRetries: number | null; baseDelayMs: number | null; maxDelayMs: number | null } = { maxRetries: 3, baseDelayMs: 2000, maxDelayMs: null }
  errors: Array<{ scope: string; error: Error }> = []
  calls: string[] = []
  flushImpl: (() => Promise<void>) | null = null

  getDefaultProvider(): string | undefined { this.calls.push('getDefaultProvider'); return this.defaultProvider }
  getDefaultModel(): string | undefined { this.calls.push('getDefaultModel'); return this.defaultModel }
  getDefaultThinkingLevel(): string { this.calls.push('getDefaultThinkingLevel'); return this.defaultThinkingLevel }
  getCompactionEnabled(): boolean { this.calls.push('getCompactionEnabled'); return this.compactionEnabled }
  getRetryEnabled(): boolean { this.calls.push('getRetryEnabled'); return this.retryEnabled }
  getHttpIdleTimeoutMs(): number { this.calls.push('getHttpIdleTimeoutMs'); return this.httpIdleTimeoutMs }
  getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
    this.calls.push('getCompactionSettings')
    return { enabled: this.compactionEnabled, reserveTokens: this.compaction.reserveTokens, keepRecentTokens: this.compaction.keepRecentTokens }
  }
  getRetrySettings(): { enabled: boolean; maxRetries: number | null; baseDelayMs: number | null; maxDelayMs: number | null } {
    this.calls.push('getRetrySettings')
    return { enabled: this.retryEnabled, maxRetries: this.retry.maxRetries, baseDelayMs: this.retry.baseDelayMs, maxDelayMs: this.retry.maxDelayMs }
  }
  setDefaultProvider(provider: string): void { this.calls.push('setDefaultProvider'); this.defaultProvider = provider }
  setDefaultModel(modelId: string): void { this.calls.push('setDefaultModel'); this.defaultModel = modelId }
  setDefaultModelAndProvider(provider: string, modelId: string): void {
    this.calls.push('setDefaultModelAndProvider'); this.defaultProvider = provider; this.defaultModel = modelId
  }
  setDefaultThinkingLevel(level: string): void { this.calls.push('setDefaultThinkingLevel'); this.defaultThinkingLevel = level }
  setCompactionEnabled(enabled: boolean): void { this.calls.push('setCompactionEnabled'); this.compactionEnabled = enabled }
  setRetryEnabled(enabled: boolean): void { this.calls.push('setRetryEnabled'); this.retryEnabled = enabled }
  setHttpIdleTimeoutMs(ms: number): void { this.calls.push('setHttpIdleTimeoutMs'); this.httpIdleTimeoutMs = ms }
  async flush(): Promise<void> {
    this.calls.push('flush')
    if (this.flushImpl) {
      try { await this.flushImpl() } catch (error) {
        // Mirror the SDK: a failing flush lands in the error queue.
        this.errors.push({ scope: 'global', error: error instanceof Error ? error : new Error(String(error)) })
      }
    }
  }
  drainErrors(): Array<{ scope: string; error: Error }> { this.calls.push('drainErrors'); return this.errors.splice(0) }
}

class FakeSession {
  isStreaming = false
  messages: unknown[] = []
  model: unknown = null
  thinkingLevel = 'medium'
  sessionId = 'fake-session'
  sessionFile: string | null = null
  settingsManager: FakeSettingsManager | null = null
  promptImpl: ((text: string, options?: Record<string, unknown>) => Promise<unknown>) | null = null
  abortImpl: (() => Promise<void>) | null = null
  bindExtensionsImpl: (() => Promise<void>) | null = null
  subscribeImpl: (() => () => void) | null = null
  promptCalls: Array<{ text: string; options?: unknown }> = []
  order: string[] = []
  disposed = false
  getContextUsage: (() => unknown) | null = null
  private subscriber: ((event: unknown) => void) | null = null
  activeToolNames = ['read', 'bash', 'edit', 'write', 'subagent']

  prompt(text: string, options?: Record<string, unknown>): Promise<unknown> {
    this.promptCalls.push({ text, options })
    return this.promptImpl ? this.promptImpl(text, options) : Promise.resolve()
  }
  clearQueue(): void { this.order.push('clearQueue') }
  async abort(): Promise<void> {
    this.order.push('abort')
    if (this.abortImpl) await this.abortImpl()
  }
  dispose(): void { this.disposed = true; this.order.push('dispose') }
  subscribe(cb: (event: unknown) => void): () => void {
    if (this.subscribeImpl) return this.subscribeImpl()
    this.subscriber = cb
    return () => { this.subscriber = null }
  }
  async bindExtensions(): Promise<void> {
    if (this.bindExtensionsImpl) await this.bindExtensionsImpl()
  }
  getActiveToolNames(): string[] { return [...this.activeToolNames] }
  setActiveToolsByName(names: string[]): void { this.activeToolNames = [...names] }
  async setModel(): Promise<void> {}
  setThinkingLevel(): void {}
  emit(event: unknown): void { this.subscriber?.(event) }
}

const preflightOf = (options: unknown): ((success: boolean) => void) | undefined =>
  (options as { preflightResult?: (success: boolean) => void }).preflightResult

type RuntimePriv = {
  handleEvent(event: AgentSessionEvent): void
  liveTools: Map<string, ToolBlock>
  liveQueues: Map<string, { ids: string[]; nextStart: number }>
}
const priv = (runtime: PiRuntime): RuntimePriv => runtime as unknown as RuntimePriv

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let agentDir: string
beforeAll(() => { agentDir = mkdtempSync(join(TMP, 'pi-agent-')) })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getAgentDir.mockReturnValue(agentDir)
  mocks.app.getAppPath.mockReturnValue('/tmp/pi-app')
  mocks.app.getVersion.mockReturnValue('0.1.0')
  mocks.ModelRuntime.create.mockResolvedValue({ getAvailable: async () => [], getModel: () => null })
  mocks.SessionManager.listAll.mockResolvedValue([])
  mocks.SessionManager.create.mockImplementation((path: string) => ({ getSessionDir: () => path }))
  mocks.SessionManager.open.mockReturnValue({})
  mocks.createAgentSession.mockResolvedValue({ session: new FakeSession(), modelFallbackMessage: undefined })
  mocks.DefaultResourceLoader.mockImplementation((options: unknown) => ({ reload: async () => {}, options }))
})

async function initRuntime(workspace?: string, session?: FakeSession): Promise<PiRuntime> {
  if (session) mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined })
  const runtime = new PiRuntime()
  runtime.setWindow(new FakeWindow() as unknown as BrowserWindow)
  await runtime.initialize(workspace ?? mkdtempSync(join(TMP, 'pi-ws-')))
  return runtime
}

describe('session tool activation', () => {
  it('keeps extension tools active while adding the read-only search tools', async () => {
    const session = new FakeSession()
    await initRuntime(undefined, session)

    const options = mocks.createAgentSession.mock.calls[0]![0] as Record<string, unknown>
    expect(options).not.toHaveProperty('tools')
    expect(session.activeToolNames).toEqual([
      'read', 'bash', 'edit', 'write', 'subagent', 'grep', 'find', 'ls',
    ])
  })
})

describe('prompt IPC', () => {
  it('waits only for preflight on a non-streaming run and records async failure only in the current session', async () => {
    const sessionA = new FakeSession()
    let acceptFirst!: () => void
    let rejectFirst!: (reason: Error) => void
    sessionA.promptImpl = (_text, options) => {
      const preflight = preflightOf(options)
      acceptFirst = () => preflight?.(true)
      return new Promise((_resolve, reject) => { rejectFirst = reject })
    }
    const runtime = await initRuntime(undefined, sessionA)

    // The returned promise settles at preflight accept, not at run completion.
    const first = runtime.prompt('  hello world  ')
    expect(sessionA.promptCalls).toHaveLength(1)
    expect(sessionA.promptCalls[0]!.text).toBe('hello world')
    expect(sessionA.promptCalls[0]!.options).toEqual({ preflightResult: expect.any(Function) })

    acceptFirst()
    await expect(first).resolves.toBeUndefined()

    // Async failure lands on the current session/epoch as a recoverable error.
    rejectFirst(new Error('llm failed'))
    await flush()
    expect(runtime.snapshot().error).toEqual({ message: 'Run failed', detail: 'llm failed', recoverable: true })
    expect(runtime.snapshot().runState).toBe('error')

    // A second in-flight prompt must not touch the UI after switching sessions.
    let rejectSecond!: (reason: Error) => void
    sessionA.promptImpl = () => new Promise((_resolve, reject) => { rejectSecond = reject })
    void runtime.prompt('second')
    const sessionB = new FakeSession()
    mocks.createAgentSession.mockResolvedValue({ session: sessionB, modelFallbackMessage: undefined })
    const switching = runtime.newSession()
    await flush()
    rejectSecond(new Error('late failure'))
    await switching
    await flush()
    expect(runtime.snapshot().error).toBeNull()
    expect(runtime.snapshot().runState).toBe('idle')
  })

  it('ignores blank prompts and reports when no session is active', async () => {
    const session = new FakeSession()
    const runtime = await initRuntime(undefined, session)
    await runtime.prompt('   ')
    expect(session.promptCalls).toHaveLength(0)
    runtime.dispose()
    await flush()
    await runtime.prompt('hi')
    expect(runtime.snapshot().error?.message).toBe('No active session')
  })

  it('routes a prompt during streaming to followUp immediately and aborts queue-first', async () => {
    const session = new FakeSession()
    const runtime = await initRuntime(undefined, session)

    session.isStreaming = true
    await runtime.prompt('second')
    expect(session.promptCalls[0]!.options).toEqual({ streamingBehavior: 'followUp' })

    session.isStreaming = false
    await runtime.prompt('third')
    expect(session.promptCalls[1]!.options).toEqual({ preflightResult: expect.any(Function) })

    await runtime.abort()
    expect(session.order).toEqual(['clearQueue', 'abort'])
  })

  it('dispose waits for the preflight barrier and the settled run before tearing down', async () => {
    const sessionA = new FakeSession()
    let acceptPreflight!: () => void
    let resolveRun!: () => void
    sessionA.promptImpl = (_text, options) => {
      acceptPreflight = () => preflightOf(options)?.(true)
      return new Promise<void>((resolve) => { resolveRun = resolve })
    }
    const runtime = await initRuntime(undefined, sessionA)
    void runtime.prompt('work')

    const sessionB = new FakeSession()
    sessionB.sessionFile = join(TMP, 'pi-ws-', 'second.jsonl')
    mocks.createAgentSession.mockResolvedValue({ session: sessionB, modelFallbackMessage: undefined })
    const switching = runtime.newSession()
    await flush()
    // Preflight still pending: no teardown may run yet.
    expect(sessionA.order).toEqual([])
    expect(sessionA.disposed).toBe(false)

    acceptPreflight()
    await flush()
    // Queue cleared and aborted, but the run must settle before dispose.
    expect(sessionA.order).toEqual(['clearQueue', 'abort'])
    expect(sessionA.disposed).toBe(false)

    resolveRun()
    await switching
    expect(sessionA.order).toEqual(['clearQueue', 'abort', 'dispose'])
    expect(sessionA.disposed).toBe(true)
    expect(runtime.snapshot().activeSessionPath).toBe(sessionB.sessionFile)
  })

  it('abort waits for a pending preflight before clearing the queue', async () => {
    const session = new FakeSession()
    let acceptPreflight!: () => void
    let resolveRun!: () => void
    session.promptImpl = (_text, options) => {
      acceptPreflight = () => preflightOf(options)?.(true)
      return new Promise<void>((resolve) => { resolveRun = resolve })
    }
    const runtime = await initRuntime(undefined, session)
    void runtime.prompt('work')

    const aborted = runtime.abort()
    await flush()
    expect(session.order).toEqual([]) // preflight still pending: abort must wait

    acceptPreflight()
    await flush()
    expect(session.order).toEqual(['clearQueue', 'abort'])

    resolveRun()
    await aborted
    await flush()
    expect(runtime.snapshot().runState).toBe('idle')
    expect(runtime.snapshot().error).toBeNull()
  })

  it('a prompt rejecting without a preflight callback still unblocks session teardown', async () => {
    const sessionA = new FakeSession()
    let rejectRun!: (reason: Error) => void
    sessionA.promptImpl = () => new Promise((_resolve, reject) => { rejectRun = reject })
    const runtime = await initRuntime(undefined, sessionA)
    void runtime.prompt('boom')

    const sessionB = new FakeSession()
    mocks.createAgentSession.mockResolvedValue({ session: sessionB, modelFallbackMessage: undefined })
    const switching = runtime.newSession()
    await flush()
    expect(sessionA.order).toEqual([]) // barrier pending: no callback fired yet

    rejectRun(new Error('rejected in preflight'))
    await switching // must not deadlock
    expect(sessionA.order).toEqual(['clearQueue', 'abort', 'dispose'])
    expect(runtime.snapshot().error).toBeNull() // stale run failure must not surface
  })

  it('a late-settling earlier run does not clear the newer run barrier, so dispose still waits for it', async () => {
    const session = new FakeSession()
    const accepts: Array<() => void> = []
    const resolvers: Array<() => void> = []
    session.promptImpl = (_text, options) => {
      const preflight = preflightOf(options)
      accepts.push(() => preflight?.(true))
      return new Promise<void>((resolve) => { resolvers.push(resolve) })
    }
    const runtime = await initRuntime(undefined, session)
    void runtime.prompt('first')
    void runtime.prompt('second')
    expect(accepts).toHaveLength(2)

    // The earlier run settles first without a preflight callback; only its own
    // barrier may settle and only its own tracking entry may be removed.
    resolvers[0]!()
    await flush()

    const disposing = runtime.dispose()
    await flush()
    expect(session.order).toEqual([]) // still waiting on the second run's preflight

    accepts[1]!()
    await flush()
    expect(session.order).toEqual(['clearQueue', 'abort'])

    resolvers[1]!()
    await disposing
    expect(session.order).toEqual(['clearQueue', 'abort', 'dispose'])
  })

  it('tracks and waits for two concurrent pending runs, settling both before teardown', async () => {
    const session = new FakeSession()
    const accepts: Array<() => void> = []
    const resolvers: Array<() => void> = []
    session.promptImpl = (_text, options) => {
      const preflight = preflightOf(options)
      accepts.push(() => preflight?.(true))
      return new Promise<void>((resolve) => { resolvers.push(resolve) })
    }
    const runtime = await initRuntime(undefined, session)
    void runtime.prompt('first')
    void runtime.prompt('second')
    expect(accepts).toHaveLength(2)
    // Both runs are tracked independently, not just the last one.
    const activeRuns = (runtime as unknown as { activeRuns: Map<object, Set<object>> }).activeRuns
    expect(activeRuns.get(session)?.size).toBe(2)

    const disposing = runtime.dispose()
    await flush()
    expect(session.order).toEqual([]) // both preflights pending: teardown waits for both

    accepts[0]!()
    await flush()
    expect(session.order).toEqual([]) // the second preflight still gates teardown

    accepts[1]!()
    await flush()
    expect(session.order).toEqual(['clearQueue', 'abort'])
    expect(session.disposed).toBe(false)

    resolvers[0]!()
    await flush()
    expect(session.disposed).toBe(false) // the second run is still settling
    resolvers[1]!()
    await disposing
    expect(session.order).toEqual(['clearQueue', 'abort', 'dispose'])
    expect(session.disposed).toBe(true)
  })

  it('completes teardown after the bounded cleanup timeout when preflight never fires and the run never settles', async () => {
    const session = new FakeSession()
    session.promptImpl = () => new Promise(() => {}) // preflight never fires, run never settles
    mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined })
    const runtime = new PiRuntime({ cleanupTimeoutMs: 1000 })
    runtime.setWindow(new FakeWindow() as unknown as BrowserWindow)
    await runtime.initialize(mkdtempSync(join(TMP, 'pi-ws-')))
    void runtime.prompt('work')

    vi.useFakeTimers()
    try {
      const disposing = runtime.dispose()
      await Promise.resolve() // let the queued teardown register its timeout timer
      await vi.advanceTimersByTimeAsync(4000)
      await disposing // must not hang: the timeout forces abort and gives up
      expect(session.order).toEqual(['clearQueue', 'abort', 'dispose'])
      expect(session.disposed).toBe(true)
      expect(runtime.snapshot().error?.message).toBe('Run cleanup timed out')
      expect(runtime.snapshot().error?.recoverable).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('completes abort and dispose when the SDK abort itself never settles', async () => {
    const session = new FakeSession()
    session.abortImpl = () => new Promise(() => {}) // abort never settles
    mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined })
    const runtime = new PiRuntime({ cleanupTimeoutMs: 1000 })
    runtime.setWindow(new FakeWindow() as unknown as BrowserWindow)
    await runtime.initialize(mkdtempSync(join(TMP, 'pi-ws-')))

    vi.useFakeTimers()
    try {
      const aborted = runtime.abort()
      await Promise.resolve() // let the queued teardown register its timeout timer
      await vi.advanceTimersByTimeAsync(4000)
      await aborted // the wedged abort is bounded: abort() settles and releases the closing mark

      const disposing = runtime.dispose()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(4000)
      await disposing // exit can never hang on a wedged abort
      expect(session.disposed).toBe(true)
      expect(session.order).toEqual(['clearQueue', 'abort', 'clearQueue', 'abort', 'dispose'])
      expect(runtime.snapshot().error?.message).toBe('Run cleanup timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a prompt in the same tick as abort() and resumes chatting after it settles', async () => {
    const session = new FakeSession()
    const runtime = await initRuntime(undefined, session)

    const aborted = runtime.abort() // marks closing synchronously, before enqueue
    await runtime.prompt('during') // same-tick prompt must not reach the SDK
    expect(session.promptCalls).toHaveLength(0)
    expect(runtime.snapshot().error?.message).toBe('Session is closing')

    await aborted
    await runtime.prompt('after') // unmarked once the abort settles: chat resumes
    expect(session.promptCalls).toHaveLength(1)
    expect(runtime.snapshot().error).toBeNull()
  })

  it('keeps the session closing across overlapping aborts until both settle', async () => {
    const session = new FakeSession()
    const releases: Array<() => void> = []
    session.abortImpl = () => new Promise((resolve) => { releases.push(resolve) })
    const runtime = await initRuntime(undefined, session)

    const first = runtime.abort()
    const second = runtime.abort()
    await flush()
    await runtime.prompt('during-1')
    expect(session.promptCalls).toHaveLength(0)
    expect(runtime.snapshot().error?.message).toBe('Session is closing')

    releases[0]!() // first abort's SDK call settles: its finally must not unmark
    await first
    await flush()
    await runtime.prompt('during-2') // the second abort still holds the session closed
    expect(session.promptCalls).toHaveLength(0)
    expect(runtime.snapshot().error?.message).toBe('Session is closing')

    releases[1]!()
    await second
    await runtime.prompt('after') // both settled: chat resumes
    expect(session.promptCalls).toHaveLength(1)
    expect(runtime.snapshot().error).toBeNull()
  })

  it('refuses new prompts while the session is closing', async () => {
    const session = new FakeSession()
    let acceptPreflight!: () => void
    let resolveRun!: () => void
    session.promptImpl = (_text, options) => {
      acceptPreflight = () => preflightOf(options)?.(true)
      return new Promise<void>((resolve) => { resolveRun = resolve })
    }
    const runtime = await initRuntime(undefined, session)
    void runtime.prompt('first')

    const aborting = runtime.abort()
    await flush()
    await runtime.prompt('second') // closing: must not reach the SDK
    expect(session.promptCalls).toHaveLength(1)
    expect(runtime.snapshot().error?.message).toBe('Session is closing')

    acceptPreflight() // fires while closing: the run is refused, teardown proceeds
    await flush()
    expect(session.order).toEqual(['clearQueue', 'abort'])
    resolveRun()
    await aborting
    expect(runtime.snapshot().error?.message).toBe('Session is closing')
  })

  it('serializes abort with session mutations: a stale abort is a no-op and teardown runs once', async () => {
    const sessionA = new FakeSession()
    const sessionB = new FakeSession()
    mocks.createAgentSession.mockResolvedValue({ session: sessionB, modelFallbackMessage: undefined })
    const runtime = await initRuntime(undefined, sessionA)

    // Mutation enqueued first; abort captures session A while it is still active.
    const switching = runtime.newSession()
    const aborted = runtime.abort()
    await switching
    await aborted
    await flush()
    expect(sessionA.order).toEqual(['clearQueue', 'abort', 'dispose']) // no double abort/dispose
    expect(sessionB.order).toEqual([]) // the stale abort never touches the new session
    expect(sessionB.disposed).toBe(false)
    expect(runtime.snapshot().error).toBeNull()
  })

  it('disposes the candidate session when bindExtensions fails and never promotes it', async () => {
    const runtime = await initRuntime()
    const bad = new FakeSession()
    bad.bindExtensionsImpl = async () => { throw new Error('bind boom') }
    mocks.createAgentSession.mockResolvedValue({ session: bad, modelFallbackMessage: undefined })
    const snap = await runtime.newSession()
    expect(bad.disposed).toBe(true)
    expect(bad.order).toEqual(['clearQueue', 'abort', 'dispose'])
    expect(runtime.snapshot().activeSessionPath).toBeNull() // no unapproved session left behind
    expect(snap.error).toEqual({ message: 'Failed to create session', detail: 'bind boom', recoverable: true })
  })

  it('disposes the candidate session when subscribe fails', async () => {
    const runtime = await initRuntime()
    const bad = new FakeSession()
    bad.subscribeImpl = () => { throw new Error('subscribe boom') }
    mocks.createAgentSession.mockResolvedValue({ session: bad, modelFallbackMessage: undefined })
    const snap = await runtime.newSession()
    expect(bad.disposed).toBe(true)
    expect(bad.order).toEqual(['clearQueue', 'abort', 'dispose'])
    expect(snap.error?.detail).toContain('subscribe boom')
    expect(runtime.snapshot().activeSessionPath).toBeNull()
  })

  it('serializes a pending abort ahead of a mutation and records its failure while the session is current', async () => {
    const sessionA = new FakeSession()
    const runtime = await initRuntime(undefined, sessionA)
    let rejectAbort!: (reason: Error) => void
    let abortCalls = 0
    sessionA.abortImpl = () => {
      abortCalls += 1
      if (abortCalls === 1) return new Promise((_resolve, reject) => { rejectAbort = reject })
      return Promise.resolve()
    }
    const pendingAbort = runtime.abort()
    await flush()
    const sessionB = new FakeSession()
    mocks.createAgentSession.mockResolvedValue({ session: sessionB, modelFallbackMessage: undefined })
    // The mutation is queued behind the pending abort: it must wait for it.
    const switching = runtime.newSession()
    await flush()
    expect(sessionA.disposed).toBe(false) // abort holds the queue until it settles

    rejectAbort(new Error('late abort failure'))
    await pendingAbort
    // The failure landed while sessionA was still current, so it is recorded.
    expect(runtime.snapshot().error).toEqual({ message: 'Abort failed', detail: 'late abort failure', recoverable: true })
    await switching
    await flush()
    expect(sessionA.disposed).toBe(true)
    expect(sessionA.order).toEqual(['clearQueue', 'abort', 'clearQueue', 'abort', 'dispose'])
    expect(runtime.snapshot().activeSessionPath).toBe(sessionB.sessionFile)
  })

  it('records abort failures', async () => {
    const session = new FakeSession()
    const runtime = await initRuntime(undefined, session)
    session.abortImpl = async () => { throw new Error('abort boom') }
    await runtime.abort()
    expect(runtime.snapshot().error).toEqual({ message: 'Abort failed', detail: 'abort boom', recoverable: true })
  })
})

describe('dispose and workspace switching', () => {
  it('dispose clears the queue, aborts, disposes, and resets transient state', async () => {
    const session = new FakeSession()
    const runtime = await initRuntime(undefined, session)
    priv(runtime).handleEvent({ type: 'queue_update', steering: ['a'], followUp: ['b'] } as unknown as AgentSessionEvent)
    priv(runtime).handleEvent({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } } as unknown as AgentSessionEvent)
    expect(runtime.snapshot().queueCount).toBe(2)

    runtime.dispose()
    await flush()
    expect(session.order).toEqual(['clearQueue', 'abort', 'dispose'])
    expect(session.disposed).toBe(true)
    const snap = runtime.snapshot()
    expect(snap.queueCount).toBe(0)
    expect(snap.activeSessionPath).toBeNull()
    expect(priv(runtime).liveTools.size).toBe(0)
  })

  it('switching workspace disposes the previous session', async () => {
    const sessionA = new FakeSession()
    const runtime = await initRuntime(undefined, sessionA)
    const sessionB = new FakeSession()
    mocks.createAgentSession.mockResolvedValue({ session: sessionB, modelFallbackMessage: undefined })
    const wsB = mkdtempSync(join(TMP, 'pi-wsB-'))
    const snap = await runtime.openWorkspace(wsB)
    expect(sessionA.disposed).toBe(true)
    expect(sessionA.order).toEqual(['clearQueue', 'abort', 'dispose'])
    expect(snap.workspace?.path).toBe(wsB)
    expect(snap.error).toBeNull()
  })
})

describe('handleEvent', () => {
  it('surfaces provider errors from empty assistant messages', async () => {
    const session = new FakeSession()
    session.messages = [{
      role: 'assistant', timestamp: 1000, stopReason: 'error', content: [],
      errorMessage: '400: provider rejected the developer role',
    }]
    const runtime = await initRuntime(undefined, session)

    expect(runtime.snapshot().messages[0]?.blocks).toEqual([
      { type: 'text', text: '400: provider rejected the developer role' },
    ])
  })

  it('accumulates tool state across start/update/end and surfaces edit patches in the snapshot', async () => {
    const session = new FakeSession()
    session.messages = [{
      role: 'assistant', timestamp: 1000, stopReason: 'done',
      content: [{ type: 'toolCall', id: 'call-1', name: 'edit', arguments: { file: 'a.txt' } }],
    }]
    const runtime = await initRuntime(undefined, session)
    const p = priv(runtime)

    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'edit', args: { file: 'a.txt' } } as unknown as AgentSessionEvent)
    expect(p.liveTools.get('call-1')).toMatchObject({ status: 'running', input: expect.stringContaining('a.txt') })

    p.handleEvent({ type: 'tool_execution_update', toolCallId: 'call-1', partialResult: 'partial diff' } as unknown as AgentSessionEvent)
    expect(p.liveTools.get('call-1')).toMatchObject({ status: 'running', output: 'partial diff' })

    p.handleEvent({
      type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'edit', isError: false,
      result: { details: { patch: 'PATCH123' }, summary: 'ok' },
    } as unknown as AgentSessionEvent)
    const live = p.liveTools.get('call-1')!
    expect(live.status).toBe('success')
    expect(live.patch).toBe('PATCH123')
    expect(live.output).toContain('summary')
    expect(live.input).toContain('a.txt') // start input is preserved

    const block = runtime.snapshot().messages[0]!.blocks[0]!
    expect(block).toMatchObject({ type: 'tool', status: 'success', patch: 'PATCH123' })

    // Error results map to an error status.
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'bash', args: { command: 'x' } } as unknown as AgentSessionEvent)
    p.handleEvent({ type: 'tool_execution_end', toolCallId: 'call-2', toolName: 'bash', isError: true, result: 'boom' } as unknown as AgentSessionEvent)
    expect(p.liveTools.get('call-2')).toMatchObject({ status: 'error', output: 'boom' })
  })

  it('captures agent_settled refresh rejection as a recoverable error without an unhandled rejection', async () => {
    const runtime = await initRuntime()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      mocks.SessionManager.listAll.mockRejectedValueOnce(new Error('list boom'))
      priv(runtime).handleEvent({ type: 'agent_settled' } as unknown as AgentSessionEvent)
      await flush()
      const snap = runtime.snapshot()
      expect(snap.runState).toBe('error')
      expect(snap.error).toEqual({ message: 'Failed to refresh sessions', detail: 'list boom', recoverable: true })
      await flush()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('persistent tool-result merging', () => {
  const result = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', isError: false,
    content: [{ type: 'text', text: 'ok' }], timestamp: 300, ...overrides,
  })

  it('merges historical toolResults into the assistant card: exactly one card per toolCallId, in call order', async () => {
    const session = new FakeSession()
    session.messages = [
      { role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: 100 },
      {
        role: 'assistant', timestamp: 200, stopReason: 'done',
        content: [
          { type: 'toolCall', id: 'call-1', name: 'edit', arguments: { file: 'a.txt' } },
          { type: 'toolCall', id: 'call-2', name: 'bash', arguments: { command: 'ls' } },
        ],
      },
      result({ toolCallId: 'call-1', toolName: 'edit', content: [{ type: 'text', text: 'patched ok' }], details: { patch: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y' } }),
      result({ toolCallId: 'call-2', isError: true, content: [{ type: 'text', text: 'command failed' }] }),
    ]
    const runtime = await initRuntime(undefined, session)
    const snap = runtime.snapshot()
    // Exactly two chat messages (user + assistant); no separate tool cards.
    expect(snap.messages).toHaveLength(2)
    expect(snap.messages.map((message) => message.id)).toEqual(['user-0-100', 'assistant-0-200'])
    const blocks = snap.messages[1]!.blocks
    expect(blocks).toHaveLength(2) // call order is stable
    expect(blocks[0]).toEqual({
      type: 'tool', id: 'call-1', name: 'edit', status: 'success',
      input: expect.stringContaining('a.txt'),
      output: 'patched ok',
      patch: expect.stringContaining('diff --git a/a.txt'),
      details: expect.objectContaining({ patch: expect.stringContaining('diff --git a/a.txt') }),
    })
    expect(blocks[1]).toMatchObject({ type: 'tool', id: 'call-2', name: 'bash', status: 'error', output: 'command failed' })
    const toolBlocks = snap.messages.flatMap((message) => message.blocks).filter((block) => block.type === 'tool')
    expect(toolBlocks).toHaveLength(2)
    expect(new Set(toolBlocks.map((block) => block.id)).size).toBe(2)
  })

  it('restores details.diff as the patch when details.patch is absent', async () => {
    const session = new FakeSession()
    session.messages = [
      { role: 'assistant', timestamp: 200, stopReason: 'done', content: [{ type: 'toolCall', id: 'call-1', name: 'edit', arguments: { file: 'a.txt' } }] },
      result({ toolName: 'edit', content: [{ type: 'text', text: 'diffed' }], details: { diff: '--- a/a.txt\n+++ b/a.txt' } }),
    ]
    const runtime = await initRuntime(undefined, session)
    const block = runtime.snapshot().messages[0]!.blocks[0] as ToolBlock
    expect(block.patch).toContain('+++ b/a.txt')
  })

  it('keeps an orphan toolResult (no matching assistant toolCall) as its own full card', async () => {
    const session = new FakeSession()
    session.messages = [
      { role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: 100 },
      result({ toolCallId: 'call-x', toolName: 'edit', isError: true, content: [{ type: 'text', text: 'boom' }], details: { patch: '--- a/x\n+++ b/x' } }),
    ]
    const runtime = await initRuntime(undefined, session)
    const snap = runtime.snapshot()
    expect(snap.messages).toHaveLength(2)
    expect(snap.messages[1]).toMatchObject({ id: 'tool-call-x', role: 'tool', blocks: [{ type: 'tool', id: 'call-x', name: 'edit', status: 'error', output: 'boom', patch: '--- a/x\n+++ b/x' }] })
  })

  it('marks historical toolCalls without any result as interrupted, never pending', async () => {
    const session = new FakeSession()
    session.messages = [
      { role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: 100 },
      { role: 'assistant', timestamp: 200, stopReason: 'done', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } }] },
    ]
    const runtime = await initRuntime(undefined, session)
    const snap = runtime.snapshot()
    expect(snap.runState).toBe('idle')
    expect((runtime as unknown as { liveAssistant: unknown }).liveAssistant).toBeNull()
    const block = snap.messages[1]!.blocks[0] as ToolBlock
    expect(block.status).toBe('interrupted')
    expect(block.input).toContain('ls')
  })

  it('keeps a no-result toolCall pending while it belongs to the current live turn', async () => {
    const session = new FakeSession()
    mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined })
    const runtime = new PiRuntime()
    runtime.setWindow(new FakeWindow() as unknown as BrowserWindow)
    await runtime.initialize(mkdtempSync(join(TMP, 'pi-ws-')))
    const T = 1700000000000
    const partial = {
      role: 'assistant', timestamp: T, stopReason: 'pending',
      content: [{ type: 'toolCall', id: 'call-9', name: 'bash', arguments: { command: 'ls' } }],
    }
    session.messages.push(partial)
    priv(runtime).handleEvent({ type: 'message_start', message: { ...partial } } as unknown as AgentSessionEvent)
    let block = runtime.snapshot().messages[0]!.blocks[0] as ToolBlock
    expect(block.status).toBe('pending')
    expect(block.input).toContain('ls')
    // Once the turn settles without any result, the same call becomes interrupted.
    const final = { role: 'assistant', timestamp: T, stopReason: 'done', content: partial.content }
    session.messages = [final]
    priv(runtime).handleEvent({ type: 'agent_settled' } as unknown as AgentSessionEvent)
    block = runtime.snapshot().messages[0]!.blocks[0] as ToolBlock
    expect(block.status).toBe('interrupted')
  })

  it('lets live tool state override the persisted result for the same toolCallId', async () => {
    const session = new FakeSession()
    session.messages = [
      { role: 'assistant', timestamp: 200, stopReason: 'done', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } }] },
      result({ content: [{ type: 'text', text: 'old result' }] }),
    ]
    const runtime = await initRuntime(undefined, session)
    const p = priv(runtime)
    let block = runtime.snapshot().messages[0]!.blocks[0] as ToolBlock
    expect(block).toMatchObject({ status: 'success', output: 'old result' })
    // A live run on the same id supersedes the persisted card.
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'x' } } as unknown as AgentSessionEvent)
    block = runtime.snapshot().messages[0]!.blocks[0] as ToolBlock
    expect(block.status).toBe('running')
    expect(block.output).toBeUndefined()
    p.handleEvent({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', isError: true, result: 'live failure' } as unknown as AgentSessionEvent)
    block = runtime.snapshot().messages[0]!.blocks[0] as ToolBlock
    expect(block.status).toBe('error')
    expect(block.output).toContain('live failure')
    expect(block.output).not.toContain('old result')
  })

  it('keeps toolResult usage out of the LLM usage totals', async () => {
    const session = new FakeSession()
    session.messages = [
      { role: 'assistant', timestamp: 200, stopReason: 'done', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }], usage: { input: 500, output: 300, cacheRead: 0, cost: { total: 0.01 } } },
      result({ usage: { input: 9000, output: 12000, cacheRead: 0, cost: { total: 0.5 } } }),
    ]
    const runtime = await initRuntime(undefined, session)
    expect(runtime.snapshot().usage).toEqual({ input: 500, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.01 })
  })
})

describe('reused toolCall ids across turns and live convergence', () => {
  const result = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', isError: false,
    content: [{ type: 'text', text: 'ok' }], timestamp: 300, ...overrides,
  })
  const toolBlocks = (snap: ReturnType<PiRuntime['snapshot']>): ToolBlock[] =>
    snap.messages.flatMap((message) => message.blocks).filter((block): block is ToolBlock => block.type === 'tool')

  it('clears live tool state at agent_settled and abort; resultless calls become interrupted', async () => {
    const session = new FakeSession()
    session.messages = [{ role: 'assistant', timestamp: 200, stopReason: 'done', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } }] }]
    const runtime = await initRuntime(undefined, session)
    const p = priv(runtime)
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls' } } as unknown as AgentSessionEvent)
    expect(runtime.snapshot().messages[0]!.blocks[0]).toMatchObject({ type: 'tool', status: 'running' })
    // Settled: live cache AND live tool state are gone; the snapshot rebuilds
    // purely from persisted state — no result here, so the call is interrupted.
    p.handleEvent({ type: 'agent_settled' } as unknown as AgentSessionEvent)
    expect(p.liveTools.size).toBe(0)
    expect(runtime.snapshot().messages[0]!.blocks[0]).toMatchObject({ type: 'tool', status: 'interrupted' })

    // A new live run starts fresh: abort also clears live tool state so a
    // later turn can never inherit it.
    const T = 1700000000000
    const partial = { role: 'assistant', timestamp: T, stopReason: 'pending', content: [{ type: 'toolCall', id: 'call-2', name: 'bash', arguments: { command: 'x' } }] }
    session.messages.push(partial)
    p.handleEvent({ type: 'message_start', message: { ...partial } } as unknown as AgentSessionEvent)
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'bash', args: { command: 'x' } } as unknown as AgentSessionEvent)
    expect(runtime.snapshot().messages[1]!.blocks[0]).toMatchObject({ type: 'tool', status: 'running' })
    await runtime.abort()
    expect(p.liveTools.size).toBe(0)
    expect((runtime as unknown as { liveAssistant: unknown }).liveAssistant).toBeNull()
    expect(runtime.snapshot().messages[1]!.blocks[0]).toMatchObject({ type: 'tool', status: 'interrupted' })
  })

  it('keeps two turns reusing the same raw id fully separate: unique card ids, outputs never cross', async () => {
    const session = new FakeSession()
    session.messages = [
      { role: 'assistant', timestamp: 200, stopReason: 'done', content: [{ type: 'toolCall', id: 'call-1', name: 'edit', arguments: { file: 'a' } }] },
      result({ toolName: 'edit', isError: true, content: [{ type: 'text', text: 'first failed' }] }),
      { role: 'assistant', timestamp: 400, stopReason: 'done', content: [{ type: 'toolCall', id: 'call-1', name: 'edit', arguments: { file: 'a' } }] },
      result({ toolName: 'edit', isError: false, content: [{ type: 'text', text: 'second fixed' }] }),
    ]
    const runtime = await initRuntime(undefined, session)
    const blocks = toolBlocks(runtime.snapshot())
    expect(blocks).toHaveLength(2)
    expect(blocks.map((block) => block.id)).toEqual(['call-1', 'call-1::1-0'])
    expect(blocks[0]).toMatchObject({ status: 'error', output: 'first failed' })
    expect(blocks[1]).toMatchObject({ status: 'success', output: 'second fixed' })
    expect(blocks[0]!.output).not.toContain('second')
    expect(blocks[1]!.output).not.toContain('first')
    expect(new Set(blocks.map((block) => block.id)).size).toBe(2)
  })

  it('pairs the second result with the second call: first interrupted, second success', async () => {
    const session = new FakeSession()
    session.messages = [
      { role: 'assistant', timestamp: 200, stopReason: 'done', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }] },
      { role: 'assistant', timestamp: 400, stopReason: 'done', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }] },
      result({ content: [{ type: 'text', text: 'only second ran' }] }),
    ]
    const runtime = await initRuntime(undefined, session)
    const blocks = toolBlocks(runtime.snapshot())
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ id: 'call-1', status: 'interrupted' })
    expect(blocks[1]).toMatchObject({ id: 'call-1::1-0', status: 'success', output: 'only second ran' })
  })

  it('pairs repeated same-turn raw ids FIFO by content order, never LIFO', async () => {
    const session = new FakeSession()
    session.messages = [
      {
        role: 'assistant', timestamp: 200, stopReason: 'done',
        content: [
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'a' } },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'b' } },
        ],
      },
      result({ content: [{ type: 'text', text: 'first result' }] }),
      result({ content: [{ type: 'text', text: 'second result' }] }),
    ]
    const runtime = await initRuntime(undefined, session)
    const blocks = toolBlocks(runtime.snapshot())
    expect(blocks).toHaveLength(2)
    // Source-order pairing: the first result belongs to the first call, never crossed.
    expect(blocks[0]).toMatchObject({ output: 'first result', input: expect.stringContaining('a') })
    expect(blocks[1]).toMatchObject({ output: 'second result', input: expect.stringContaining('b') })
    expect(blocks[0]!.output).not.toContain('second')
    expect(blocks[1]!.output).not.toContain('first')
    expect(new Set(blocks.map((block) => block.id)).size).toBe(2)
  })

  it('clears the previous turn live tools at a new assistant message_start: reused raw id shows pending, old card rebuilds from its persisted result', async () => {
    const session = new FakeSession()
    session.messages = [
      { role: 'assistant', timestamp: 200, stopReason: 'done', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'old' } }] },
      result({ content: [{ type: 'text', text: 'old result' }] }),
    ]
    const runtime = await initRuntime(undefined, session)
    const p = priv(runtime)
    // The old turn completes live with a DIFFERENT output than the persisted one.
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'old' } } as unknown as AgentSessionEvent)
    p.handleEvent({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', isError: false, result: 'old live ok' } as unknown as AgentSessionEvent)
    expect(toolBlocks(runtime.snapshot())[0]).toMatchObject({ status: 'success', output: 'old live ok' })

    // A new assistant turn starts with the same raw id: message_start must
    // drop the previous turn's live tools BEFORE the new tool_execution_start.
    const T = 1700000000000
    const partial = { role: 'assistant', timestamp: T, stopReason: 'pending', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'new' } }] }
    session.messages.push(partial)
    p.handleEvent({ type: 'message_start', message: { ...partial } } as unknown as AgentSessionEvent)
    let blocks = toolBlocks(runtime.snapshot())
    // The old card rebuilds from its persisted toolResult; the new live call
    // is pending until its own start — the old live success never leaks across.
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ id: 'call-1', status: 'success', output: 'old result' })
    expect(blocks[0]!.output).not.toContain('old live ok')
    expect(blocks[1]).toMatchObject({ id: 'call-1::1-0', status: 'pending' })
    expect(blocks[1]!.output).toBeUndefined()

    // The new turn's own start takes over: running with the new input only.
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'new' } } as unknown as AgentSessionEvent)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks[1]).toMatchObject({ id: 'call-1::1-0', status: 'running', input: expect.stringContaining('new') })
    expect(blocks[1]!.output).toBeUndefined()
  })

  it('keeps two same-id orphan toolResults as separate cards with unique ids', async () => {
    const session = new FakeSession()
    session.messages = [
      result({ toolCallId: 'call-x', isError: true, content: [{ type: 'text', text: 'orphan one' }] }),
      result({ toolCallId: 'call-x', content: [{ type: 'text', text: 'orphan two' }] }),
    ]
    const runtime = await initRuntime(undefined, session)
    const snap = runtime.snapshot()
    expect(snap.messages).toHaveLength(2)
    expect(snap.messages.map((message) => message.id)).toEqual(['tool-call-x', 'tool-orphan-1-call-x'])
    const blocks = toolBlocks(snap)
    expect(blocks.map((block) => block.id)).toEqual(['call-x', 'orphan-1-call-x'])
    expect(blocks[0]).toMatchObject({ output: 'orphan one', status: 'error' })
    expect(blocks[1]).toMatchObject({ output: 'orphan two', status: 'success' })
  })

  it('live tool state overrides only the current live-turn occurrence, never reused history; diff fallback restores', async () => {
    const session = new FakeSession()
    session.messages = [
      { role: 'assistant', timestamp: 200, stopReason: 'done', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'old' } }] },
      result({ content: [{ type: 'text', text: 'old result' }] }),
    ]
    const runtime = await initRuntime(undefined, session)
    const T = 1700000000000
    const p = priv(runtime)
    const partial = { role: 'assistant', timestamp: T, stopReason: 'pending', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'new' } }] }
    session.messages.push(partial)
    p.handleEvent({ type: 'message_start', message: { ...partial } } as unknown as AgentSessionEvent)
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'new' } } as unknown as AgentSessionEvent)
    let blocks = toolBlocks(runtime.snapshot())
    expect(blocks).toHaveLength(2)
    // Historical reuse keeps its persisted result; only the live ordinal is running.
    expect(blocks[0]).toMatchObject({ id: 'call-1', status: 'success', output: 'old result' })
    expect(blocks[1]).toMatchObject({ id: 'call-1::1-0', status: 'running' })
    expect(blocks[1]!.output).toBeUndefined()
    // tool_execution_end with only details.diff: the patch restores from the fallback.
    p.handleEvent({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', isError: false, result: { details: { diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b' }, summary: 'live done' } } as unknown as AgentSessionEvent)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ status: 'success', output: 'old result' }) // history untouched
    expect(blocks[1]).toMatchObject({ id: 'call-1::1-0', status: 'success', output: expect.stringContaining('live done'), patch: expect.stringContaining('+++ b/x') })
    // Settled: live cleared, persisted state rules again — the second call has
    // no persisted result, so it is interrupted.
    p.handleEvent({ type: 'agent_settled' } as unknown as AgentSessionEvent)
    expect(p.liveTools.size).toBe(0)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ id: 'call-1', status: 'success', output: 'old result' })
    expect(blocks[1]).toMatchObject({ id: 'call-1::1-0', status: 'interrupted' })
  })

  it('keeps two same-rawId calls in one assistant on separate live cards: FIFO start/update/end, patch/diff never cross', async () => {
    const session = new FakeSession()
    const runtime = await initRuntime(undefined, session)
    const p = priv(runtime)
    const T = 1700000000000
    const partial = {
      role: 'assistant', timestamp: T, stopReason: 'pending',
      content: [
        { type: 'toolCall', id: 'call-1', name: 'edit', arguments: { file: 'a.txt' } },
        { type: 'toolCall', id: 'call-1', name: 'edit', arguments: { file: 'b.txt' } },
      ],
    }
    session.messages.push(partial)
    p.handleEvent({ type: 'message_start', message: { ...partial } } as unknown as AgentSessionEvent)

    // Both occurrences are pending until their own start.
    let blocks = toolBlocks(runtime.snapshot())
    expect(blocks).toHaveLength(2)
    expect(blocks.map((block) => block.id)).toEqual(['call-1', 'call-1::0-1'])
    expect(blocks.map((block) => block.status)).toEqual(['pending', 'pending'])

    // The first start claims the FIRST occurrence only; the second stays pending.
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'edit', args: { file: 'a.txt' } } as unknown as AgentSessionEvent)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ id: 'call-1', status: 'running', input: expect.stringContaining('a.txt') })
    expect(blocks[1]).toMatchObject({ id: 'call-1::0-1', status: 'pending' })

    // The second start claims the second occurrence; the first card is untouched.
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'edit', args: { file: 'b.txt' } } as unknown as AgentSessionEvent)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ id: 'call-1', status: 'running', input: expect.stringContaining('a.txt') })
    expect(blocks[0]!.output).toBeUndefined()
    expect(blocks[1]).toMatchObject({ id: 'call-1::0-1', status: 'running', input: expect.stringContaining('b.txt') })
    expect(blocks[1]!.output).toBeUndefined()

    // The first update touches only the first card.
    p.handleEvent({ type: 'tool_execution_update', toolCallId: 'call-1', partialResult: 'first partial' } as unknown as AgentSessionEvent)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ status: 'running', output: 'first partial' })
    expect(blocks[1]).toMatchObject({ status: 'running' })
    expect(blocks[1]!.output).toBeUndefined()

    // The first end completes only the first card; the second keeps running.
    p.handleEvent({
      type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'edit', isError: false,
      result: { details: { patch: 'PATCH-ONE' }, summary: 'first done' },
    } as unknown as AgentSessionEvent)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ status: 'success', output: expect.stringContaining('first done'), patch: 'PATCH-ONE' })
    expect(blocks[1]).toMatchObject({ status: 'running' })
    expect(blocks[1]!.patch).toBeUndefined()

    // The second update touches only the second card.
    p.handleEvent({ type: 'tool_execution_update', toolCallId: 'call-1', partialResult: 'second partial' } as unknown as AgentSessionEvent)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ status: 'success', output: expect.stringContaining('first done') })
    expect(blocks[1]).toMatchObject({ status: 'running', output: 'second partial' })

    // The second end completes only the second card; patch/diff never cross.
    p.handleEvent({
      type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'edit', isError: false,
      result: { details: { diff: '--- a/b.txt\n+++ b/b.txt' }, summary: 'second done' },
    } as unknown as AgentSessionEvent)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ status: 'success', output: expect.stringContaining('first done'), patch: 'PATCH-ONE' })
    expect(blocks[1]).toMatchObject({ status: 'success', output: expect.stringContaining('second done'), patch: expect.stringContaining('+++ b/b.txt') })
    expect(blocks[0]!.patch).not.toContain('+++ b/b.txt')
    expect(blocks[1]!.patch).not.toContain('PATCH-ONE')
    expect(blocks[0]!.output).not.toContain('second')
    expect(blocks[1]!.output).not.toContain('first')
  })

  it('ends two parallel same-rawId starts FIFO: each end completes exactly its own card', async () => {
    const session = new FakeSession()
    const runtime = await initRuntime(undefined, session)
    const p = priv(runtime)
    const T = 1700000000000
    const partial = {
      role: 'assistant', timestamp: T, stopReason: 'pending',
      content: [
        { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'a' } },
        { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'b' } },
      ],
    }
    session.messages.push(partial)
    p.handleEvent({ type: 'message_start', message: { ...partial } } as unknown as AgentSessionEvent)
    // Both starts land before any end: both cards running.
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'a' } } as unknown as AgentSessionEvent)
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'b' } } as unknown as AgentSessionEvent)
    let blocks = toolBlocks(runtime.snapshot())
    expect(blocks.map((block) => block.status)).toEqual(['running', 'running'])

    // The first end FIFO-completes the first card; the second stays running.
    p.handleEvent({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', isError: false, result: 'first out' } as unknown as AgentSessionEvent)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ id: 'call-1', status: 'success', output: expect.stringContaining('first out') })
    expect(blocks[1]).toMatchObject({ id: 'call-1::0-1', status: 'running' })

    // The second end completes the second card; outputs never cross.
    p.handleEvent({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', isError: true, result: 'second boom' } as unknown as AgentSessionEvent)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ id: 'call-1', status: 'success', output: expect.stringContaining('first out') })
    expect(blocks[1]).toMatchObject({ id: 'call-1::0-1', status: 'error', output: expect.stringContaining('second boom') })
    expect(blocks[0]!.output).not.toContain('second')
    expect(blocks[1]!.output).not.toContain('first')
  })

  it('routes an update that arrives before any start to the first occurrence and lets the following start claim the second', async () => {
    const session = new FakeSession()
    const runtime = await initRuntime(undefined, session)
    const p = priv(runtime)
    const T = 1700000000000
    const partial = {
      role: 'assistant', timestamp: T, stopReason: 'pending',
      content: [
        { type: 'toolCall', id: 'call-1', name: 'edit', arguments: { file: 'a.txt' } },
        { type: 'toolCall', id: 'call-1', name: 'edit', arguments: { file: 'b.txt' } },
      ],
    }
    session.messages.push(partial)
    p.handleEvent({ type: 'message_start', message: { ...partial } } as unknown as AgentSessionEvent)

    // The update arrives before ANY start: it must not be dropped. It claims
    // the first occurrence, creating its running card with the partial.
    p.handleEvent({ type: 'tool_execution_update', toolCallId: 'call-1', partialResult: 'early partial' } as unknown as AgentSessionEvent)
    let blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ id: 'call-1', status: 'running', output: 'early partial' })
    expect(blocks[1]).toMatchObject({ id: 'call-1::0-1', status: 'pending' })

    // The following start claims the SECOND occurrence; the first card keeps
    // its partial and is never overwritten.
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'edit', args: { file: 'b.txt' } } as unknown as AgentSessionEvent)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ id: 'call-1', status: 'running', output: 'early partial' })
    expect(blocks[1]).toMatchObject({ id: 'call-1::0-1', status: 'running', input: expect.stringContaining('b.txt') })

    // The end completes the earliest running card (the first one); its patch
    // and final output land there and never cross to the sibling.
    p.handleEvent({
      type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'edit', isError: false,
      result: { details: { patch: 'PATCH-EARLY' }, summary: 'first done' },
    } as unknown as AgentSessionEvent)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ status: 'success', output: expect.stringContaining('first done'), patch: 'PATCH-EARLY' })
    expect(blocks[1]).toMatchObject({ status: 'running' })
    expect(blocks[1]!.output).toBeUndefined()
  })

  it('routes an end that arrives before any start to the first occurrence and lets the following start claim only the second', async () => {
    const session = new FakeSession()
    const runtime = await initRuntime(undefined, session)
    const p = priv(runtime)
    const T = 1700000000000
    const partial = {
      role: 'assistant', timestamp: T, stopReason: 'pending',
      content: [
        { type: 'toolCall', id: 'call-1', name: 'edit', arguments: { file: 'a.txt' } },
        { type: 'toolCall', id: 'call-1', name: 'edit', arguments: { file: 'b.txt' } },
      ],
    }
    session.messages.push(partial)
    p.handleEvent({ type: 'message_start', message: { ...partial } } as unknown as AgentSessionEvent)

    // The end arrives before ANY start: it completes the first occurrence
    // (creating its card) and marks it consumed.
    p.handleEvent({
      type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'edit', isError: false,
      result: { details: { patch: 'PATCH-END' }, summary: 'first done' },
    } as unknown as AgentSessionEvent)
    let blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ id: 'call-1', status: 'success', output: expect.stringContaining('first done'), patch: 'PATCH-END' })
    expect(blocks[1]).toMatchObject({ id: 'call-1::0-1', status: 'pending' })

    // The following start claims ONLY the second occurrence — the completed
    // first card is never overwritten.
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'edit', args: { file: 'b.txt' } } as unknown as AgentSessionEvent)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ id: 'call-1', status: 'success', output: expect.stringContaining('first done'), patch: 'PATCH-END' })
    expect(blocks[1]).toMatchObject({ id: 'call-1::0-1', status: 'running', input: expect.stringContaining('b.txt') })

    // The second end completes the second card; patch/output never cross.
    p.handleEvent({
      type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'edit', isError: false,
      result: { details: { patch: 'PATCH-TWO' }, summary: 'second done' },
    } as unknown as AgentSessionEvent)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ status: 'success', output: expect.stringContaining('first done'), patch: 'PATCH-END' })
    expect(blocks[1]).toMatchObject({ status: 'success', output: expect.stringContaining('second done'), patch: 'PATCH-TWO' })
  })

  it('preserves the final state of a unique id whose update and end arrive before its start', async () => {
    const session = new FakeSession()
    const runtime = await initRuntime(undefined, session)
    const p = priv(runtime)
    const T = 1700000000000
    const partial = {
      role: 'assistant', timestamp: T, stopReason: 'pending',
      content: [{ type: 'toolCall', id: 'call-1', name: 'edit', arguments: { file: 'a.txt' } }],
    }
    session.messages.push(partial)
    p.handleEvent({ type: 'message_start', message: { ...partial } } as unknown as AgentSessionEvent)

    // update-before-start creates the running card with the partial.
    p.handleEvent({ type: 'tool_execution_update', toolCallId: 'call-1', partialResult: 'early partial' } as unknown as AgentSessionEvent)
    let blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ id: 'call-1', status: 'running', output: 'early partial' })

    // end-before-start completes it; the final result (with patch) wins.
    p.handleEvent({
      type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'edit', isError: false,
      result: { details: { patch: 'PATCH-FINAL' }, summary: 'final done' },
    } as unknown as AgentSessionEvent)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks[0]).toMatchObject({ status: 'success', output: expect.stringContaining('final done'), patch: 'PATCH-FINAL' })

    // A late start and a late update are stale duplicates: dropped, the final
    // state (output + patch) is preserved.
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'edit', args: { file: 'a.txt' } } as unknown as AgentSessionEvent)
    p.handleEvent({ type: 'tool_execution_update', toolCallId: 'call-1', partialResult: 'stale' } as unknown as AgentSessionEvent)
    blocks = toolBlocks(runtime.snapshot())
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ status: 'success', output: expect.stringContaining('final done'), patch: 'PATCH-FINAL' })
  })

  it('clears live queues with the state at a new turn, agent_settled and abort', async () => {
    const session = new FakeSession()
    const runtime = await initRuntime(undefined, session)
    const p = priv(runtime)
    const T = 1700000000000
    const turn = (seq: number, id: string, command: string): Record<string, unknown> => ({
      role: 'assistant', timestamp: T + seq, stopReason: 'pending',
      content: [{ type: 'toolCall', id, name: 'bash', arguments: { command } }],
    })
    const first = turn(0, 'call-1', 'a')
    session.messages.push(first)
    p.handleEvent({ type: 'message_start', message: { ...first } } as unknown as AgentSessionEvent)
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'a' } } as unknown as AgentSessionEvent)
    expect(p.liveQueues.size).toBe(1)

    // A NEW turn (different ordinal) drops the previous turn's queues and state.
    const second = turn(1, 'call-2', 'b')
    session.messages.push(second)
    p.handleEvent({ type: 'message_start', message: { ...second } } as unknown as AgentSessionEvent)
    expect(p.liveQueues.size).toBe(0)
    expect(p.liveTools.size).toBe(0)

    // The new turn rebuilds a queue; agent_settled clears it again.
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'bash', args: { command: 'b' } } as unknown as AgentSessionEvent)
    expect(p.liveQueues.size).toBe(1)
    p.handleEvent({ type: 'agent_settled' } as unknown as AgentSessionEvent)
    expect(p.liveQueues.size).toBe(0)
    expect(p.liveTools.size).toBe(0)

    // And abort clears a freshly built queue together with the state.
    const third = turn(2, 'call-3', 'c')
    session.messages.push(third)
    p.handleEvent({ type: 'message_start', message: { ...third } } as unknown as AgentSessionEvent)
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-3', toolName: 'bash', args: { command: 'c' } } as unknown as AgentSessionEvent)
    expect(p.liveQueues.size).toBe(1)
    await runtime.abort()
    expect(p.liveQueues.size).toBe(0)
    expect(p.liveTools.size).toBe(0)
  })
})

describe('live assistant streaming', () => {
  const T = 1700000000000
  const textMsg = (text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    role: 'assistant', timestamp: T, stopReason: 'pending',
    content: [{ type: 'text', text }], ...overrides,
  })
  const startEvent = (message: unknown): AgentSessionEvent => ({ type: 'message_start', message } as unknown as AgentSessionEvent)
  const updateEvent = (message: unknown): AgentSessionEvent => ({ type: 'message_update', message } as unknown as AgentSessionEvent)
  const endEvent = (message: unknown): AgentSessionEvent => ({ type: 'message_end', message } as unknown as AgentSessionEvent)

  async function initStreaming(): Promise<{ runtime: PiRuntime; session: FakeSession; window: FakeWindow }> {
    const session = new FakeSession()
    const window = new FakeWindow()
    mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined })
    const runtime = new PiRuntime()
    runtime.setWindow(window as unknown as BrowserWindow)
    await runtime.initialize(mkdtempSync(join(TMP, 'pi-ws-')))
    window.webContents.send.mockClear()
    return { runtime, session, window }
  }

  it('shows an empty streaming assistant immediately at message_start', async () => {
    const { runtime } = await initStreaming()
    priv(runtime).handleEvent(startEvent({ role: 'assistant', timestamp: T, stopReason: 'pending', content: [] }))
    const snap = runtime.snapshot()
    expect(snap.messages).toHaveLength(1)
    expect(snap.messages[0]).toMatchObject({ id: `assistant-0-${T}`, role: 'assistant', isStreaming: true, timestamp: T })
    expect(snap.messages[0]!.blocks).toEqual([])
  })

  it('shows only the latest accumulated partial after the trailing timer coalesces updates', async () => {
    const { runtime, window } = await initStreaming()
    vi.useFakeTimers()
    try {
      priv(runtime).handleEvent(startEvent(textMsg('H')))
      priv(runtime).handleEvent(updateEvent(textMsg('He')))
      priv(runtime).handleEvent(updateEvent(textMsg('Hello')))
      expect(window.webContents.send).toHaveBeenCalledTimes(1) // only the start flush so far
      await vi.advanceTimersByTimeAsync(50)
      expect(window.webContents.send).toHaveBeenCalledTimes(2)
      const snap = runtime.snapshot()
      expect(snap.messages).toHaveLength(1)
      expect(snap.messages[0]).toMatchObject({ id: `assistant-0-${T}`, isStreaming: true })
      expect(snap.messages[0]!.blocks).toEqual([{ type: 'text', text: 'Hello' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces 100 deltas into a single trailing IPC send', async () => {
    const { runtime, window } = await initStreaming()
    vi.useFakeTimers()
    try {
      priv(runtime).handleEvent(startEvent(textMsg('')))
      for (let i = 1; i <= 100; i += 1) priv(runtime).handleEvent(updateEvent(textMsg(`delta ${i}`)))
      expect(window.webContents.send).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(50)
      expect(window.webContents.send).toHaveBeenCalledTimes(2)
      expect(runtime.snapshot().messages[0]!.blocks).toEqual([{ type: 'text', text: 'delta 100' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces thinking and toolCall blocks in partials, resolving live tool state', async () => {
    const { runtime } = await initStreaming()
    // Real SDK order: message_start opens the turn, then tool events stream in.
    priv(runtime).handleEvent(startEvent({
      role: 'assistant', timestamp: T, stopReason: 'pending',
      content: [
        { type: 'thinking', text: 'let me think' },
        { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } },
      ],
    }))
    priv(runtime).handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls' } } as unknown as AgentSessionEvent)
    const blocks = runtime.snapshot().messages[0]!.blocks
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'thinking', text: 'let me think' })
    expect(blocks[1]).toMatchObject({ type: 'tool', id: 'call-1', name: 'bash', status: 'running' })
  })

  it('surfaces thinking parts emitted with the real SDK field name (thinking, not text)', async () => {
    const { runtime } = await initStreaming()
    // pi-ai ThinkingContent: { type: 'thinking', thinking: string }. The old
    // serializer read part.text and silently dropped these — regression guard.
    priv(runtime).handleEvent(startEvent({
      role: 'assistant', timestamp: T, stopReason: 'pending',
      content: [{ type: 'thinking', thinking: 'real reasoning text' }],
    }))
    const blocks = runtime.snapshot().messages[0]!.blocks
    expect(blocks).toEqual([{ type: 'thinking', text: 'real reasoning text' }])
  })

  it('adopts the message_end snapshot with the same id, single entry, not streaming', async () => {
    const { runtime } = await initStreaming()
    priv(runtime).handleEvent(startEvent(textMsg('H')))
    const partial = runtime.snapshot().messages[0]!
    expect(partial.isStreaming).toBe(true)
    priv(runtime).handleEvent(updateEvent(textMsg('Hello')))
    priv(runtime).handleEvent(endEvent(textMsg('Hello', { stopReason: 'done' })))
    const snap = runtime.snapshot()
    expect(snap.messages).toHaveLength(1)
    expect(snap.messages[0]!.id).toBe(partial.id)
    expect(snap.messages[0]!.id).toBe(`assistant-0-${T}`)
    expect(snap.messages[0]!.isStreaming).toBe(false)
    expect(snap.messages[0]!.blocks).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('never duplicates the final once session.messages holds it, and clears the cache at agent_settled', async () => {
    const { runtime, session } = await initStreaming()
    const final = textMsg('Hello', { stopReason: 'done' })
    priv(runtime).handleEvent(startEvent(textMsg('H')))
    priv(runtime).handleEvent(updateEvent(textMsg('Hello')))
    priv(runtime).handleEvent(endEvent(final))
    // The SDK appends the final message after the message_end listener returns.
    session.messages = [final]
    const mid = runtime.snapshot()
    expect(mid.messages).toHaveLength(1)
    expect(mid.messages[0]).toMatchObject({ id: `assistant-0-${T}`, isStreaming: false })
    priv(runtime).handleEvent({ type: 'agent_settled' } as unknown as AgentSessionEvent)
    const after = runtime.snapshot()
    expect(after.messages).toHaveLength(1)
    expect(after.messages[0]!.id).toBe(`assistant-0-${T}`)
    expect(after.messages[0]!.isStreaming).toBe(false)
    expect((runtime as unknown as { liveAssistant: unknown }).liveAssistant).toBeNull()
  })

  it('never suppresses a new live turn that shares a historical assistant timestamp', async () => {
    const { runtime, session } = await initStreaming()
    const old = textMsg('old answer', { stopReason: 'done' })
    session.messages = [
      { role: 'user', content: [{ type: 'text', text: 'q1' }], timestamp: T },
      old,
      { role: 'user', content: [{ type: 'text', text: 'q2' }], timestamp: T },
      { ...old, content: [{ type: 'text', text: 'old answer 2' }] },
    ]
    priv(runtime).handleEvent(startEvent(textMsg('H')))
    const ids = runtime.snapshot().messages.map((message) => message.id)
    expect(ids).toEqual([`user-0-${T}`, `assistant-0-${T}`, `user-2-${T}`, `assistant-1-${T}`, `assistant-2-${T}`])
    const live = runtime.snapshot().messages[4]!
    expect(live).toMatchObject({ id: `assistant-2-${T}`, isStreaming: true, blocks: [{ type: 'text', text: 'H' }] })
    expect(new Set(ids).size).toBe(ids.length) // no duplicate React keys
  })

  it('merges the final into the live stable id even when an older turn shares its timestamp', async () => {
    const { runtime, session } = await initStreaming()
    session.messages = [textMsg('old answer', { stopReason: 'done' })] // same timestamp T
    const final = textMsg('Hello', { stopReason: 'done' })
    priv(runtime).handleEvent(startEvent(textMsg('H')))
    const partial = runtime.snapshot().messages[1]!
    expect(partial.id).toBe(`assistant-1-${T}`) // the old turn never swallows the new live
    priv(runtime).handleEvent(updateEvent(textMsg('Hello')))
    priv(runtime).handleEvent(endEvent(final))
    session.messages = [textMsg('old answer', { stopReason: 'done' }), final]
    const snap = runtime.snapshot()
    expect(snap.messages).toHaveLength(2)
    expect(snap.messages[1]!.id).toBe(partial.id) // stable id survives partial → final
    expect(snap.messages[1]!.isStreaming).toBe(false)
  })

  it('assigns consecutive turns their own stable ids', async () => {
    const { runtime, session } = await initStreaming()
    const first = textMsg('first', { stopReason: 'done' })
    priv(runtime).handleEvent(startEvent(textMsg('f')))
    priv(runtime).handleEvent(endEvent(first))
    session.messages = [first] // SDK appended the first final
    priv(runtime).handleEvent(startEvent(textMsg('s')))
    expect(runtime.snapshot().messages.map((message) => message.id)).toEqual([`assistant-0-${T}`, `assistant-1-${T}`])
    expect(runtime.snapshot().messages[1]!).toMatchObject({ isStreaming: true, blocks: [{ type: 'text', text: 's' }] })
    const second = textMsg('second', { stopReason: 'done' })
    priv(runtime).handleEvent(updateEvent(textMsg('sec')))
    priv(runtime).handleEvent(endEvent(second))
    session.messages = [first, second]
    const settled = runtime.snapshot()
    expect(settled.messages.map((message) => message.id)).toEqual([`assistant-0-${T}`, `assistant-1-${T}`])
    expect(settled.messages[1]!.isStreaming).toBe(false)
  })

  it('locks a replacement live turn at its own message_start ordinal', async () => {
    const { runtime } = await initStreaming()
    priv(runtime).handleEvent(startEvent(textMsg('first')))
    priv(runtime).handleEvent(startEvent(textMsg('second'))) // newer turn replaces the cached live
    const snap = runtime.snapshot()
    expect(snap.messages).toHaveLength(1)
    expect(snap.messages[0]).toMatchObject({ id: `assistant-0-${T}`, isStreaming: true, blocks: [{ type: 'text', text: 'second' }] })
  })

  it('abort clears the live state and pending timer; stale updates are ignored', async () => {
    const { runtime, window } = await initStreaming()
    vi.useFakeTimers()
    try {
      priv(runtime).handleEvent(startEvent(textMsg('H')))
      priv(runtime).handleEvent(updateEvent(textMsg('He'))) // trailing flush pending
      const aborted = runtime.abort()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(100)
      await aborted
      expect((runtime as unknown as { liveAssistant: unknown }).liveAssistant).toBeNull()
      expect((runtime as unknown as { liveFlushTimer: unknown }).liveFlushTimer).toBeNull()
      const count = window.webContents.send.mock.calls.length
      await vi.advanceTimersByTimeAsync(100)
      expect(window.webContents.send.mock.calls.length).toBe(count) // old timer never emits
      priv(runtime).handleEvent(updateEvent(textMsg('polluted'))) // stale events ignored
      expect(runtime.snapshot().messages).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('abort emits immediately after clearing live state so the renderer drops running/pending cards', async () => {
    const { runtime, session, window } = await initStreaming()
    // A historical resultless call plus a live turn with a running tool.
    session.messages = [
      { role: 'assistant', timestamp: T, stopReason: 'done', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'old' } }] },
    ]
    priv(runtime).handleEvent(startEvent(textMsg('H')))
    priv(runtime).handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'new' } } as unknown as AgentSessionEvent)
    const sendsBefore = window.webContents.send.mock.calls.length
    const aborted = runtime.abort()
    // The abort emits exactly one immediate snapshot, synchronously before teardown.
    expect(window.webContents.send.mock.calls.length).toBe(sendsBefore + 1)
    const sent = window.webContents.send.mock.calls[sendsBefore]![1] as { messages: Array<{ role: string; blocks: Array<{ type: string; status?: string }> }> }
    // The emitted payload carries no old live state: the resultless call is interrupted.
    expect(sent.messages).toHaveLength(1)
    expect(sent.messages[0]!.blocks[0]).toMatchObject({ type: 'tool', status: 'interrupted' })
    await aborted
    const snap = runtime.snapshot()
    expect((runtime as unknown as { liveAssistant: unknown }).liveAssistant).toBeNull()
    expect((runtime as unknown as { liveTools: Map<string, unknown> }).liveTools.size).toBe(0)
    expect(snap.messages[0]!.blocks[0]).toMatchObject({ type: 'tool', status: 'interrupted' })
  })

  it('abort still emits the immediate clear snapshot when the SDK abort itself fails', async () => {
    const { runtime, session, window } = await initStreaming()
    session.abortImpl = async () => { throw new Error('abort boom') }
    priv(runtime).handleEvent(startEvent(textMsg('H')))
    const sendsBefore = window.webContents.send.mock.calls.length
    const aborted = runtime.abort()
    // The clear snapshot fires before teardown regardless of its outcome.
    expect(window.webContents.send.mock.calls.length).toBe(sendsBefore + 1)
    await aborted
    expect(runtime.snapshot().error?.message).toBe('Abort failed')
  })

  it('session switch clears the live state and the old timer cannot emit for the new session', async () => {
    const { runtime, window } = await initStreaming()
    vi.useFakeTimers()
    try {
      priv(runtime).handleEvent(startEvent(textMsg('H')))
      priv(runtime).handleEvent(updateEvent(textMsg('He'))) // trailing flush pending
      const sessionB = new FakeSession()
      mocks.createAgentSession.mockResolvedValue({ session: sessionB, modelFallbackMessage: undefined })
      const switching = runtime.newSession()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(100)
      await switching
      expect(runtime.snapshot().messages).toHaveLength(0)
      expect((runtime as unknown as { liveAssistant: unknown }).liveAssistant).toBeNull()
      expect((runtime as unknown as { liveFlushTimer: unknown }).liveFlushTimer).toBeNull()
      const count = window.webContents.send.mock.calls.length
      await vi.advanceTimersByTimeAsync(100)
      expect(window.webContents.send.mock.calls.length).toBe(count) // stale timer never emits
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('live assistant with the partial already in session.messages (pi-agent-core order)', () => {
  const T = 1700000000000
  const textMsg = (text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    role: 'assistant', timestamp: T, stopReason: 'pending',
    content: [{ type: 'text', text }], ...overrides,
  })
  const startEvent = (message: unknown): AgentSessionEvent => ({ type: 'message_start', message } as unknown as AgentSessionEvent)
  const updateEvent = (message: unknown): AgentSessionEvent => ({ type: 'message_update', message } as unknown as AgentSessionEvent)
  const endEvent = (message: unknown): AgentSessionEvent => ({ type: 'message_end', message } as unknown as AgentSessionEvent)

  async function initStreaming(): Promise<{ runtime: PiRuntime; session: FakeSession }> {
    const session = new FakeSession()
    mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined })
    const runtime = new PiRuntime()
    runtime.setWindow(new FakeWindow() as unknown as BrowserWindow)
    await runtime.initialize(mkdtempSync(join(TMP, 'pi-ws-')))
    return { runtime, session }
  }

  it('locks the ordinal before the already-appended partial and keeps a single entry per stage', async () => {
    const { runtime, session } = await initStreaming()
    // pi-agent-core pushes the partial into session.messages, then emits
    // message_start with a spread copy (a different reference).
    const partial = textMsg('H')
    session.messages.push(partial)
    priv(runtime).handleEvent(startEvent({ ...partial }))
    let snap = runtime.snapshot()
    expect(snap.messages).toHaveLength(1)
    expect(snap.messages[0]).toMatchObject({ id: `assistant-0-${T}`, isStreaming: true, timestamp: T, blocks: [{ type: 'text', text: 'H' }] })

    // Updates replace the in-place object and emit another spread copy; the
    // serialized entry keeps its locked id and is never duplicated.
    const updated = textMsg('Hello')
    session.messages[session.messages.length - 1] = updated
    priv(runtime).handleEvent(updateEvent({ ...updated }))
    snap = runtime.snapshot()
    expect(snap.messages).toHaveLength(1)
    expect(snap.messages[0]).toMatchObject({ id: `assistant-0-${T}`, isStreaming: true, blocks: [{ type: 'text', text: 'Hello' }] })

    // message_end replaces the object in place and emits the exact reference.
    const final = textMsg('Hello', { stopReason: 'done' })
    session.messages[session.messages.length - 1] = final
    priv(runtime).handleEvent(endEvent(final))
    snap = runtime.snapshot()
    expect(snap.messages).toHaveLength(1)
    expect(snap.messages[0]).toMatchObject({ id: `assistant-0-${T}`, isStreaming: false, blocks: [{ type: 'text', text: 'Hello' }] })
  })

  it('counts only the assistants before the current partial, ignoring toolResults', async () => {
    const { runtime, session } = await initStreaming()
    session.messages = [
      { role: 'user', content: [{ type: 'text', text: 'q1' }], timestamp: T },
      { role: 'assistant', timestamp: T, stopReason: 'done', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], timestamp: T },
      { role: 'user', content: [{ type: 'text', text: 'q2' }], timestamp: T },
    ]
    const partial = textMsg('H')
    session.messages.push(partial)
    priv(runtime).handleEvent(startEvent({ ...partial }))
    // Tool results stream in AFTER the partial: they must not shift the ordinal.
    session.messages.push({ role: 'toolResult', toolCallId: 'call-2', toolName: 'read', content: [{ type: 'text', text: 'file' }], timestamp: T })
    const snap = runtime.snapshot()
    const ids = snap.messages.map((message) => message.id)
    // call-1's result merges into the assistant card (one card per id); call-2
    // is an orphan (its assistant toolCall lives in the live turn, not in
    // session.messages yet) and keeps its own card.
    expect(ids).toEqual([`user-0-${T}`, `assistant-0-${T}`, `user-3-${T}`, `assistant-1-${T}`, 'tool-call-2'])
    expect(snap.messages[1]!.blocks[0]).toMatchObject({ type: 'tool', id: 'call-1', name: 'bash', status: 'success', output: 'ok' })
    expect(snap.messages[4]).toMatchObject({ id: 'tool-call-2', role: 'tool', blocks: [{ type: 'tool', id: 'call-2', name: 'read', status: 'success', output: 'file' }] })
    expect(runtime.snapshot().messages[3]).toMatchObject({ id: `assistant-1-${T}`, isStreaming: true, blocks: [{ type: 'text', text: 'H' }] })
  })

  it('never mistakes a same-millisecond historical final for the current partial', async () => {
    const { runtime, session } = await initStreaming()
    session.messages = [
      { role: 'user', content: [{ type: 'text', text: 'q1' }], timestamp: T },
      textMsg('old answer', { stopReason: 'done' }),
      { role: 'user', content: [{ type: 'text', text: 'q2' }], timestamp: T },
      textMsg('old answer 2', { stopReason: 'done' }),
    ]
    const partial = textMsg('H')
    session.messages.push(partial)
    priv(runtime).handleEvent(startEvent({ ...partial }))
    const ids = runtime.snapshot().messages.map((message) => message.id)
    expect(ids).toEqual([`user-0-${T}`, `assistant-0-${T}`, `user-2-${T}`, `assistant-1-${T}`, `assistant-2-${T}`])
    expect(runtime.snapshot().messages[4]).toMatchObject({ id: `assistant-2-${T}`, isStreaming: true, blocks: [{ type: 'text', text: 'H' }] })
  })

  it('overrides the stale in-messages partial when message_end precedes the SDK append', async () => {
    const { runtime, session } = await initStreaming()
    const partial = textMsg('H')
    session.messages.push(partial)
    priv(runtime).handleEvent(startEvent({ ...partial }))
    const final = textMsg('Hello', { stopReason: 'done' })
    priv(runtime).handleEvent(endEvent(final)) // the final is not in session.messages yet
    // The still-pending in-messages partial must be overridden, never duplicated.
    let snap = runtime.snapshot()
    expect(snap.messages).toHaveLength(1)
    expect(snap.messages[0]).toMatchObject({ id: `assistant-0-${T}`, isStreaming: false, blocks: [{ type: 'text', text: 'Hello' }] })
    // The SDK appends the final after the message_end listener returns.
    session.messages = [final]
    snap = runtime.snapshot()
    expect(snap.messages).toHaveLength(1)
    expect(snap.messages[0]).toMatchObject({ id: `assistant-0-${T}`, isStreaming: false, blocks: [{ type: 'text', text: 'Hello' }] })
    priv(runtime).handleEvent({ type: 'agent_settled' } as unknown as AgentSessionEvent)
    snap = runtime.snapshot()
    expect(snap.messages).toHaveLength(1)
    expect(snap.messages[0]!.id).toBe(`assistant-0-${T}`)
  })

  it('keeps exactly one settled final with the stable id after in-place replacement', async () => {
    const { runtime, session } = await initStreaming()
    const partial = textMsg('H')
    session.messages.push(partial)
    priv(runtime).handleEvent(startEvent({ ...partial }))
    const final = textMsg('Hello', { stopReason: 'done' })
    session.messages[session.messages.length - 1] = final // in-place replacement before message_end
    priv(runtime).handleEvent(endEvent(final))
    priv(runtime).handleEvent({ type: 'agent_settled' } as unknown as AgentSessionEvent)
    const snap = runtime.snapshot()
    expect(snap.messages).toHaveLength(1)
    expect(snap.messages[0]).toMatchObject({ id: `assistant-0-${T}`, isStreaming: false, blocks: [{ type: 'text', text: 'Hello' }] })
  })

  it('locks the ordinal by object reference when message_start carries the exact appended object', async () => {
    const { runtime, session } = await initStreaming()
    session.messages = [textMsg('old', { stopReason: 'done' })]
    const partial = textMsg('H')
    session.messages.push(partial)
    priv(runtime).handleEvent(startEvent(partial)) // same reference, not a spread copy
    const snap = runtime.snapshot()
    expect(snap.messages).toHaveLength(2)
    expect(snap.messages[1]).toMatchObject({ id: `assistant-1-${T}`, isStreaming: true, blocks: [{ type: 'text', text: 'H' }] })
  })
})

describe('telemetry', () => {
  const T = 1700000000000
  const textMsg = (text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    role: 'assistant', timestamp: T, stopReason: 'pending',
    content: [{ type: 'text', text }], ...overrides,
  })
  const startEvent = (message: unknown): AgentSessionEvent => ({ type: 'message_start', message } as unknown as AgentSessionEvent)
  const updateEvent = (message: unknown): AgentSessionEvent => ({ type: 'message_update', message } as unknown as AgentSessionEvent)
  const endEvent = (message: unknown): AgentSessionEvent => ({ type: 'message_end', message } as unknown as AgentSessionEvent)

  async function initStreaming(): Promise<{ runtime: PiRuntime; session: FakeSession }> {
    const session = new FakeSession()
    mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined })
    const runtime = new PiRuntime()
    runtime.setWindow(new FakeWindow() as unknown as BrowserWindow)
    await runtime.initialize(mkdtempSync(join(TMP, 'pi-ws-')))
    return { runtime, session }
  }

  it('accumulates cacheWrite together with input/output/cacheRead/cost in usage', async () => {
    const session = new FakeSession()
    session.messages = [
      { role: 'assistant', timestamp: 1, stopReason: 'done', content: [], usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 30, cost: { total: 0.01 } } },
      { role: 'assistant', timestamp: 2, stopReason: 'done', content: [], usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, cost: { total: 0.02 } } },
    ]
    const runtime = await initRuntime(undefined, session)
    expect(runtime.snapshot().usage).toEqual({ input: 110, output: 55, cacheRead: 22, cacheWrite: 33, cost: 0.03 })
  })

  it('returns safe telemetry defaults without context usage or a live turn', async () => {
    const runtime = await initRuntime(undefined, new FakeSession())
    expect(runtime.snapshot().telemetry).toEqual({
      tokenRate: null, tokenRateKind: 'unavailable', ttftMs: null, cacheHitRate: null,
      input: 0, cacheRead: 0, cacheWrite: 0,
      contextTokens: null, contextWindow: null, contextPercent: null,
      contextEstimated: false, latestOutputTokens: null,
    })
  })

  it('surfaces getContextUsage tokens/contextWindow/percent and computes the cacheHitRate formula', async () => {
    const session = new FakeSession()
    session.getContextUsage = () => ({ tokens: 5000, contextWindow: 200000, percent: 2.5 })
    session.messages = [
      { role: 'assistant', timestamp: 1, stopReason: 'done', content: [], usage: { input: 4000, output: 1000, cacheRead: 500, cacheWrite: 500, cost: { total: 0 } } },
    ]
    const runtime = await initRuntime(undefined, session)
    const t = runtime.snapshot().telemetry
    expect(t.contextTokens).toBe(5000)
    expect(t.contextWindow).toBe(200000)
    expect(t.contextPercent).toBe(2.5)
    expect(t.contextWindow).not.toBeNull()
    expect(t.contextPercent).not.toBeNull()
    expect(t.contextEstimated).toBe(true)
    expect(t.cacheHitRate).toBeCloseTo(500 / 5000, 10)
    expect(t.input).toBe(4000)
    expect(t.cacheRead).toBe(500)
    expect(t.cacheWrite).toBe(500)
  })

  it('prefers the SDK contextWindow field over the legacy window fallback', async () => {
    const session = new FakeSession()
    session.getContextUsage = () => ({ tokens: 5000, window: 111, contextWindow: 200000, percent: 2.5 })
    const runtime = await initRuntime(undefined, session)
    const t = runtime.snapshot().telemetry
    expect(t.contextWindow).toBe(200000)
    expect(t.contextPercent).toBe(2.5)
    expect(t.contextWindow).not.toBeNull()
    expect(t.contextPercent).not.toBeNull()
  })

  it('falls back to the legacy window field when contextWindow is absent', async () => {
    const session = new FakeSession()
    session.getContextUsage = () => ({ tokens: 5000, window: 200000, percent: 2.5 })
    const runtime = await initRuntime(undefined, session)
    const t = runtime.snapshot().telemetry
    expect(t.contextWindow).toBe(200000)
    expect(t.contextPercent).toBe(2.5)
    expect(t.contextWindow).not.toBeNull()
    expect(t.contextPercent).not.toBeNull()
  })

  it('tolerates a throwing getContextUsage with context defaults', async () => {
    const session = new FakeSession()
    session.getContextUsage = () => { throw new Error('context boom') }
    const runtime = await initRuntime(undefined, session)
    const t = runtime.snapshot().telemetry
    expect(t.contextTokens).toBeNull()
    expect(t.contextWindow).toBeNull()
    expect(t.contextPercent).toBeNull()
    expect(t.contextEstimated).toBe(false)
  })

  it('measures TTFT and live-estimate rate from message_update, final rate from message_end', async () => {
    const { runtime } = await initStreaming()
    const p = priv(runtime)
    vi.useFakeTimers()
    try {
      p.handleEvent(startEvent(textMsg('')))
      await vi.advanceTimersByTimeAsync(500)
      p.handleEvent(updateEvent(textMsg('Hello'))) // first content: fixes TTFT
      let t = runtime.snapshot().telemetry
      expect(t.ttftMs).toBe(500)
      expect(t.tokenRate).toBeNull() // no elapsed time since first content yet
      expect(t.tokenRateKind).toBe('unavailable')

      await vi.advanceTimersByTimeAsync(2000)
      p.handleEvent(updateEvent(textMsg('Hello streamed'))) // +9 chars over 2s
      t = runtime.snapshot().telemetry
      expect(t.ttftMs).toBe(500) // first content stays fixed at the first update
      expect(t.tokenRateKind).toBe('live-estimate')
      expect(t.tokenRate).toBeCloseTo((9 / 4) / 2, 10) // incremental: 14-5 chars over 2s
      expect(t.latestOutputTokens).toBeNull()

      p.handleEvent(endEvent(textMsg('Hello streamed', {
        stopReason: 'done',
        usage: { input: 100, output: 100, cacheRead: 10, cacheWrite: 5, cost: { total: 0 } },
      })))
      t = runtime.snapshot().telemetry
      expect(t.tokenRateKind).toBe('final')
      expect(t.tokenRate).toBeCloseTo(100 / 2, 10) // output over the 2s since first content
      expect(t.latestOutputTokens).toBe(100)
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts thinking text in the live-estimate rate and keeps it moving (SDK thinking parts)', async () => {
    const { runtime } = await initStreaming()
    const p = priv(runtime)
    vi.useFakeTimers()
    try {
      const t1 = 'Let me reason'
      const t2 = 'Let me reason carefully about this problem and its constraints.'
      p.handleEvent(startEvent(textMsg('')))
      await vi.advanceTimersByTimeAsync(500)
      // The SDK emits thinking as { type:'thinking', thinking: string }.
      p.handleEvent(updateEvent({
        role: 'assistant', timestamp: T, stopReason: 'pending',
        content: [{ type: 'thinking', thinking: t1 }],
      }))
      let t = runtime.snapshot().telemetry
      expect(t.ttftMs).toBe(500) // first content = thinking still fixes TTFT

      await vi.advanceTimersByTimeAsync(1000)
      p.handleEvent(updateEvent({
        role: 'assistant', timestamp: T, stopReason: 'pending',
        content: [{ type: 'thinking', thinking: t2 }],
      }))
      t = runtime.snapshot().telemetry
      expect(t.tokenRateKind).toBe('live-estimate')
      // Incremental: (t2.length - t1.length) chars over the 1s since the last update.
      expect(t.tokenRate).toBeCloseTo(((t2.length - t1.length) / 4) / 1, 10)
      const rateDuringThinking = t.tokenRate

      // A later text delta over a NEW interval is EMA-smoothed with the old rate.
      await vi.advanceTimersByTimeAsync(1000)
      p.handleEvent(updateEvent({
        role: 'assistant', timestamp: T, stopReason: 'pending',
        content: [{ type: 'thinking', thinking: t2 }, { type: 'text', text: 'Done' }],
      }))
      t = runtime.snapshot().telemetry
      expect(t.tokenRateKind).toBe('live-estimate')
      const instant = (4 / 4) / 1 // +4 chars ('Done') over 1s
      expect(t.tokenRate).toBeCloseTo(instant * 0.6 + rateDuringThinking! * 0.4, 10)
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks the rate unavailable on abort when the turn never reached a final', async () => {
    const { runtime } = await initStreaming()
    const p = priv(runtime)
    vi.useFakeTimers()
    try {
      p.handleEvent(startEvent(textMsg('')))
      await vi.advanceTimersByTimeAsync(300)
      p.handleEvent(updateEvent(textMsg('Hello')))
      await vi.advanceTimersByTimeAsync(1000)
      p.handleEvent(updateEvent(textMsg('Hello there'))) // 11 chars over 1s
      expect(runtime.snapshot().telemetry.tokenRateKind).toBe('live-estimate')
      await runtime.abort()
      const t = runtime.snapshot().telemetry
      expect(t.tokenRateKind).toBe('unavailable')
      expect(t.tokenRate).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks the rate unavailable when a run fails without a final', async () => {
    const session = new FakeSession()
    session.promptImpl = () => new Promise((_resolve, reject) => { reject(new Error('llm failed')) })
    const runtime = await initRuntime(undefined, session)
    const p = priv(runtime)
    p.handleEvent(startEvent(textMsg('')))
    p.handleEvent(updateEvent(textMsg('Hello')))
    void runtime.prompt('boom')
    await flush()
    expect(runtime.snapshot().error?.message).toBe('Run failed')
    expect(runtime.snapshot().telemetry.tokenRateKind).toBe('unavailable')
    expect(runtime.snapshot().telemetry.tokenRate).toBeNull()
  })

  it('abort clears TTFT and latestOutputTokens together with the rate', async () => {
    const session = new FakeSession()
    session.messages = [
      { role: 'assistant', timestamp: 1, stopReason: 'done', content: [], usage: { input: 10, output: 42, cacheRead: 1, cacheWrite: 2, cost: { total: 0 } } },
    ]
    const runtime = await initRuntime(undefined, session)
    const p = priv(runtime)
    vi.useFakeTimers()
    try {
      expect(runtime.snapshot().telemetry.latestOutputTokens).toBe(42) // restored from history
      p.handleEvent(startEvent(textMsg('')))
      await vi.advanceTimersByTimeAsync(300)
      p.handleEvent(updateEvent(textMsg('Hello')))
      await vi.advanceTimersByTimeAsync(1000)
      p.handleEvent(updateEvent(textMsg('Hello there')))
      let t = runtime.snapshot().telemetry
      expect(t.ttftMs).toBe(300)
      expect(t.tokenRateKind).toBe('live-estimate')
      await runtime.abort()
      t = runtime.snapshot().telemetry
      expect(t.tokenRate).toBeNull()
      expect(t.tokenRateKind).toBe('unavailable')
      expect(t.ttftMs).toBeNull()
      expect(t.latestOutputTokens).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('message_end without usage stays unavailable/null; a real output of 0 finalizes as final 0', async () => {
    const { runtime, session } = await initStreaming()
    const p = priv(runtime)
    vi.useFakeTimers()
    try {
      p.handleEvent(startEvent(textMsg('')))
      await vi.advanceTimersByTimeAsync(500)
      p.handleEvent(updateEvent(textMsg('Hello')))
      // A final without usage: missing usage is never treated as 0.
      const first = textMsg('Hello', { stopReason: 'done' })
      p.handleEvent(endEvent(first))
      let t = runtime.snapshot().telemetry
      expect(t.tokenRateKind).toBe('unavailable')
      expect(t.tokenRate).toBeNull()
      expect(t.latestOutputTokens).toBeNull()
      expect(t.ttftMs).toBe(500) // the measured TTFT is kept

      // The SDK appended the first final; a second turn reports a REAL 0 output.
      session.messages = [first]
      p.handleEvent(startEvent(textMsg('')))
      await vi.advanceTimersByTimeAsync(1000)
      p.handleEvent(updateEvent(textMsg('Hi')))
      await vi.advanceTimersByTimeAsync(2000)
      p.handleEvent(endEvent(textMsg('Hi', {
        stopReason: 'done', usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      })))
      t = runtime.snapshot().telemetry
      expect(t.tokenRateKind).toBe('final')
      expect(t.tokenRate).toBe(0)
      expect(t.latestOutputTokens).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores latestOutputTokens from history with rate unavailable and resets telemetry on a new session', async () => {
    const sessionA = new FakeSession()
    sessionA.messages = [
      { role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: 1 },
      { role: 'assistant', timestamp: 2, stopReason: 'done', content: [], usage: { input: 10, output: 42, cacheRead: 1, cacheWrite: 2, cost: { total: 0 } } },
    ]
    const runtime = await initRuntime(undefined, sessionA)
    let t = runtime.snapshot().telemetry
    expect(t.latestOutputTokens).toBe(42)
    expect(t.tokenRateKind).toBe('unavailable')
    expect(t.tokenRate).toBeNull()
    expect(t.ttftMs).toBeNull()

    const sessionB = new FakeSession()
    mocks.createAgentSession.mockResolvedValue({ session: sessionB, modelFallbackMessage: undefined })
    await runtime.newSession()
    t = runtime.snapshot().telemetry
    expect(t.latestOutputTokens).toBeNull()
    expect(t.tokenRateKind).toBe('unavailable')
    expect(t.tokenRate).toBeNull()
    expect(t.ttftMs).toBeNull()
    expect(t.input).toBe(0)
  })
})

describe('approval extension', () => {
  it('lets read through without a dialog and blocks bash/edit/write unless allowed', async () => {
    await initRuntime()
    const options = mocks.DefaultResourceLoader.mock.calls[0]![0] as { extensionFactories: InlineExtension[] }
    const factory = options.extensionFactories[0]! as unknown as (pi: { on: (event: string, handler: unknown) => void }) => void
    const pi = { on: vi.fn() }
    factory(pi)
    expect(pi.on).toHaveBeenCalledWith('tool_call', expect.any(Function))
    const handler = pi.on.mock.calls[0]![1] as (event: { toolName: string; input: Record<string, unknown> }) => unknown

    // read is not an approval tool: no dialog, passes through.
    expect(await handler({ toolName: 'read', input: { path: '/x' } })).toBeUndefined()
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled()

    // Deny blocks every approval tool before execution.
    mocks.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    expect(await handler({ toolName: 'bash', input: { command: 'rm -rf /' } })).toEqual({ block: true, reason: 'Denied by user' })
    expect(await handler({ toolName: 'edit', input: { file: 'a' } })).toEqual({ block: true, reason: 'Denied by user' })
    expect(await handler({ toolName: 'write', input: { file: 'b' } })).toEqual({ block: true, reason: 'Denied by user' })
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledTimes(3)

    // Allow lets the tool run (undefined = proceed).
    mocks.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    expect(await handler({ toolName: 'bash', input: { command: 'ls' } })).toBeUndefined()
    expect(await handler({ toolName: 'edit', input: { file: 'a' } })).toBeUndefined()
  })

  it('always requires a host verdict for project-scoped subagents', async () => {
    await initRuntime()
    const options = mocks.DefaultResourceLoader.mock.calls[0]![0] as { extensionFactories: InlineExtension[] }
    const factory = options.extensionFactories[0]! as unknown as (pi: { on: (event: string, handler: unknown) => void }) => void
    const pi = { on: vi.fn() }
    factory(pi)
    const handler = pi.on.mock.calls[0]![1] as (event: { toolName: string; input: Record<string, unknown> }) => unknown

    mocks.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    expect(await handler({
      toolName: 'subagent',
      input: { agentScope: 'project', agent: 'worker', task: 'change the repo' },
    })).toEqual({ block: true, reason: 'Project subagents denied by user' })

    mocks.dialog.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    expect(await handler({
      toolName: 'subagent',
      input: { agentScope: 'both', tasks: [{ agent: 'scout', task: 'inspect' }] },
    })).toBeUndefined()
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledTimes(2)
  })
})

describe('tool approval mode', () => {
  async function approvalHandler(): Promise<{ runtime: PiRuntime; handler: (event: { toolName: string; input: Record<string, unknown> }) => unknown }> {
    const runtime = await initRuntime()
    const options = mocks.DefaultResourceLoader.mock.calls[0]![0] as { extensionFactories: InlineExtension[] }
    const factory = options.extensionFactories[0]! as unknown as (pi: { on: (event: string, handler: unknown) => void }) => void
    const pi = { on: vi.fn() }
    factory(pi)
    return { runtime, handler: pi.on.mock.calls[0]![1] as (event: { toolName: string; input: Record<string, unknown> }) => unknown }
  }

  it('defaults to ask, exposes the mode on both snapshots and switches idempotently', async () => {
    const runtime = new PiRuntime()
    expect(runtime.getToolApprovalMode()).toBe('ask')
    expect(runtime.snapshot().toolApprovalMode).toBe('ask')
    expect((await runtime.getSettings()).toolApprovalMode).toBe('ask')

    const win = new FakeWindow()
    runtime.setWindow(win as unknown as BrowserWindow)
    runtime.setToolApprovalMode('managed')
    expect(runtime.getToolApprovalMode()).toBe('managed')
    expect(runtime.snapshot().toolApprovalMode).toBe('managed')
    expect((await runtime.getSettings()).toolApprovalMode).toBe('managed')
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    // Idempotent set: same mode again is a no-op, no redundant emit.
    runtime.setToolApprovalMode('managed')
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    runtime.setToolApprovalMode('ask')
    expect(runtime.snapshot().toolApprovalMode).toBe('ask')
  })

  it('managed mode passes bash/edit/write straight through without a dialog; read-family tools never dialog', async () => {
    const { runtime, handler } = await approvalHandler()
    runtime.setToolApprovalMode('managed')
    expect(await handler({ toolName: 'bash', input: { command: 'rm -rf /' } })).toBeUndefined()
    expect(await handler({ toolName: 'edit', input: { file: 'a.txt' } })).toBeUndefined()
    expect(await handler({ toolName: 'write', input: { file: 'b.txt' } })).toBeUndefined()
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled()
    for (const name of ['read', 'grep', 'find', 'ls']) {
      expect(await handler({ toolName: name, input: {} })).toBeUndefined()
    }
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('a dynamic managed→ask switch restores per-call dialogs for the very next call', async () => {
    const { runtime, handler } = await approvalHandler()
    runtime.setToolApprovalMode('managed')
    expect(await handler({ toolName: 'bash', input: { command: 'ls' } })).toBeUndefined()
    runtime.setToolApprovalMode('ask')
    mocks.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    expect(await handler({ toolName: 'bash', input: { command: 'rm -rf /' } })).toEqual({ block: true, reason: 'Denied by user' })
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('a dialog already awaiting keeps its own verdict: switching to managed never silently allows it', async () => {
    const { runtime, handler } = await approvalHandler()
    let resolveDialog!: (value: { response: number; checkboxChecked: boolean }) => void
    mocks.dialog.showMessageBox.mockReturnValue(new Promise((resolve) => { resolveDialog = resolve }))
    const pending = handler({ toolName: 'bash', input: { command: 'rm -rf /' } })
    // The mode flips to managed while the dialog waits; the user still decides.
    runtime.setToolApprovalMode('managed')
    resolveDialog({ response: 1, checkboxChecked: false })
    expect(await pending).toEqual({ block: true, reason: 'Denied by user' })
  })
})

describe('settings', () => {
  const SECRET = 'sk-secret-test-42'

  function fakeModelRuntime(overrides: {
    providers?: Array<{ id: string; name: string }>
    statuses?: Record<string, { configured: boolean; source?: string; label?: string }>
    credentials?: Array<{ providerId: string; type: string }>
    available?: Array<{ provider: string; id: string; name?: string }>
    refreshResult?: { aborted: boolean; errors: Map<string, Error> }
    setKeyImpl?: () => Promise<void>
    models?: Record<string, string[]>
  } = {}) {
    const catalog = overrides.models ?? {}
    const runtime = {
      getProviders: vi.fn(() => overrides.providers ?? []),
      getProviderAuthStatus: vi.fn((id: string) => overrides.statuses?.[id] ?? { configured: false }),
      listCredentials: vi.fn(async () => overrides.credentials ?? []),
      getAvailable: vi.fn(async () => overrides.available ?? []),
      getModel: vi.fn((provider: string, id: string) => (catalog[provider]?.includes(id) ? { provider, id } : null)),
      setRuntimeApiKey: vi.fn(async () => { if (overrides.setKeyImpl) await overrides.setKeyImpl() }),
      removeRuntimeApiKey: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      refresh: vi.fn(async () => overrides.refreshResult ?? { aborted: false, errors: new Map() }),
    }
    mocks.ModelRuntime.create.mockResolvedValue(runtime)
    return runtime
  }

  async function init(session?: FakeSession): Promise<{ runtime: PiRuntime; win: FakeWindow }> {
    const win = new FakeWindow()
    const runtime = new PiRuntime()
    runtime.setWindow(win as unknown as BrowserWindow)
    if (session) mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined })
    await runtime.initialize(mkdtempSync(join(TMP, 'pi-ws-')))
    return { runtime, win }
  }

  it('returns safe defaults without a session', async () => {
    const settings = await new PiRuntime().getSettings()
    expect(settings).toEqual({
      providers: [], defaultProvider: null, defaultModel: null, defaultThinkingLevel: 'medium',
      compactionEnabled: false, retryEnabled: false, httpIdleTimeoutMs: 300_000,
      compaction: { reserveTokens: null, keepRecentTokens: null },
      retry: { maxRetries: null, baseDelayMs: null, maxDelayMs: null },
      keyPersistence: 'runtime-only', toolApprovalMode: 'ask', error: null,
    })
  })

  it('reads settings from the session SettingsManager with null for missing fields', async () => {
    const sm = new FakeSettingsManager()
    sm.defaultProvider = 'openai'
    sm.defaultModel = 'gpt-4o'
    sm.defaultThinkingLevel = 'max'
    sm.compactionEnabled = true
    sm.retryEnabled = true
    sm.httpIdleTimeoutMs = 12345
    sm.compaction = { reserveTokens: 111, keepRecentTokens: 222 }
    sm.retry = { maxRetries: 5, baseDelayMs: 700, maxDelayMs: 9000 }
    const session = new FakeSession()
    session.settingsManager = sm
    fakeModelRuntime({ providers: [{ id: 'openai', name: 'OpenAI' }], statuses: { openai: { configured: true, source: 'stored' } } })
    const { runtime } = await init(session)
    const settings = await runtime.getSettings()
    expect(settings.defaultProvider).toBe('openai')
    expect(settings.defaultModel).toBe('gpt-4o')
    expect(settings.defaultThinkingLevel).toBe('max')
    expect(settings.compactionEnabled).toBe(true)
    expect(settings.retryEnabled).toBe(true)
    expect(settings.httpIdleTimeoutMs).toBe(12345)
    expect(settings.compaction).toEqual({ reserveTokens: 111, keepRecentTokens: 222 })
    expect(settings.retry).toEqual({ maxRetries: 5, baseDelayMs: 700, maxDelayMs: 9000 })
    expect(settings.error).toBeNull()
    // Missing maxDelayMs surfaces as null.
    sm.retry.maxDelayMs = null
    sm.retry.maxRetries = null
    expect((await runtime.getSettings()).retry).toEqual({ maxRetries: null, baseDelayMs: 700, maxDelayMs: null })
  })

  it('maps auth sources, credential types and per-provider available counts', async () => {
    fakeModelRuntime({
      providers: [
        { id: 'alpha', name: '' }, { id: 'beta', name: 'Beta AI' }, { id: 'gamma', name: 'Gamma' },
        { id: 'delta', name: 'Delta' }, { id: 'eps', name: 'Eps' }, { id: 'zeta', name: 'Zeta' },
      ],
      statuses: {
        alpha: { configured: true, source: 'stored' },
        beta: { configured: true, source: 'runtime', label: 'runtime key' },
        gamma: { configured: true, source: 'environment' },
        delta: { configured: true, source: 'models_json_key' },
        eps: { configured: true, source: 'models_json_command' },
        zeta: { configured: false },
      },
      credentials: [{ providerId: 'beta', type: 'oauth' }],
      available: [
        { provider: 'alpha', id: 'a1' }, { provider: 'alpha', id: 'a2' },
        { provider: 'beta', id: 'b1' },
      ],
    })
    const { runtime } = await init()
    expect((await runtime.getSettings()).providers).toEqual([
      { id: 'alpha', name: 'alpha', authStatus: 'stored', authLabel: null, credentialType: null, availableModelCount: 2 },
      { id: 'beta', name: 'Beta AI', authStatus: 'runtime', authLabel: 'runtime key', credentialType: 'oauth', availableModelCount: 1 },
      { id: 'gamma', name: 'Gamma', authStatus: 'environment', authLabel: null, credentialType: null, availableModelCount: 0 },
      { id: 'delta', name: 'Delta', authStatus: 'models-json', authLabel: null, credentialType: null, availableModelCount: 0 },
      { id: 'eps', name: 'Eps', authStatus: 'models-json', authLabel: null, credentialType: null, availableModelCount: 0 },
      { id: 'zeta', name: 'Zeta', authStatus: 'none', authLabel: null, credentialType: null, availableModelCount: 0 },
    ])
  })

  it('updateSettings applies setters, flushes, emits and returns the new snapshot', async () => {
    const sm = new FakeSettingsManager()
    const session = new FakeSession()
    session.settingsManager = sm
    fakeModelRuntime({
      providers: [{ id: 'openai', name: 'OpenAI' }, { id: 'anthropic', name: 'Anthropic' }],
      models: { openai: ['gpt-4o'], anthropic: ['claude-3-5-sonnet'] },
    })
    const { runtime, win } = await init(session)
    const settings = await runtime.updateSettings({
      defaultProvider: 'openai', defaultModel: 'gpt-4o', defaultThinkingLevel: 'high',
      compactionEnabled: true, retryEnabled: true, httpIdleTimeoutMs: 90000,
    })
    expect(sm.calls).toContain('setDefaultModelAndProvider')
    expect(sm.calls).toContain('setDefaultThinkingLevel')
    expect(sm.calls).toContain('setCompactionEnabled')
    expect(sm.calls).toContain('setRetryEnabled')
    expect(sm.calls).toContain('setHttpIdleTimeoutMs')
    expect(sm.calls.indexOf('flush')).toBeGreaterThan(sm.calls.indexOf('setDefaultModelAndProvider'))
    expect(sm.calls).toContain('drainErrors')
    expect(sm.defaultProvider).toBe('openai')
    expect(sm.defaultModel).toBe('gpt-4o')
    expect(settings.defaultProvider).toBe('openai')
    expect(settings.defaultModel).toBe('gpt-4o')
    expect(settings.httpIdleTimeoutMs).toBe(90000)
    expect(settings.error).toBeNull()
    const sendsBefore = win.webContents.send.mock.calls.length
    await runtime.updateSettings({ defaultProvider: 'openai' }) // same provider: current model still belongs
    expect(sm.calls).toContain('setDefaultProvider')
    expect(sm.calls.filter((c) => c === 'setDefaultModelAndProvider')).toHaveLength(1)
    expect(win.webContents.send.mock.calls.length).toBeGreaterThan(sendsBefore)
  })

  it('updateSettings rejects illegal provider/model and cross-provider combinations without calling setters', async () => {
    const sm = new FakeSettingsManager()
    sm.defaultProvider = 'openai'
    sm.defaultModel = 'gpt-4o'
    const session = new FakeSession()
    session.settingsManager = sm
    fakeModelRuntime({
      providers: [{ id: 'openai', name: 'OpenAI' }, { id: 'anthropic', name: 'Anthropic' }],
      models: { openai: ['gpt-4o'], anthropic: ['claude-3-5-sonnet'] },
    })
    const { runtime } = await init(session)
    const patches: SettingsPatch[] = [
      { defaultProvider: 'nope' }, // provider does not exist
      { defaultProvider: 'anthropic' }, // would strand the current model (gpt-4o belongs to openai)
      { defaultModel: 'claude-3-5-sonnet' }, // model not in the effective provider (openai)
      { defaultProvider: 'anthropic', defaultModel: 'gpt-4o' }, // cross-provider pair
      { defaultProvider: null }, // null provider rejected outright
      { defaultModel: null }, // null model rejected outright
    ]
    for (const patch of patches) {
      const settings = await runtime.updateSettings(patch)
      expect(settings.error).toEqual({ message: '保存设置失败', recoverable: true })
      // The patch is rejected up front: no setter, flush or error drain may run.
      expect(sm.calls.some((call) => call.startsWith('set'))).toBe(false)
      expect(sm.calls).not.toContain('flush')
      expect(sm.calls).not.toContain('drainErrors')
      expect(sm.defaultProvider).toBe('openai')
      expect(sm.defaultModel).toBe('gpt-4o')
    }
  })

  it('updateSettings accepts legal pairs, including a provider+model switch to another provider', async () => {
    const sm = new FakeSettingsManager()
    sm.defaultProvider = 'openai'
    sm.defaultModel = 'gpt-4o'
    const session = new FakeSession()
    session.settingsManager = sm
    fakeModelRuntime({
      providers: [{ id: 'openai', name: 'OpenAI' }, { id: 'anthropic', name: 'Anthropic' }],
      models: { openai: ['gpt-4o'], anthropic: ['claude-3-5-sonnet'] },
    })
    const { runtime } = await init(session)
    // Both halves together: the switch may cross providers as long as the
    // pair belongs to the same provider.
    const switched = await runtime.updateSettings({ defaultProvider: 'anthropic', defaultModel: 'claude-3-5-sonnet' })
    expect(switched.error).toBeNull()
    expect(sm.defaultProvider).toBe('anthropic')
    expect(sm.defaultModel).toBe('claude-3-5-sonnet')
    expect(sm.calls).toContain('setDefaultModelAndProvider')
    // Model-only patch against the current provider is legal.
    const modelOnly = await runtime.updateSettings({ defaultModel: 'claude-3-5-sonnet' })
    expect(modelOnly.error).toBeNull()
    expect(sm.defaultModel).toBe('claude-3-5-sonnet')
    // Provider-only patch that keeps the current model is legal.
    const providerOnly = await runtime.updateSettings({ defaultProvider: 'anthropic' })
    expect(providerOnly.error).toBeNull()
    expect(sm.defaultProvider).toBe('anthropic')
  })

  it('surfaces only a fixed sanitized error when flush drains errors or throws', async () => {
    const sm = new FakeSettingsManager()
    const session = new FakeSession()
    session.settingsManager = sm
    fakeModelRuntime()
    const { runtime } = await init(session)
    sm.errors = [{ scope: 'global', error: new Error(`persist boom ${SECRET}`) }]
    const settings = await runtime.updateSettings({ defaultThinkingLevel: 'low' })
    expect(settings.error).toEqual({ message: '保存设置失败', recoverable: true })
    expect(JSON.stringify(settings)).not.toContain(SECRET)
    expect(JSON.stringify(settings)).not.toContain('persist boom')
    sm.flushImpl = async () => { throw new Error(`flush blew up ${SECRET}`) }
    const again = await runtime.updateSettings({ defaultThinkingLevel: 'high' })
    expect(again.error).toEqual({ message: '保存设置失败', recoverable: true })
    expect(JSON.stringify(again)).not.toContain(SECRET)
  })

  it('setRuntimeApiKey forwards the key to the SDK but never into any DTO', async () => {
    const mr = fakeModelRuntime({ providers: [{ id: 'beta', name: 'Beta' }], statuses: { beta: { configured: true, source: 'runtime' } } })
    const { runtime } = await init()
    const settings = await runtime.setRuntimeApiKey('beta', SECRET)
    expect(mr.setRuntimeApiKey).toHaveBeenCalledWith('beta', SECRET)
    expect(settings.error).toBeNull()
    expect(JSON.stringify(settings)).not.toContain(SECRET)
    expect(JSON.stringify(runtime.snapshot())).not.toContain(SECRET)
  })

  it('setRuntimeApiKey rejects unknown providers and sanitizes SDK failures', async () => {
    const mr = fakeModelRuntime({ providers: [{ id: 'beta', name: 'Beta' }] })
    const { runtime } = await init()
    const unknown = await runtime.setRuntimeApiKey('nope', SECRET)
    expect(mr.setRuntimeApiKey).not.toHaveBeenCalled()
    expect(unknown.error).toEqual({ message: '设置 API Key 失败', recoverable: true })
    expect(JSON.stringify(unknown)).not.toContain(SECRET)
    mr.setRuntimeApiKey.mockImplementation(async () => { throw new Error(`key store boom ${SECRET}`) })
    const failed = await runtime.setRuntimeApiKey('beta', SECRET)
    expect(failed.error).toEqual({ message: '设置 API Key 失败', recoverable: true })
    expect(JSON.stringify(failed)).not.toContain(SECRET)
    expect(JSON.stringify(failed)).not.toContain('key store boom')
  })

  it('a failed setRuntimeApiKey never leaks the real key, Bearer/JWT/query secrets into settings, snapshot or console', async () => {
    const session = new FakeSession()
    session.promptImpl = () => Promise.reject(new Error(`llm auth boom ${SECRET}`))
    const mr = fakeModelRuntime({ providers: [{ id: 'beta', name: 'Beta' }] })
    const { runtime } = await init(session)
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.sig-abcdefgh'
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      mr.setRuntimeApiKey.mockImplementation(async () => {
        throw new Error(`Bearer ${SECRET} at https://user:pw@api.example.com/v1?api_key=${SECRET}&token=${jwt}`)
      })
      const settings = await runtime.setRuntimeApiKey('beta', SECRET)
      expect(settings.error).toEqual({ message: '设置 API Key 失败', recoverable: true })
      const snapshotText = JSON.stringify(runtime.snapshot())
      for (const fragment of [SECRET, 'Bearer', 'api.example.com', 'user:pw@', 'api_key', jwt]) {
        expect(JSON.stringify(settings)).not.toContain(fragment)
        expect(snapshotText).not.toContain(fragment)
      }
      // Nothing written to the console may carry the secret either.
      for (const call of [...consoleSpy.mock.calls, ...logSpy.mock.calls]) {
        expect(JSON.stringify(call)).not.toContain(SECRET)
      }
      // The failed key stays registered as a known secret: a later unrelated
      // failure mentioning it is scrubbed in the snapshot while the useful
      // context survives.
      await runtime.prompt('go')
      await flush()
      expect(runtime.snapshot().error?.detail).toContain('llm auth boom')
      expect(runtime.snapshot().error?.detail).not.toContain(SECRET)
    } finally {
      consoleSpy.mockRestore()
      logSpy.mockRestore()
    }
  })

  it('logoutProvider removes the runtime key, logs out and reloads locally without a network refresh', async () => {
    const mr = fakeModelRuntime({
      providers: [{ id: 'beta', name: 'Beta' }],
      available: [{ provider: 'beta', id: 'b1', name: 'B1' }],
    })
    const { runtime } = await init()
    const settings = await runtime.logoutProvider('beta')
    expect(mr.removeRuntimeApiKey).toHaveBeenCalledWith('beta')
    expect(mr.logout).toHaveBeenCalledWith('beta')
    expect(mr.removeRuntimeApiKey.mock.invocationCallOrder[0]!).toBeLessThan(mr.logout.mock.invocationCallOrder[0]!)
    expect(mr.refresh).not.toHaveBeenCalled() // logout never forces a network refresh
    expect(settings.error).toBeNull()
    expect(runtime.snapshot().models).toEqual([{ provider: 'beta', id: 'b1', name: 'B1' }])
    // Only the public refreshModels path may force a network refresh.
    await runtime.refreshModels()
    expect(mr.refresh).toHaveBeenCalledTimes(1)
    expect(mr.refresh).toHaveBeenCalledWith(expect.objectContaining({ allowNetwork: true, force: true }))
  })

  it('refreshModels refreshes with network+force and reduces errors to one fixed message', async () => {
    const mr = fakeModelRuntime({
      providers: [{ id: 'beta', name: 'Beta' }],
      available: [{ provider: 'beta', id: 'b1' }],
      refreshResult: { aborted: false, errors: new Map([['beta', new Error(`catalog boom ${SECRET}`)]]) },
    })
    const { runtime } = await init()
    const settings = await runtime.refreshModels()
    expect(mr.refresh).toHaveBeenCalledWith(expect.objectContaining({ allowNetwork: true, force: true }))
    expect(settings.error).toEqual({ message: '刷新模型列表失败', recoverable: true })
    expect(JSON.stringify(settings)).not.toContain(SECRET)
    expect(JSON.stringify(settings)).not.toContain('catalog boom')
    mr.refresh.mockResolvedValue({ aborted: false, errors: new Map() })
    const ok = await runtime.refreshModels()
    expect(ok.error).toBeNull()
    expect(ok.providers).toEqual([{ id: 'beta', name: 'Beta', authStatus: 'none', authLabel: null, credentialType: null, availableModelCount: 1 }])
  })

  it('sanitizes provider-discovery failures and clears the error on the next success', async () => {
    const mr = fakeModelRuntime({ providers: [{ id: 'beta', name: 'Beta' }] })
    const { runtime } = await init()
    mr.getAvailable.mockImplementation(async () => { throw new Error(`read failed ${SECRET}`) })
    const settings = await runtime.getSettings()
    expect(settings.error).toEqual({ message: '无法读取模型配置', recoverable: true })
    expect(settings.providers).toEqual([])
    expect(JSON.stringify(settings)).not.toContain(SECRET)
    expect(JSON.stringify(settings)).not.toContain('read failed')
    mr.getAvailable.mockResolvedValue([{ provider: 'beta', id: 'b1' }])
    expect((await runtime.getSettings()).error).toBeNull()
  })

  it('never lets any SettingsManager getter exception reject getSettings or leak the raw error', async () => {
    const sm = new FakeSettingsManager()
    const session = new FakeSession()
    session.settingsManager = sm
    fakeModelRuntime({ providers: [{ id: 'beta', name: 'Beta' }] })
    const { runtime } = await init(session)
    const getters = [
      'getDefaultProvider', 'getDefaultModel', 'getDefaultThinkingLevel', 'getCompactionEnabled',
      'getRetryEnabled', 'getHttpIdleTimeoutMs', 'getCompactionSettings', 'getRetrySettings',
    ] as const
    for (const name of getters) {
      ;(sm as unknown as Record<string, unknown>)[name] = () => { throw new Error(`${name} boom ${SECRET}`) }
      // Must resolve with only the fixed sanitized message, never reject past IPC.
      const settings = await runtime.getSettings()
      expect(settings.error).toEqual({ message: '无法读取模型配置', recoverable: true })
      expect(JSON.stringify(settings)).not.toContain(SECRET)
      expect(JSON.stringify(settings)).not.toContain('boom')
      delete (sm as unknown as Record<string, unknown>)[name]
    }
  })

  it('reduces listCredentials and getProviderAuthStatus failures to the fixed message and resolves', async () => {
    const mr = fakeModelRuntime({ providers: [{ id: 'beta', name: 'Beta' }] })
    const { runtime } = await init()
    mr.listCredentials.mockImplementation(async () => { throw new Error(`creds boom ${SECRET}`) })
    const settings = await runtime.getSettings()
    expect(settings.error).toEqual({ message: '无法读取模型配置', recoverable: true })
    expect(JSON.stringify(settings)).not.toContain(SECRET)
    expect(JSON.stringify(settings)).not.toContain('creds boom')
    mr.listCredentials.mockResolvedValue([])
    mr.getProviderAuthStatus.mockImplementation(() => { throw new Error(`status boom ${SECRET}`) })
    const again = await runtime.getSettings()
    expect(again.error).toEqual({ message: '无法读取模型配置', recoverable: true })
    expect(JSON.stringify(again)).not.toContain(SECRET)
    expect(JSON.stringify(again)).not.toContain('status boom')
  })

  it('keeps a shared known secret redacted while any provider still uses it, removing it only after the last logout', async () => {
    fakeModelRuntime({ providers: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }] })
    const session = new FakeSession()
    session.promptImpl = () => Promise.reject(new Error(`llm auth boom ${SECRET}`))
    const { runtime } = await init(session)
    const privSecrets = runtime as unknown as { knownSecrets: Set<string>; knownSecretsByProvider: Map<string, Set<string>> }
    await runtime.setRuntimeApiKey('alpha', SECRET)
    await runtime.setRuntimeApiKey('beta', SECRET)
    expect(privSecrets.knownSecrets.has(SECRET)).toBe(true)
    expect(privSecrets.knownSecretsByProvider.get('alpha')?.has(SECRET)).toBe(true)
    expect(privSecrets.knownSecretsByProvider.get('beta')?.has(SECRET)).toBe(true)

    // Logging out alpha must NOT forget the secret beta still uses.
    await runtime.logoutProvider('alpha')
    expect(privSecrets.knownSecrets.has(SECRET)).toBe(true)
    expect(privSecrets.knownSecretsByProvider.has('alpha')).toBe(false)
    await runtime.prompt('go')
    await flush()
    expect(runtime.snapshot().error?.detail).toContain('llm auth boom')
    expect(runtime.snapshot().error?.detail).not.toContain(SECRET)

    // The last logout removes it entirely.
    await runtime.logoutProvider('beta')
    expect(privSecrets.knownSecrets.has(SECRET)).toBe(false)
    expect(privSecrets.knownSecretsByProvider.size).toBe(0)
  })
})

describe('custom provider config', () => {
  it('getProviderConfig reads models.json without exposing the API key', async () => {
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        'my-ollama': {
          name: 'Local Ollama',
          baseUrl: 'http://localhost:11434/v1',
          api: 'openai-completions',
          apiKey: 'sk-secret',
          models: [{ id: 'llama3.1:8b', name: 'Llama' }, { id: 'qwen' }],
        },
      },
    }))
    const runtime = await initRuntime()
    const config = await runtime.getProviderConfig('my-ollama')
    expect(config).toEqual({
      id: 'my-ollama',
      name: 'Local Ollama',
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      models: [{ id: 'llama3.1:8b', name: 'Llama' }, { id: 'qwen' }],
      hasApiKey: true,
      builtin: false,
    })
    expect(JSON.stringify(config)).not.toContain('sk-secret') // key never leaks
  })

  it('getProviderConfig returns null for unknown providers', async () => {
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
      providers: { a: { baseUrl: 'http://x', api: 'openai-completions', models: [] } },
    }))
    const runtime = await initRuntime()
    expect(await runtime.getProviderConfig('missing')).toBeNull()
  })

  it('addCustomProvider editing keeps the stored key and unknown model fields, and applies editable ones', async () => {
    mocks.ModelRuntime.create.mockResolvedValue({
      getAvailable: async () => [], getModel: () => null,
      refresh: async () => ({ errors: new Map() }),
    })
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        'my-ollama': {
          baseUrl: 'http://localhost:11434/v1',
          api: 'openai-completions',
          apiKey: 'sk-original',
          models: [
            { id: 'llama3.1:8b', contextWindow: 128000, compat: { thinkingFormat: 'deepseek' } },
            { id: 'qwen' },
          ],
        },
      },
    }))
    const runtime = await initRuntime()
    // Same id, new baseUrl, no new key: unknown stored fields (compat) on
    // llama3.1:8b survive, the editable ones follow the dialog, qwen is
    // dropped and gpt-4o added.
    await runtime.addCustomProvider({
      id: 'my-ollama',
      name: 'Local Ollama',
      baseUrl: 'http://localhost:11435/v1',
      api: 'openai-completions',
      models: [
        { id: 'llama3.1:8b', name: 'Llama 3.1', input: ['text', 'image'], contextWindow: 131072 },
        { id: 'gpt-4o', name: 'GPT' },
      ],
    })
    let written = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8'))
    let provider = written.providers['my-ollama']
    expect(provider.apiKey).toBe('sk-original') // preserved when no new key is typed
    expect(provider.baseUrl).toBe('http://localhost:11435/v1')
    expect(provider.models).toEqual([
      { id: 'llama3.1:8b', name: 'Llama 3.1', input: ['text', 'image'], contextWindow: 131072, compat: { thinkingFormat: 'deepseek' } },
      { id: 'gpt-4o', name: 'GPT' },
    ])
    // A later edit that clears the editable fields persists the clearing
    // while the unknown compat field stays untouched.
    await runtime.addCustomProvider({
      id: 'my-ollama',
      baseUrl: 'http://localhost:11435/v1',
      api: 'openai-completions',
      models: [{ id: 'llama3.1:8b' }],
    })
    written = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8'))
    provider = written.providers['my-ollama']
    expect(provider.models).toEqual([
      { id: 'llama3.1:8b', compat: { thinkingFormat: 'deepseek' } },
    ])
  })

  it('addCustomProvider with a new key replaces the stored one', async () => {
    mocks.ModelRuntime.create.mockResolvedValue({
      getAvailable: async () => [], getModel: () => null,
      refresh: async () => ({ errors: new Map() }),
    })
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
      providers: { p: { baseUrl: 'http://x', api: 'openai-completions', apiKey: 'sk-old', models: [{ id: 'm' }] } },
    }))
    const runtime = await initRuntime()
    await runtime.addCustomProvider({ id: 'p', baseUrl: 'http://x', api: 'openai-completions', apiKey: 'sk-new', models: [{ id: 'm' }] })
    const written = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8'))
    expect(written.providers.p.apiKey).toBe('sk-new')
  })
})

describe('provider types & built-in key save', () => {
  it('getProviderTypes lists built-in providers and marks configured ones', async () => {
    mocks.ModelRuntime.create.mockResolvedValue({
      getAvailable: async () => [], getModel: () => null,
      getProviders: () => [
        { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
        { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com' },
        { id: 'smec-aigateway', name: 'smec-aigateway', baseUrl: 'https://aigateway.smec-cn.com/v1' },
        { id: 'bedrock', name: 'AWS Bedrock', baseUrl: undefined }, // credential-based: skipped
      ],
    })
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
      providers: { 'smec-aigateway': { baseUrl: 'https://aigateway.smec-cn.com/v1', apiKey: 'sk' } },
    }))
    const runtime = await initRuntime()
    const types = await runtime.getProviderTypes()
    expect(types.map((t) => t.id).sort()).toEqual(['anthropic', 'deepseek', 'smec-aigateway'])
    const smec = types.find((t) => t.id === 'smec-aigateway')
    expect(smec?.configured).toBe(true)
    const deepseek = types.find((t) => t.id === 'deepseek')
    expect(deepseek?.configured).toBe(false)
    expect(deepseek?.baseUrl).toBe('https://api.deepseek.com')
  })

  it('saveProviderKey persists the key and keeps existing provider fields', async () => {
    mocks.ModelRuntime.create.mockResolvedValue({
      getAvailable: async () => [], getModel: () => null,
      refresh: async () => ({ errors: new Map() }),
    })
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
      providers: { deepseek: { name: 'DeepSeek', apiKey: 'sk-old' } },
    }))
    const runtime = await initRuntime()
    await runtime.saveProviderKey('deepseek', 'sk-new')
    const written = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8'))
    expect(written.providers.deepseek).toEqual({ name: 'DeepSeek', apiKey: 'sk-new' })
  })

  it('getProviderConfig resolves the official endpoint for a built-in key-only config', async () => {
    mocks.ModelRuntime.create.mockResolvedValue({
      getAvailable: async () => [], getModel: () => null,
      getProviders: () => [{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' }],
    })
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
      providers: { deepseek: { apiKey: 'sk' } },
    }))
    const runtime = await initRuntime()
    const config = await runtime.getProviderConfig('deepseek')
    expect(config).toEqual({
      id: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      api: 'openai-completions',
      models: [],
      hasApiKey: true,
      builtin: true,
    })
  })
})


describe('compaction', () => {
  it('compaction_start enters compacting; compaction_end restores idle and surfaces failures', async () => {
    const session = new FakeSession()
    const runtime = await initRuntime(undefined, session)
    const p = priv(runtime)

    // Manual compaction emits only start/end (no agent_settled): the compacting
    // state must be restored by compaction_end or the status bar would stay
    // stuck on "Compacting context…" forever.
    p.handleEvent({ type: 'compaction_start', reason: 'manual' } as unknown as AgentSessionEvent)
    expect(runtime.snapshot().runState).toBe('compacting')

    p.handleEvent({ type: 'compaction_end', reason: 'manual', result: undefined, aborted: false, willRetry: false } as unknown as AgentSessionEvent)
    expect(runtime.snapshot().runState).toBe('idle')
    expect(runtime.snapshot().statusText).toBe('Ready')
    expect(runtime.snapshot().error).toBeNull()

    // A failed compaction restores idle too, with a recoverable error banner.
    p.handleEvent({ type: 'compaction_start', reason: 'manual' } as unknown as AgentSessionEvent)
    p.handleEvent({
      type: 'compaction_end', reason: 'manual', result: undefined, aborted: false, willRetry: false,
      errorMessage: 'model refused to summarize',
    } as unknown as AgentSessionEvent)
    expect(runtime.snapshot().runState).toBe('idle')
    expect(runtime.snapshot().error).toEqual({ message: 'Compaction failed', detail: 'model refused to summarize', recoverable: true })
  })

  it('serializes compactionSummary messages as system cards in conversation order', async () => {
    const session = new FakeSession()
    session.messages = [
      { role: 'user', content: 'first question', timestamp: 1 },
      { role: 'compactionSummary', summary: 'Summarized earlier work.', tokensBefore: 12_000, timestamp: 2 },
      { role: 'user', content: 'continue please', timestamp: 3 },
    ]
    const runtime = await initRuntime(undefined, session)
    const roles = runtime.snapshot().messages.map((m) => m.role)
    expect(roles).toEqual(['user', 'system', 'user'])
    const card = runtime.snapshot().messages[1]!
    expect(card.role).toBe('system')
    expect(card.blocks).toEqual([{ type: 'text', text: 'Summarized earlier work.' }])
    expect(card.id).toMatch(/^compaction-/)
  })

  it('skips compactionSummary messages with a non-string summary', async () => {
    const session = new FakeSession()
    session.messages = [
      { role: 'user', content: 'hi', timestamp: 1 },
      { role: 'compactionSummary', tokensBefore: 500, timestamp: 2 },
    ]
    const runtime = await initRuntime(undefined, session)
    const messages = runtime.snapshot().messages
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
  })
})

describe('subagent tool details passthrough', () => {
  const SUBAGENT_DETAILS = {
    mode: 'single',
    agentScope: 'user',
    projectAgentsDir: null,
    results: [{ agent: 'scout', agentSource: 'user', task: 'find auth', exitCode: 0, messages: [], stderr: '', usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } }],
  }

  it('tool_execution_end carries structured details into the live tool block', async () => {
    const session = new FakeSession()
    const runtime = await initRuntime(undefined, session)
    const p = priv(runtime)
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'subagent', args: { agent: 'scout', task: 'find auth' } } as unknown as AgentSessionEvent)
    p.handleEvent({
      type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'subagent', isError: false,
      result: { content: [{ type: 'text', text: 'done' }], details: SUBAGENT_DETAILS },
    } as unknown as AgentSessionEvent)
    const live = p.liveTools.get('call-1')!
    expect(live.status).toBe('success')
    expect(live.details).toEqual(SUBAGENT_DETAILS)
  })

  it('restores structured details from persisted toolResult messages', async () => {
    const session = new FakeSession()
    session.messages = [
      { role: 'user', content: 'delegate recon', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'subagent', arguments: { agent: 'scout', task: 'find auth' } }],
        timestamp: 2,
      },
      {
        role: 'toolResult', toolCallId: 'call-1', toolName: 'subagent',
        content: [{ type: 'text', text: 'scout output' }],
        details: SUBAGENT_DETAILS,
        timestamp: 3,
      },
    ]
    const runtime = await initRuntime(undefined, session)
    const assistant = runtime.snapshot().messages.find((m) => m.role === 'assistant')!
    const toolBlock = assistant.blocks.find((b) => b.type === 'tool')!
    expect(toolBlock.details).toEqual(SUBAGENT_DETAILS)
  })

  it('leaves details undefined when the tool result has none', async () => {
    const session = new FakeSession()
    session.messages = [
      { role: 'user', content: 'hi', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } }],
        timestamp: 2,
      },
      {
        role: 'toolResult', toolCallId: 'call-1', toolName: 'bash',
        content: [{ type: 'text', text: 'out' }],
        timestamp: 3,
      },
    ]
    const runtime = await initRuntime(undefined, session)
    const assistant = runtime.snapshot().messages.find((m) => m.role === 'assistant')!
    const toolBlock = assistant.blocks.find((b) => b.type === 'tool')!
    expect('details' in toolBlock).toBe(false)
  })
})

describe('bundled subagent deployment', () => {
  const projectRoot = join(TMP, '..', '..') // replaced below

  it('copies the extension and agent definitions into a fresh agent dir', async () => {
    const fresh = mkdtempSync(join(TMP, 'pi-agent-deploy-'))
    mocks.getAgentDir.mockReturnValue(fresh)
    // Point getAppPath at the real project root so the bundled sources exist.
    mocks.app.getAppPath.mockReturnValue(join(dirname(fileURLToPath(import.meta.url)), '..', '..'))
    const runtime = await initRuntime()
    expect(runtime.snapshot().runState).toBe('idle')
    expect(existsSync(join(fresh, 'extensions', 'subagent', 'index.ts'))).toBe(true)
    expect(existsSync(join(fresh, 'extensions', 'subagent', 'agents.ts'))).toBe(true)
    for (const name of ['scout', 'planner', 'reviewer', 'worker']) {
      expect(existsSync(join(fresh, 'agents', `${name}.md`))).toBe(true)
    }
    // Version marker written for future upgrade checks.
    expect(readFileSync(join(fresh, 'extensions', 'subagent', '.pi-studio-version'), 'utf8')).toBe('0.1.0')
  })

  it('never overwrites an existing install (user edits survive)', async () => {
    const fresh = mkdtempSync(join(TMP, 'pi-agent-deploy-'))
    mocks.getAgentDir.mockReturnValue(fresh)
    mocks.app.getAppPath.mockReturnValue(join(dirname(fileURLToPath(import.meta.url)), '..', '..'))
    const target = join(fresh, 'extensions', 'subagent')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'index.ts'), '// user modified')
    const runtime = await initRuntime()
    expect(readFileSync(join(target, 'index.ts'), 'utf8')).toBe('// user modified')
    expect(existsSync(join(fresh, 'agents', 'scout.md'))).toBe(false)
  })

  it('upgrades marked Pi Studio copies, backs up changed extension files, and preserves agent prompts', async () => {
    const fresh = mkdtempSync(join(TMP, 'pi-agent-deploy-'))
    mocks.getAgentDir.mockReturnValue(fresh)
    const project = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    mocks.app.getAppPath.mockReturnValue(project)
    const target = join(fresh, 'extensions', 'subagent')
    const agents = join(fresh, 'agents')
    mkdirSync(target, { recursive: true })
    mkdirSync(agents, { recursive: true })
    writeFileSync(join(target, 'index.ts'), '// old managed extension')
    writeFileSync(join(target, 'agents.ts'), '// old managed discovery')
    writeFileSync(join(target, '.pi-studio-version'), '0.0.1')
    writeFileSync(join(agents, 'scout.md'), 'user customized scout')

    await initRuntime()

    expect(readFileSync(join(target, 'index.ts'), 'utf8')).toBe(readFileSync(join(project, 'extensions', 'subagent', 'index.ts'), 'utf8'))
    expect(readFileSync(join(fresh, 'backups', 'pi-studio-subagent', '0.0.1', 'index.ts'), 'utf8')).toBe('// old managed extension')
    expect(readFileSync(join(agents, 'scout.md'), 'utf8')).toBe('user customized scout')
    expect(readFileSync(join(target, '.pi-studio-version'), 'utf8')).toBe('0.1.0')
  })

  it('ignores a missing bundled source (dev layout without extensions)', async () => {
    const fresh = mkdtempSync(join(TMP, 'pi-agent-deploy-'))
    mocks.getAgentDir.mockReturnValue(fresh)
    mocks.app.getAppPath.mockReturnValue('/tmp/no-such-app-root')
    const runtime = await initRuntime()
    expect(runtime.snapshot().error).toBeNull()
    expect(existsSync(join(fresh, 'extensions'))).toBe(false)
  })
})

describe('subagent management', () => {
  function freshAgentDir(): string {
    const dir = mkdtempSync(join(TMP, 'pi-agent-mgmt-'))
    mocks.getAgentDir.mockReturnValue(dir)
    return dir
  }

  it('lists user subagent definitions parsed from agents/*.md, sorted by name', async () => {
    const dir = freshAgentDir()
    const agentsDir = join(dir, 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(join(agentsDir, 'worker.md'), '---\nname: worker\ndescription: General purpose\nmodel: claude-sonnet\n---\n\nDo work.\n')
    writeFileSync(join(agentsDir, 'scout.md'), '---\nname: scout\ndescription: Fast recon\ntools: read, grep, find, ls\n---\n\nRecon quickly.\n')
    writeFileSync(join(agentsDir, 'broken.md'), 'no frontmatter here')
    const runtime = await initRuntime()
    const agents = runtime.listSubagents()
    expect(agents.map((a) => a.name)).toEqual(['scout', 'worker'])
    const scout = agents[0]!
    expect(scout.description).toBe('Fast recon')
    expect(scout.tools).toEqual(['read', 'grep', 'find', 'ls'])
    expect(scout.model).toBeUndefined()
    expect(scout.systemPrompt.trim()).toBe('Recon quickly.')
    const worker = agents[1]!
    expect(worker.model).toBe('claude-sonnet')
    expect(worker.tools).toBeUndefined()
  })

  it('returns an empty list when the agents dir is missing', async () => {
    freshAgentDir()
    const runtime = await initRuntime()
    expect(runtime.listSubagents()).toEqual([])
  })

  it('saveSubagent writes a definition and replaces a symlink with a real file', async () => {
    const dir = freshAgentDir()
    const agentsDir = join(dir, 'agents')
    mkdirSync(agentsDir, { recursive: true })
    // Simulate a dev-time symlink into a repo source file.
    const source = join(TMP, `pi-source-${Date.now()}.md`)
    writeFileSync(source, '---\nname: scout\ndescription: bundled\n---\n\nbundled prompt\n')
    symlinkSync(source, join(agentsDir, 'scout.md'))
    const runtime = await initRuntime()
    const list = runtime.saveSubagent('scout', {
      name: 'scout',
      description: 'Edited via GUI',
      tools: ['read', 'bash'],
      model: 'claude-haiku-4-5',
      systemPrompt: 'New prompt body.',
    })
    expect(list.map((a) => a.name)).toEqual(['scout'])
    const saved = list[0]!
    expect(saved.description).toBe('Edited via GUI')
    expect(saved.tools).toEqual(['read', 'bash'])
    expect(saved.model).toBe('claude-haiku-4-5')
    expect(saved.systemPrompt.trim()).toBe('New prompt body.')
    // The symlink was replaced by a real file; the bundle source is untouched.
    const stats = lstatSync(join(agentsDir, 'scout.md'))
    expect(stats.isSymbolicLink()).toBe(false)
    expect(readFileSync(source, 'utf8')).toContain('bundled prompt')
    expect(readFileSync(join(agentsDir, 'scout.md'), 'utf8')).toContain('Edited via GUI')
  })

  it('rejects invalid names and mismatched edits', async () => {
    const runtime = await initRuntime()
    expect(() => runtime.saveSubagent('../evil', { name: '../evil', description: 'x', systemPrompt: '' })).toThrow('Invalid subagent name')
    expect(() => runtime.saveSubagent('a', { name: 'b', description: 'x', systemPrompt: '' })).toThrow('Invalid subagent name')
    expect(() => runtime.saveSubagent('a', { name: 'a', description: '  ', systemPrompt: '' })).toThrow('Description is required')
  })

  it('deleteSubagent removes the file and lists the remainder', async () => {
    const dir = freshAgentDir()
    const agentsDir = join(dir, 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(join(agentsDir, 'scout.md'), '---\nname: scout\ndescription: Fast recon\n---\n\nRecon.\n')
    writeFileSync(join(agentsDir, 'worker.md'), '---\nname: worker\ndescription: General\n---\n\nWork.\n')
    const runtime = await initRuntime()
    expect(runtime.listSubagents()).toHaveLength(2)
    const list = runtime.deleteSubagent('scout')
    expect(list.map((a) => a.name)).toEqual(['worker'])
    expect(existsSync(join(agentsDir, 'scout.md'))).toBe(false)
    expect(() => runtime.deleteSubagent('missing')).toThrow('does not exist')
  })
})

describe('subagent live details passthrough', () => {
  it('cancels one registered subagent task without aborting the parent session', async () => {
    const runtime = await initRuntime()
    const cancel = vi.fn()
    const symbol = Symbol.for('pi-studio.subagent-control')
    const host = globalThis as typeof globalThis & Record<symbol, Map<string, () => void>>
    host[symbol] = new Map([['run-1:task-2', cancel]])
    expect(runtime.cancelSubagent('run-1:task-2')).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(runtime.cancelSubagent('missing')).toBe(false)
    expect(() => runtime.cancelSubagent('../bad')).toThrow('Invalid subagent task id')
    delete host[symbol]
  })

  it('tool_execution_update streams slim details (messages dropped) into the live block', async () => {
    const session = new FakeSession()
    const runtime = await initRuntime(undefined, session)
    const p = priv(runtime)
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'subagent', args: { agent: 'scout', task: 'x' } } as unknown as AgentSessionEvent)
    p.handleEvent({
      type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'subagent',
      partialResult: {
        content: [{ type: 'text', text: 'Parallel: 1/2 done, 1 running...' }],
        details: {
          mode: 'parallel',
          results: [
            { agent: 'scout', task: 'models', exitCode: 0, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'big' }] }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 }, model: 'm1' },
            { agent: 'scout', task: 'providers', exitCode: -1, messages: [] },
          ],
        },
      },
    } as unknown as AgentSessionEvent)
    const live = p.liveTools.get('call-1')!
    expect(live.status).toBe('running')
    expect(live.details).toEqual({
      mode: 'parallel',
      results: [
        { agent: 'scout', task: 'models', exitCode: 0, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 }, model: 'm1' },
        { agent: 'scout', task: 'providers', exitCode: -1 },
      ],
    })
    // messages never cross the IPC boundary; the output is the plain text.
    expect(JSON.stringify(live.details)).not.toContain('big')
    expect(live.output).toContain('1/2 done')
    expect(live.output).not.toContain('pi-subagent-state')
  })

  it('tool_execution_end replaces slim details with the full payload', async () => {
    const session = new FakeSession()
    const runtime = await initRuntime(undefined, session)
    const p = priv(runtime)
    p.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'subagent', args: {} } as unknown as AgentSessionEvent)
    p.handleEvent({
      type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'subagent',
      partialResult: { content: [{ type: 'text', text: 'running' }], details: { mode: 'single', results: [{ agent: 'scout', task: 'x', exitCode: -1 }] } },
    } as unknown as AgentSessionEvent)
    p.handleEvent({
      type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'subagent', isError: false,
      result: {
        content: [{ type: 'text', text: 'done' }],
        details: { mode: 'single', results: [{ agent: 'scout', task: 'x', exitCode: 0, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'full output' }] }] }] },
      },
    } as unknown as AgentSessionEvent)
    const live = p.liveTools.get('call-1')!
    expect(live.status).toBe('success')
    expect((live.details as { results: Array<{ messages?: unknown }> }).results[0]!.messages).toBeDefined()
  })
})
