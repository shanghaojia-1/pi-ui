import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { lstatSync, realpathSync, unlinkSync, renameSync, readFileSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { BrowserWindow, clipboard, dialog, type MessageBoxOptions, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionError,
  type InlineExtension,
} from '@earendil-works/pi-coding-agent'
import type {
  AppError, AppSnapshot, ChatMessage, CompactionConfig, ConnectionTestResult, CustomProviderConfig, CustomProviderApi, DynamicCommand, ExtensionInfo, ExtensionsInfo, ImageAttachment, ImageBlock, MessageBlock, ModelInfo,
  ProviderConnectionTest, ProviderStatus, RetryConfig, RunState, SessionListItem, SessionStatsInfo, SettingsPatch, SettingsSnapshot,
  TelemetryInfo, ThinkingLevel, ToolApprovalMode, ToolBlock, UsageInfo, WorkspaceInfo,
} from '../shared/contracts'
import { isPlainObject, sanitizeErrorText } from '../shared/contracts'

const EMPTY_USAGE: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
const APPROVAL_TOOLS = new Set(['bash', 'edit', 'write'])
const RECORD = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => RECORD(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '').join('')
}

/**
 * Extracts image parts from a user-message content (string or content array)
 * as ImageBlocks. The SDK stores attached images in the content array with
 * { type: 'image', data, mimeType }; each is re-emitted so the UI can render
 * what the user actually sent.
 */
const imagesOf = (content: unknown): ImageBlock[] => {
  if (!Array.isArray(content)) return []
  const images: ImageBlock[] = []
  for (const part of content) {
    if (!RECORD(part) || part.type !== 'image') continue
    if (typeof part.data !== 'string' || typeof part.mimeType !== 'string') continue
    if (!/^image\/[a-z0-9.+-]+$/i.test(part.mimeType) || !/^[A-Za-z0-9+/=\s]+$/.test(part.data)) continue
    images.push({ type: 'image', data: part.data, mimeType: part.mimeType })
  }
  return images
}
const clip = (value: unknown, limit = 12000): string => {
  let output: string
  try { output = typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
  catch { output = String(value) }
  return output.length > limit ? `${output.slice(0, limit)}\n… output truncated` : output
}

/** Shared edit-patch extraction: details.patch wins, details.diff falls back; strings only. */
const patchOf = (details: unknown): string | undefined => {
  if (!RECORD(details)) return undefined
  if (typeof details.patch === 'string') return details.patch
  if (typeof details.diff === 'string') return details.diff
  return undefined
}

/**
 * Default bound for teardown waits on pending preflights/runs. Injectable per
 * PiRuntime instance (constructor option) so tests can use milliseconds.
 */
export const RUN_CLEANUP_TIMEOUT_MS = 10_000

/** Trailing delay that coalesces high-frequency message_update IPC into one send. */
const LIVE_FLUSH_DELAY_MS = 16

/** Floor on the elapsed-seconds denominator of the final token rate. */
const MIN_RATE_ELAPSED_SEC = 1

/** Safe no-session default, matching the SDK http-dispatcher default. */
const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000

/** Null-preserving numeric reader: missing/unknown fields surface as null. */
const numberOrNull = (value: unknown): number | null => typeof value === 'number' ? value : null

type ActiveRun = {
  session: AgentSession
  epoch: number
  /** Settles when the preflight phase accepts or rejects the run submission. */
  barrier: Promise<unknown>
  /** The full run promise; settling it clears this tracking entry. */
  run: Promise<unknown>
}

/**
 * Live assistant turn currently streaming. The SDK emits cumulative snapshots
 * via message_update (never deltas) and may already hold the current partial
 * in session.messages BEFORE message_start (or append the final only after
 * the message_end listener returns) — serialize reconciles both states so the
 * partial and the final always share one stable id.
 */
type LiveAssistant = {
  session: AgentSession
  epoch: number
  /** Cumulative SDK message; replaced wholesale on every update. */
  message: Record<string, unknown> | null
  /** Timestamp from the message_start snapshot; drives display and dedupe. */
  timestamp: number | undefined
  /**
   * Identity locked at message_start: assistant-<ordinal>-<timestamp|fallback>.
   * The SDK-appended final serializes with this same id, so the partial and
   * the final always share one React key.
   */
  stableId: string
  /** Suffix component of stableId; reused verbatim when serializing the final. */
  stableSuffix: string
  /**
   * 0-based assistant ordinal locked at message_start (count of assistant
   * messages already in session.messages). Stable against tool-result
   * insertion that shifts raw message indexes.
   */
  ordinal: number
  /** True while partials stream; false once message_end adopted the final snapshot. */
  streaming: boolean
}

/**
 * One assistant toolCall occurrence in session.messages, keyed by its stable
 * position (assistant ordinal + content index). ToolResults pair to
 * occurrences positionally, so a raw id reused across turns never mixes
 * outputs and never overwrites a sibling occurrence.
 */
type ToolOccurrence = {
  /** `${assistantOrdinal}:${contentIndex}` — the pairing key. */
  key: string
  rawId: string
  name: string
  args: unknown
  messageIndex: number
  /** Assistant ordinal this occurrence belongs to; groups pairing targets. */
  ordinal: number
  /** Content index within the assistant message; part of the pairing key. */
  contentIndex: number
  /** True once a toolResult has claimed this occurrence. */
  matched: boolean
  /** The claimed persistent result, if any. */
  result: ToolBlock | null
}

/**
 * Serialize-time index over every assistant toolCall occurrence plus the live
 * turn's ordinal: occurrence→result pairing, per-rawId occurrence ordinals
 * (stable instance ids) and the live ordinal (live tool state may only attach
 * to that turn's occurrence — or the latest one when no live turn is
 * streaming). Rebuilt on every serialize.
 */
type ToolIndex = {
  occurrences: Map<string, ToolOccurrence>
  byRawId: Map<string, ToolOccurrence[]>
  rawIdOrdinals: Map<string, number[]>
  liveOrdinal: number | null
}

/**
 * FIFO execution queue for one raw toolCallId inside the CURRENT live turn.
 * ids are the stable UI instance ids (generated with the exact same helper as
 * serialize) of every occurrence of the raw id in the live message content,
 * in content order; tool_execution_start claims the next not-yet-started id
 * (claimed ids always form a prefix), update/end target the earliest running
 * one — or, arriving before any start, claim (consume) the first unconsumed
 * occurrence and advance the cursor past it so the following start never
 * re-claims it. Cleared together with liveTools.
 */
type LiveToolQueue = {
  ids: string[]
  /** Index of the next id tool_execution_start must claim (FIFO). */
  nextStart: number
}

/**
 * Canonicalizes `path` even when trailing segments do not exist yet: the nearest
 * existing ancestor is realpath'd and the missing suffix is re-appended. Throws
 * only if no ancestor at all can be resolved.
 */
export const canonicalizeEvenIfMissing = (path: string): string => {
  let current = resolve(path)
  const missing: string[] = []
  for (;;) {
    try { return missing.length === 0 ? realpathSync(current) : resolve(realpathSync(current), ...missing) }
    catch {
      const parent = dirname(current)
      if (parent === current) throw new Error(`Cannot canonicalize path: ${path}`)
      missing.unshift(basename(current))
      current = parent
    }
  }
}

export class PiRuntime {
  constructor(private readonly options: { cleanupTimeoutMs?: number } = {}) {}

  private window: BrowserWindow | null = null
  /**
   * Current tool-approval policy, memory only. 'ask' until main injects the
   * persisted store value (setToolApprovalMode); main coordinates the store
   * writes and the native ask→managed confirmation, so a persist failure can
   * never leave this in a mode the store did not durably accept.
   */
  private approvalMode: ToolApprovalMode = 'ask'
  private workspace: WorkspaceInfo | null = null
  private session: AgentSession | null = null
  private unsubscribe: (() => void) | null = null
  private modelRuntime: ModelRuntime | null = null
  private models: ModelInfo[] = []
  private sessions: SessionListItem[] = []
  private runState: RunState = 'idle'
  private statusText = 'Ready'
  private lastError: AppSnapshot['error'] = null
  /** Local settings-scope error; lives apart from the run/session lastError. */
  private settingsError: AppError | null = null
  private queueCount = 0
  /**
   * Live tool execution state, occurrence-level: keyed by the stable UI
   * instance id of ONE toolCall occurrence (the exact id serialize computes
   * via toolCallInstanceId), never by the raw toolCallId — so a raw id
   * repeated inside one assistant keeps one independent card per occurrence.
   * Entries created without any matching occurrence hold the bare raw id
   * (detached). Cleared together with liveQueues.
   */
  private liveTools = new Map<string, ToolBlock>()
  /**
   * Per-rawId FIFO execution queues over the current live turn's occurrences
   * (see LiveToolQueue). SDK tool events carry only the raw toolCallId, so
   * repeated ids inside one assistant need an explicit queue to route
   * start/update/end onto distinct occurrence cards.
   */
  private liveQueues = new Map<string, LiveToolQueue>()
  /** Bumped whenever the active session is torn down; stale async work checks it. */
  private epoch = 0
  /** Serializes workspace/session mutations so they cannot interleave. */
  private opChain: Promise<unknown> = Promise.resolve()
  /**
   * Per-session tracking of non-streaming fire-and-forget runs: the preflight
   * barrier (settles on preflight accept/reject, run settle, or sync/async
   * reject) and the run promise. Mutations and teardown wait on the barriers so
   * a preflight can never start a run after the session has been aborted or
   * disposed. Each prompt adds its own entry; a run removes exactly itself and
   * the key disappears once its set is empty.
   */
  private activeRuns = new Map<AgentSession, Set<ActiveRun>>()
  /** Sessions currently being aborted or torn down: new prompts are refused. */
  private closingSessions = new WeakSet<AgentSession>()
  /**
   * Outstanding closing intents per session: abort() takes one synchronously
   * before enqueueing and releases it in its own finally, so overlapping
   * aborts keep the session closed until the LAST one settles, while
   * dispose/mutation marks are permanent and never released.
   */
  private closingCounts = new WeakMap<AgentSession, number>()
  /** True when the workspace restore had to skip an unopenable persisted session. */
  private skippedRestore = false
  /**
   * Display-name overrides for sessions whose JSONL is not yet on disk (an
   * empty session never persists until the first assistant message, so a
   * `/name` on it would otherwise be lost). Keyed by canonical session path;
   * entries survive until that session is deleted.
   */
  private sessionNameOverrides = new Map<string, string>()
  /**
   * Live assistant turn (message_start..message_end). Cleared at
   * agent_settled, abort, dispose and session switches.
   */
  private liveAssistant: LiveAssistant | null = null
  /** Pending trailing flush for high-frequency message_update events. */
  private liveFlushTimer: ReturnType<typeof setTimeout> | null = null
  private liveFallbackSeq = 0
  /** Monotonic time the current live turn started (message_start); per-turn and per-session. */
  private turnStartedAt: number | null = null
  /** Monotonic time of the first streamed content character; drives TTFT. */
  private firstContentAt: number | null = null
  private telemetryRate: number | null = null
  private telemetryRateKind: TelemetryInfo['tokenRateKind'] = 'unavailable'
  private ttftMs: number | null = null
  private latestOutputTokens: number | null = null
  /**
   * Exact credential values submitted to the SDK this session (runtime API
   * keys), in memory only. Redaction targets for any error text that reaches
   * the snapshot or console; a provider's entries are forgotten on logout.
   */
  private knownSecrets = new Set<string>()
  private knownSecretsByProvider = new Map<string, Set<string>>()

  private get cleanupTimeoutMs(): number { return this.options.cleanupTimeoutMs ?? RUN_CLEANUP_TIMEOUT_MS }

  private markClosing(session: AgentSession): void {
    this.closingSessions.add(session)
    this.closingCounts.set(session, (this.closingCounts.get(session) ?? 0) + 1)
  }
  private unmarkClosing(session: AgentSession): void {
    const count = (this.closingCounts.get(session) ?? 1) - 1
    if (count <= 0) { this.closingCounts.delete(session); this.closingSessions.delete(session) }
    else this.closingCounts.set(session, count)
  }

  setWindow(window: BrowserWindow): void { this.window = window }

  /** Current tool-approval policy; the approval extension reads it live at every tool_call. */
  getToolApprovalMode(): ToolApprovalMode {
    return this.approvalMode
  }

  /**
   * Switches the in-memory policy only — main coordinates the persisted store
   * and the native ask→managed confirmation, and only calls this after the
   * store write durably succeeded. Idempotent: switching to the same mode is
   * a no-op (no redundant snapshot emit).
   */
  setToolApprovalMode(mode: ToolApprovalMode): void {
    if (mode === this.approvalMode) return
    this.approvalMode = mode
    this.emit()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(operation, operation)
    this.opChain = run.then(() => undefined, () => undefined)
    return run
  }

  private dialogWindow(): BrowserWindow | undefined {
    return this.window && !this.window.isDestroyed() ? this.window : undefined
  }

  private recordError(message: string, error: unknown): void {
    // Raw errors may embed credentials; only sanitized text ever reaches the snapshot.
    this.lastError = { message, detail: sanitizeErrorText(error, '', this.knownSecrets), recoverable: true }
    this.statusText = message
    this.runState = 'error'
    // A failed turn without a final must never keep partial measurements.
    this.invalidateTelemetry()
    this.flushNow()
  }

  private isInside(child: string, parent: string): boolean {
    const rel = relative(parent, child)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }

  private async validateWorkspacePath(input: string): Promise<string> {
    const fullPath = canonicalizeEvenIfMissing(resolve(input))
    const info = await stat(fullPath).catch(() => null)
    if (!info?.isDirectory()) throw new Error('Workspace must be a directory')
    const agentRoot = canonicalizeEvenIfMissing(getAgentDir())
    if (this.isInside(fullPath, agentRoot)) throw new Error('Refusing to use the Pi config directory as a workspace')
    return fullPath
  }

  async initialize(cwd = process.cwd()): Promise<AppSnapshot> {
    try {
      this.modelRuntime ??= await ModelRuntime.create()
      await this.setWorkspace(cwd)
      // A skipped-session restore error is recoverable and stays in the snapshot.
      if (!this.skippedRestore) {
        this.lastError = null
        this.statusText = 'Ready'
      }
    } catch (error) {
      this.recordError('Initialization failed', error)
    }
    this.emit()
    return this.snapshot()
  }

  chooseWorkspace(): Promise<AppSnapshot> {
    return this.enqueue(async () => {
      try {
        const win = this.dialogWindow()
        const options: OpenDialogOptions = { title: 'Open a project', properties: ['openDirectory', 'createDirectory'] }
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options)
        if (!result.canceled && result.filePaths[0]) await this.setWorkspace(result.filePaths[0])
      } catch (error) { this.recordError('Failed to open workspace', error) }
    }).then(() => this.snapshot())
  }

  openWorkspace(path: string): Promise<AppSnapshot> {
    return this.enqueue(async () => {
      try { await this.setWorkspace(path) }
      catch (error) { this.recordError('Failed to open workspace', error) }
    }).then(() => this.snapshot())
  }

  private async setWorkspace(path: string): Promise<void> {
    const fullPath = await this.validateWorkspacePath(path)
    this.workspace = { path: fullPath, name: basename(fullPath) || fullPath }
    this.skippedRestore = false
    await this.disposeSession()
    await this.reloadModels()
    await this.refreshSessions()
    // Restore the most recent persisted session (list is sorted by modifiedAt desc)
    // through the exact same verified-open protocol as openSession.
    const first = this.sessions[0]
    if (first) {
      await this.openVerifiedSession(first.path, true)
      return
    }
    await this.createSession(SessionManager.create(fullPath))
  }

  /**
   * Shared verified-open protocol used by openSession and workspace restore:
   * allowlist + session-root + lstat/realpath checks, re-verified immediately
   * before SessionManager.open, with the active sessionFile re-checked after
   * creation. With `fallbackCreate` (restore), any failure abandons the
   * candidate, starts a fresh empty session and keeps a recoverable error.
   */
  private async openVerifiedSession(path: string, fallbackCreate: boolean): Promise<void> {
    const workspace = this.workspace
    if (!workspace) throw new Error('Choose a workspace first')
    try {
      const verified = this.verifySessionPath(path)
      const rechecked = this.verifySessionPath(path) // TOCTOU: re-verify immediately before opening
      if (rechecked !== verified) throw new Error('Session changed while opening')
      const opened = await this.createSession(SessionManager.open(verified, undefined, workspace.path))
      // Fail closed: the opened session must report the exact verified file — a
      // non-empty sessionFile whose canonical realpath matches. undefined or
      // null means the SDK never bound the candidate to a real file: abandon it
      // immediately and never return success.
      const openedFile = opened?.sessionFile
      if (typeof openedFile !== 'string' || openedFile === '' || canonicalizeEvenIfMissing(openedFile) !== verified) {
        if (opened) await this.disposeSession()
        throw new Error('Opened session does not match the requested file')
      }
    } catch (error) {
      if (!fallbackCreate) throw error
      this.skippedRestore = true
      await this.createSession(SessionManager.create(workspace.path))
      this.lastError = { message: 'Skipped unopenable session', detail: sanitizeErrorText(error, '', this.knownSecrets), recoverable: true }
      this.statusText = 'Skipped unopenable session'
      this.emit()
    }
  }

  private approvalExtension(): InlineExtension {
    return (pi) => {
      pi.on('tool_call', async (event) => {
        if (!APPROVAL_TOOLS.has(event.toolName)) return undefined
        // Read the CURRENT mode at every tool_call: a dynamic switch affects
        // the very next call, while a dialog already awaiting keeps its own
        // user verdict (never silently allowed by a mode flip).
        if (this.getToolApprovalMode() === 'managed') return undefined
        const action = event.toolName === 'bash' && typeof event.input.command === 'string'
          ? event.input.command : clip(event.input, 1600)
        const win = this.dialogWindow()
        const options: MessageBoxOptions = {
          type: 'warning', title: `Allow ${event.toolName}?`,
          message: `Pi wants to use ${event.toolName}`, detail: action,
          buttons: ['Allow once', 'Deny'], defaultId: 1, cancelId: 1, noLink: true,
        }
        const result = win
          ? await dialog.showMessageBox(win, options)
          : await dialog.showMessageBox(options)
        return result.response === 0 ? undefined : { block: true, reason: 'Denied by user' }
      })
    }
  }

  private async createSession(manager: SessionManager): Promise<AgentSession | null> {
    await this.disposeSession()
    const myEpoch = this.epoch
    if (!this.workspace || !this.modelRuntime) return null
    const loader = new DefaultResourceLoader({
      cwd: this.workspace.path, agentDir: getAgentDir(), extensionFactories: [this.approvalExtension()],
      // User extensions / skills / prompt templates are loaded (they power
      // the dynamic slash-command menu); themes stay disabled because the
      // GUI ships its own theme system.
      noExtensions: false, noSkills: false, noPromptTemplates: false, noThemes: true,
    })
    await loader.reload()
    if (myEpoch !== this.epoch) return null
    const result = await createAgentSession({
      cwd: this.workspace.path, modelRuntime: this.modelRuntime, sessionManager: manager,
      resourceLoader: loader, tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'],
    })
    if (myEpoch !== this.epoch) { await this.abandonSession(result.session); return null }
    const session = result.session
    try {
      await session.bindExtensions({
        onError: (error: ExtensionError) => {
          if (this.session !== session) return // stale extension errors must not touch current state
          this.lastError = { message: `Extension error (${error.extensionPath})`, detail: sanitizeErrorText(error.error, '', this.knownSecrets), recoverable: true }
          this.emit()
        },
      })
      if (myEpoch !== this.epoch) { await this.abandonSession(session); return null }
      this.unsubscribe = session.subscribe((event) => {
        if (this.session !== session) return // stale session events must not touch current state
        this.handleEvent(event)
      })
      // Promote the candidate only after binding and subscription succeeded; a
      // failure above never leaves an unapproved session behind.
      this.session = session
      this.restoreHistoryTelemetry()
      this.runState = 'idle'
      this.statusText = 'Ready'
      this.lastError = result.modelFallbackMessage
        ? { message: 'Model fallback', detail: result.modelFallbackMessage, recoverable: true } : null
      this.emit()
      return session
    } catch (error) {
      await this.abandonSession(session)
      throw error
    }
  }

  /** Tears a session candidate down without touching current runtime state. */
  private async abandonSession(session: AgentSession): Promise<void> {
    this.markClosing(session)
    try { await this.teardownSession(session, { recordTimeout: false }) } catch { /* tearing down */ }
    session.dispose()
  }

  /**
   * Bounded wait: resolves with the settled results (allSettled, so rejections
   * are captured and never become unhandled) or null on timeout. The timeout
   * timer is unref'd and always cleared; the race never leaves a stray rejection.
   */
  private async waitBounded(promises: Promise<unknown>[], ms: number): Promise<PromiseSettledResult<unknown>[] | null> {
    if (promises.length === 0) return []
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms)
      timer.unref?.()
    })
    try {
      return await Promise.race([Promise.allSettled(promises), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private recordCleanupTimeout(): void {
    this.recordError('Run cleanup timed out', new Error(`Timed out after ${this.cleanupTimeoutMs}ms waiting for a run to settle`))
  }

  /**
   * Serialized teardown protocol shared by abort(), disposeSession() and
   * abandonSession() so SDK clearQueue/abort/dispose calls never overlap:
   * bounded preflight-barrier wait, queue clear + abort, bounded run wait —
   * looping over snapshots so runs appearing during cleanup are never missed.
   * A wedged preflight/run hits the cleanup timeout: the queue is cleared and
   * aborted again, one last bounded run wait follows, then teardown gives up so
   * dispose/exit can never hang.
   */
  private async teardownSession(session: AgentSession, opts: { recordTimeout?: boolean } = {}): Promise<void> {
    const timeout = this.cleanupTimeoutMs
    const onTimeout = (): void => {
      if (opts.recordTimeout) this.recordCleanupTimeout()
      else console.error('Run cleanup timed out; forcing abort')
    }
    // Every SDK abort call is itself bounded: a rejecting or wedged abort can
    // neither leak an unhandled rejection (allSettled captures it) nor stall
    // teardown. The first captured failure is rethrown once the remaining
    // clear/wait/dispose steps are done so abort() still records it.
    let abortFailure: { error: unknown } | null = null
    const boundedAbort = async (): Promise<{ error: unknown } | null> => {
      const outcome = await this.waitBounded([session.abort()], timeout)
      if (outcome === null) { onTimeout(); return null } // wedged abort: captured, move on
      const failed = outcome.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      return failed ? { error: failed.reason } : null
    }
    let looped = false
    for (;;) {
      const snapshot = [...(this.activeRuns.get(session) ?? [])]
      if (snapshot.length === 0) break
      looped = true
      // A barrier settles on preflight accept/reject, run settle, or sync/async
      // reject; a provider auth/preflight that never settles hits the timeout.
      if (!(await this.waitBounded(snapshot.map((run) => run.barrier), timeout))) {
        onTimeout()
        // Barriers wedged: force the abort, do one bounded run wait, give up.
        session.clearQueue()
        abortFailure ??= await boundedAbort()
        await this.waitBounded(snapshot.map((run) => run.run), timeout)
        break
      }
      // All preflights settled: nothing can start a run behind this abort now.
      session.clearQueue()
      abortFailure ??= await boundedAbort()
      if (!(await this.waitBounded(snapshot.map((run) => run.run), timeout))) {
        onTimeout()
        // Timeout escape: one forced re-abort (also bounded) and one last
        // bounded run wait.
        session.clearQueue()
        abortFailure ??= await boundedAbort()
        await this.waitBounded(snapshot.map((run) => run.run), timeout)
        break
      }
      // Everything in this snapshot settled; re-snapshot so runs that appeared
      // during this pass are covered too.
    }
    if (!looped) {
      // No tracked runs: still clear the queue and abort (the SDK may hold
      // untracked streaming/followUp work).
      session.clearQueue()
      abortFailure ??= await boundedAbort()
    }
    if (abortFailure) throw abortFailure.error
  }

  newSession(): Promise<AppSnapshot> {
    return this.enqueue(async () => {
      try {
        if (!this.workspace) throw new Error('Choose a workspace first')
        await this.createSession(SessionManager.create(this.workspace.path))
        await this.refreshSessions()
      } catch (error) { this.recordError('Failed to create session', error) }
    }).then(() => this.snapshot())
  }

  openSession(path: string): Promise<AppSnapshot> {
    return this.enqueue(async () => {
      try {
        if (!this.workspace) throw new Error('Choose a workspace first')
        // The active empty session has no JSONL on disk yet; opening it is a no-op.
        if (path === this.activePath()) return
        await this.openVerifiedSession(path, false)
      } catch (error) { this.recordError('Failed to open session', error) }
    }).then(() => this.snapshot())
  }

  /**
   * Deletes a persisted session after the same path verification as opening
   * (allowlist + session root + canonical identity), so no file outside the
   * workspace's own session directory can ever be removed. Deleting the ACTIVE
   * session tears the live session down first (bounded teardown, same protocol
   * as workspace switches) and replaces it with a fresh empty one; deleting an
   * inactive session only removes its JSONL. The sidebar refreshes either way.
   */
  deleteSession(path: string): Promise<AppSnapshot> {
    return this.enqueue(async () => {
      try {
        if (!this.workspace) throw new Error('Choose a workspace first')
        const canonical = this.verifySessionPath(path)
        const active = this.activePath()
        const isActive = active !== null && canonicalizeEvenIfMissing(active) === canonical
        unlinkSync(canonical)
        this.sessionNameOverrides.delete(canonical)
        if (isActive) {
          await this.disposeSession()
          await this.createSession(SessionManager.create(this.workspace.path))
        }
        await this.refreshSessions()
      } catch (error) { this.recordError('Failed to delete session', error) }
    }).then(() => this.snapshot())
  }

  /**
   * Verifies that `path` is a regular, non-symlink file whose canonical path is
   * both listed in the sessions allowlist and inside the workspace's canonical
   * session directory. Returns the canonical path.
   */
  private verifySessionPath(path: string): string {
    const workspace = this.workspace
    if (!workspace) throw new Error('Choose a workspace first')
    const target = resolve(path)
    const info = lstatSync(target)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Session must be a regular file')
    const canonical = canonicalizeEvenIfMissing(target)
    const allowed = this.sessions.some((item) => canonicalizeEvenIfMissing(resolve(item.path)) === canonical)
    if (!allowed) throw new Error('Session does not belong to this workspace')
    const sessionDir = canonicalizeEvenIfMissing(SessionManager.create(workspace.path).getSessionDir())
    if (!this.isInside(canonical, sessionDir)) throw new Error('Session does not belong to this workspace')
    return canonical
  }

  prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    const promptText = text.trim()
    const hasImages = images !== undefined && images.length > 0
    if (!promptText && !hasImages) return Promise.resolve()
    const session = this.session
    const epoch = this.epoch
    if (!session) { this.recordError('No active session', new Error('Choose a workspace first')); return Promise.resolve() }
    if (this.closingSessions.has(session)) {
      // The session is being aborted or torn down: refuse the prompt entirely.
      this.recordError('Session is closing', new Error('The session is closing; try again in a moment'))
      return Promise.resolve()
    }
    this.lastError = null
    const fail = (error: unknown): void => {
      if (this.session === session && this.epoch === epoch) this.recordError('Run failed', error)
    }
    // Attachments become SDK image content parts (base64 payload + mime type).
    const attached: { type: 'image'; data: string; mimeType: string }[] | undefined = images && images.length > 0
      ? images.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }))
      : undefined
    const promptOptions = (): { images?: { type: 'image'; data: string; mimeType: string }[]; streamingBehavior?: 'steer' | 'followUp'; preflightResult?: (success: boolean) => void } => {
      const options: { images?: { type: 'image'; data: string; mimeType: string }[]; streamingBehavior?: 'steer' | 'followUp'; preflightResult?: (success: boolean) => void } = {}
      if (attached) options.images = attached
      return options
    }
    if (session.isStreaming) {
      return session.prompt(promptText, { ...promptOptions(), streamingBehavior: 'followUp' }).catch(fail)
    }
    // Non-streaming runs pass a preflight phase before the run actually starts.
    // The returned promise settles at preflight accept/reject, never with the
    // whole run; the same barrier gates abort()/dispose so a preflight can never
    // start a run on a session that is being torn down.
    let resolveBarrier!: () => void
    let rejectBarrier!: (error: unknown) => void
    const barrier = new Promise<unknown>((resolve, reject) => {
      resolveBarrier = () => resolve(undefined)
      rejectBarrier = (error: unknown) => reject(error)
    })
    void barrier.catch(() => undefined) // a rejected barrier must not become an unhandled rejection
    let barrierSettled = false
    const settleBarrier = (settle: () => void): void => {
      if (barrierSettled) return
      barrierSettled = true
      settle()
    }
    let run: Promise<unknown>
    try {
      run = session.prompt(promptText, {
        ...promptOptions(),
        preflightResult: (success: boolean) => {
          if (success && this.closingSessions.has(session)) {
            // The session started closing while the preflight was pending:
            // refuse the run so teardown is not held up; teardown's abort
            // settles any run the SDK may still start.
            settleBarrier(() => rejectBarrier(new Error('Session is closing')))
            return
          }
          if (success) settleBarrier(resolveBarrier)
          else settleBarrier(() => rejectBarrier(new Error('Prompt preflight rejected')))
        },
      })
    } catch (error) {
      settleBarrier(() => rejectBarrier(error))
      fail(error)
      return barrier.then(() => undefined, () => undefined)
    }
    const tracked: ActiveRun = { session, epoch, barrier, run }
    let runs = this.activeRuns.get(session)
    if (!runs) { runs = new Set(); this.activeRuns.set(session, runs) }
    runs.add(tracked)
    const settled = (): void => {
      // Remove only the exact entry; newer runs on the same session must survive.
      const set = this.activeRuns.get(session)
      if (!set) return
      set.delete(tracked)
      if (set.size === 0) this.activeRuns.delete(session)
    }
    run.then(
      () => { settleBarrier(resolveBarrier); settled() },
      (error: unknown) => { settleBarrier(() => rejectBarrier(error)); settled(); fail(error) },
    )
    return barrier.then(() => undefined, () => undefined)
  }

  /**
   * Aborts through the same serialized opChain as every other mutation so SDK
   * abort/clear/dispose calls can never overlap. Captures session+epoch and
   * marks the session closing synchronously, BEFORE enqueueing, so a prompt in
   * the same tick is refused immediately. The closing intent is released only
   * in this exact abort's finally, and only while the same session is still
   * current: dispose/mutation keeps its permanent closing mark, and an
   * overlapping abort keeps the session closed until its own finally.
   */
  abort(): Promise<void> {
    const session = this.session
    const epoch = this.epoch
    if (session) this.markClosing(session)
    // An aborted turn must never keep streaming: drop the live cache, all
    // live tool state and any pending throttled flush before teardown starts.
    this.clearLiveState()
    // An aborted turn must never keep partial measurements.
    this.invalidateTelemetry()
    // The renderer must drop the old running/pending live cards immediately,
    // not only after teardown settles — but only while the captured session
    // is still current, so a stale abort can never emit for a newer session
    // and a still-pending flush never double-emits.
    if (this.session === session && this.epoch === epoch) this.emit()
    return this.enqueue(async () => {
      try {
        if (!session || this.session !== session || this.epoch !== epoch) return
        await this.teardownSession(session, { recordTimeout: true })
      } catch (error) {
        // Only record the failure if the captured session is still current.
        if (this.session === session && this.epoch === epoch) this.recordError('Abort failed', error)
      } finally {
        if (session && this.session === session && this.epoch === epoch) this.unmarkClosing(session)
      }
    })
  }

  setModel(provider: string, id: string): Promise<AppSnapshot> {
    return this.enqueue(async () => {
      try {
        const model = this.modelRuntime?.getModel(provider, id)
        if (!model || !this.session) throw new Error('Model is unavailable')
        await this.session.setModel(model)
        this.emit()
      } catch (error) { this.recordError('Failed to switch model', error) }
    }).then(() => this.snapshot())
  }

  setThinking(level: ThinkingLevel): Promise<AppSnapshot> {
    return this.enqueue(async () => {
      try {
        this.session?.setThinkingLevel(level)
        this.emit()
      } catch (error) { this.recordError('Failed to set thinking level', error) }
    }).then(() => this.snapshot())
  }

  getSettings(): Promise<SettingsSnapshot> {
    // A successful read clears any previous settings error; a failing read
    // below replaces it with the fixed sanitized message.
    this.settingsError = null
    return this.settingsSnapshot()
  }

  updateSettings(patch: SettingsPatch): Promise<SettingsSnapshot> {
    return this.enqueue(async () => {
      try {
        this.validateSettingsPatch(patch)
        const sm = this.session?.settingsManager ?? null
        if (sm) {
          // validateSettingsPatch has already rejected nulls up front; the
          // explicit non-null guards here narrow the `string | null` patch
          // type so a null can never reach an SDK setter.
          const provider = patch.defaultProvider
          const model = patch.defaultModel
          if (provider !== undefined && provider !== null && model !== undefined && model !== null) {
            sm.setDefaultModelAndProvider(provider, model)
          } else {
            if (provider !== undefined && provider !== null) sm.setDefaultProvider(provider)
            if (model !== undefined && model !== null) sm.setDefaultModel(model)
          }
          if (patch.defaultThinkingLevel !== undefined) sm.setDefaultThinkingLevel(patch.defaultThinkingLevel)
          if (patch.compactionEnabled !== undefined) sm.setCompactionEnabled(patch.compactionEnabled)
          if (patch.retryEnabled !== undefined) sm.setRetryEnabled(patch.retryEnabled)
          if (patch.httpIdleTimeoutMs !== undefined) sm.setHttpIdleTimeoutMs(patch.httpIdleTimeoutMs)
        }
        try { await sm?.flush() } catch { /* persist failures drain below */ }
        // Persist failures surface as ONE fixed sanitized message: raw errors may
        // embed config paths that lead to keys.
        this.settingsError = sm && sm.drainErrors().length > 0
          ? { message: '保存设置失败', recoverable: true }
          : null
      } catch {
        // Validation or persistence failures surface as ONE fixed sanitized
        // message: raw errors may embed provider paths or credentials.
        this.settingsError = { message: '保存设置失败', recoverable: true }
      }
      this.emit()
      return this.settingsSnapshot()
    })
  }

  /**
   * Model-ownership validation for updateSettings: the provider must exist,
   * the model must belong to the effective provider (patched provider or the
   * current default), and a provider change must not strand a model the new
   * provider does not own. null is rejected outright — the SDK setters accept
   * only strings, so clearing is never persisted as '' and provider/model can
   * never become inconsistent.
   */
  private validateSettingsPatch(patch: SettingsPatch): void {
    if (patch.defaultProvider === null) throw new Error('Provider must not be null')
    if (patch.defaultModel === null) throw new Error('Model must not be null')
    if (patch.defaultProvider === undefined && patch.defaultModel === undefined) return
    const runtime = this.modelRuntime
    if (!runtime) throw new Error('Model runtime unavailable')
    const sm = this.session?.settingsManager ?? null
    const patchProvider = patch.defaultProvider
    if (patchProvider !== undefined && !runtime.getProviders().some((p) => p.id === patchProvider)) {
      throw new Error('Provider not found')
    }
    const effectiveProvider = patchProvider ?? sm?.getDefaultProvider()
    if (patch.defaultModel !== undefined) {
      if (!effectiveProvider || !runtime.getModel(effectiveProvider, patch.defaultModel)) {
        throw new Error('Model does not belong to the provider')
      }
    } else if (patchProvider !== undefined) {
      // Provider change without a model: the current model must belong to the
      // new provider or the persisted pair would be inconsistent.
      const currentModel = sm?.getDefaultModel()
      if (currentModel && !runtime.getModel(patchProvider, currentModel)) {
        throw new Error('Model does not belong to the provider')
      }
    }
  }

  setRuntimeApiKey(provider: string, key: string): Promise<SettingsSnapshot> {
    return this.enqueue(async () => {
      try {
        const runtime = this.modelRuntime
        if (!runtime || !runtime.getProviders().some((p) => p.id === provider)) throw new Error('Provider not found')
        // Register the key as a known secret BEFORE the SDK call so any later
        // error text mentioning it is scrubbed, whatever the SDK does.
        this.rememberSecret(provider, key)
        await runtime.setRuntimeApiKey(provider, key)
        await this.reloadModels()
        this.settingsError = null
      } catch {
        // Fixed text only: the raw error or the key itself must never reach the snapshot.
        this.settingsError = { message: '设置 API Key 失败', recoverable: true }
      }
      this.emit()
      return this.settingsSnapshot()
    })
  }

  logoutProvider(provider: string): Promise<SettingsSnapshot> {
    return this.enqueue(async () => {
      try {
        const runtime = this.modelRuntime
        if (!runtime || !runtime.getProviders().some((p) => p.id === provider)) throw new Error('Provider not found')
        await runtime.removeRuntimeApiKey(provider)
        await runtime.logout(provider)
        // The provider's credentials are gone: forget its known secrets and
        // reload the local catalog. No extra network refresh here — public
        // refreshModels is the only network-forced path.
        this.forgetSecrets(provider)
        await this.reloadModels()
        this.settingsError = null
      } catch {
        this.settingsError = { message: '退出登录失败', recoverable: true }
      }
      this.emit()
      return this.settingsSnapshot()
    })
  }

  /**
   * Adds (or replaces) a custom provider in the agent's models.json, keeping
   * every existing provider entry intact, then reloads the model catalog from
   * disk. The write is atomic (tmp file + rename) so a crash can never leave
   * a truncated models.json; the tmp suffix is excluded from loading by the
   * config loader's file scan. The API key is written only when provided;
   * otherwise the provider falls back to env/runtime keys.
   */
  addCustomProvider(config: CustomProviderConfig): Promise<SettingsSnapshot> {
    return this.enqueue(async () => {
      try {
        const modelsPath = join(getAgentDir(), 'models.json')
        let data: { providers?: Record<string, unknown> } = {}
        try {
          const raw = readFileSync(modelsPath, 'utf8')
          const parsed: unknown = JSON.parse(raw)
          if (isPlainObject(parsed)) data = parsed as { providers?: Record<string, unknown> }
        } catch {
          // Missing or corrupt models.json: start from an empty config. The
          // corrupt file is replaced, never merged into.
          data = {}
        }
        const providers: Record<string, unknown> = isPlainObject(data.providers) ? data.providers : {}
        providers[config.id] = {
          name: config.name && config.name !== config.id ? config.name : undefined,
          baseUrl: config.baseUrl,
          api: config.api,
          apiKey: config.apiKey && config.apiKey.length > 0 ? config.apiKey : undefined,
          models: config.models.map((m) => ({
            id: m.id,
            name: m.name && m.name !== m.id ? m.name : undefined,
            input: m.input && m.input.length > 0 ? m.input : undefined,
            contextWindow: m.contextWindow,
          })),
        }
        const tmpPath = `${modelsPath}.tmp`
        writeFileSync(tmpPath, JSON.stringify({ ...data, providers }, null, 2))
        renameSync(tmpPath, modelsPath)
        // Reload models.json + rebuild the provider catalog WITHOUT any network
        // round-trip: custom providers are local config, and the models-store
        // refresh below re-reads exactly what was just written.
        const runtime = this.modelRuntime
        if (!runtime) throw new Error('Model runtime unavailable')
        const result = await runtime.refresh({ allowNetwork: false })
        await this.reloadModels()
        if (result.errors.size > 0) throw new Error('Model refresh failed')
        this.settingsError = null
      } catch {
        // Fixed text only: the raw error may embed config paths or the payload.
        this.settingsError = { message: '添加自定义提供商失败', recoverable: true }
      }
      this.emit()
      return this.settingsSnapshot()
    })
  }

  /**
   * Slash-command support: session-level operations wired to the SDK, shared
   * by the composer's `/` menu. Each runs through the same serialized opChain
   * as every other mutation so they can never overlap a prompt/abort.
   */

  /** `/name <name>`: set the display name of the active session. */
  renameSession(name: string): Promise<AppSnapshot> {
    return this.enqueue(async () => {
      try {
        const session = this.session
        if (!session) throw new Error('No active session')
        const trimmed = name.trim()
        if (trimmed === '' || trimmed.length > 128) throw new Error('Invalid session name')
        session.setSessionName(trimmed)
        const path = this.activePath()
        // Remember the name in memory too: an empty session has no JSONL yet
        // (the SDK persists only once an assistant message exists), so the
        // sidebar would otherwise keep showing the placeholder.
        if (path) this.sessionNameOverrides.set(canonicalizeEvenIfMissing(path), trimmed)
        await this.refreshSessions()
      } catch (error) { this.recordError('Failed to rename session', error) }
    }).then(() => this.snapshot())
  }

  /** `/compact [prompt]`: manually compact the active session context. */
  compactSession(customInstructions?: string): Promise<AppSnapshot> {
    return this.enqueue(async () => {
      try {
        const session = this.session
        if (!session) throw new Error('No active session')
        const instructions = customInstructions?.trim()
        await session.compact(instructions !== undefined && instructions !== '' ? instructions : undefined)
      } catch (error) { this.recordError('Compaction failed', error) }
    }).then(() => this.snapshot())
  }

  /** `/copy`: copy the last assistant message text to the system clipboard. */
  copyLastMessage(): Promise<boolean> {
    const text = this.session?.getLastAssistantText() ?? null
    if (!text) return Promise.resolve(false)
    clipboard.writeText(text)
    return Promise.resolve(true)
  }

  /** `/export`: save the active session as JSONL via a native save dialog. */
  exportSession(): Promise<string | null> {
    return this.enqueue(async () => {
      const session = this.session
      if (!session) return null
      const defaultName = `${(session.sessionManager.getSessionName() ?? 'pi-session').replace(/[^\w\u4e00-\u9fff-]+/g, '-')}.jsonl`
      const options: SaveDialogOptions = {
        title: '导出会话为 JSONL',
        defaultPath: defaultName,
        filters: [{ name: 'JSONL 会话', extensions: ['jsonl'] }],
      }
      const win = this.dialogWindow()
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || result.filePath === undefined) return null
      return session.exportToJsonl(result.filePath)
    })
  }

  /** `/session`: stats of the active session for the info dialog. */
  getSessionStats(): Promise<SessionStatsInfo | null> {
    const session = this.session
    if (!session) return Promise.resolve(null)
    const stats = session.getSessionStats()
    const name = session.sessionManager.getSessionName() ?? null
    return Promise.resolve({
      sessionId: stats.sessionId,
      sessionFile: stats.sessionFile ?? null,
      sessionName: name,
      userMessages: stats.userMessages,
      assistantMessages: stats.assistantMessages,
      toolCalls: stats.toolCalls,
      totalMessages: stats.totalMessages,
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cacheReadTokens: stats.tokens.cacheRead,
      cost: stats.cost,
    })
  }

  /** `/reload`: reload extensions, skills, prompt templates and context files. */
  reloadSession(): Promise<AppSnapshot> {
    return this.enqueue(async () => {
      try {
        const session = this.session
        if (!session) throw new Error('No active session')
        await session.reload()
      } catch (error) { this.recordError('Reload failed', error) }
    }).then(() => this.snapshot())
  }

  /**
   * Slash commands contributed by loaded extensions, prompt templates and
   * skills (the built-in GUI commands live in the renderer). The SDK exposes
   * extension commands, templates and skills through the session's resource
   * loader; each entry maps 1:1 to what `prompt('/name …')` would execute.
   */
  getDynamicCommands(): Promise<DynamicCommand[]> {
    const session = this.session
    if (!session) return Promise.resolve([])
    const out: DynamicCommand[] = []
    try {
      const result = session.resourceLoader.getExtensions()
      for (const extension of result.extensions) {
        for (const [name, command] of extension.commands) {
          if (typeof name !== 'string' || name === '') continue
          out.push({
            name,
            source: 'extension',
            ...(typeof command.description === 'string' ? { description: command.description } : {}),
          })
        }
      }
    } catch { /* loader errors are surfaced in the settings extensions section */ }
    for (const template of session.promptTemplates) {
      if (template.name === '') continue
      out.push({
        name: template.name,
        source: 'prompt',
        ...(template.description ? { description: template.description } : {}),
        ...(template.argumentHint ? { argHint: template.argumentHint } : {}),
      })
    }
    try {
      const skills = session.resourceLoader.getSkills().skills
      for (const skill of skills) {
        if (skill.name === '') continue
        out.push({
          name: `skill:${skill.name}`,
          source: 'skill',
          ...(skill.description ? { description: skill.description } : {}),
        })
      }
    } catch { /* skills unavailable */ }
    return Promise.resolve(out)
  }

  /**
   * Provider connection test for the New-provider form: hits the
   * OpenAI/Anthropic/Google-compatible `…/models` endpoint with the typed
   * API key. Distinguishes auth failures (401/403) from plain HTTP errors
   * and network unreachability; never echoes the key back.
   */
  async testProviderConnection(config: ProviderConnectionTest): Promise<ConnectionTestResult> {
    try {
      const base = config.baseUrl.trim().replace(/\/+$/, '')
      let url: URL
      try {
        url = new URL(`${base}/models`)
      } catch {
        return { ok: false, status: null, kind: 'network' }
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, status: null, kind: 'network' }
      }
      const headers: Record<string, string> = {}
      const key = config.apiKey?.trim()
      if (config.api === 'anthropic-messages') {
        if (key) headers['x-api-key'] = key
        headers['anthropic-version'] = '2023-06-01'
      } else if (config.api === 'google-generative-ai') {
        if (key) url.searchParams.set('key', key)
      } else if (key) {
        headers.Authorization = `Bearer ${key}`
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      try {
        const response = await fetch(url, { headers, signal: controller.signal })
        if (response.ok) return { ok: true, status: response.status, kind: 'ok' }
        if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, kind: 'auth' }
        return { ok: false, status: response.status, kind: 'http' }
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return { ok: false, status: null, kind: 'network' }
    }
  }

  /** Loaded-extension inventory for the Settings extensions section. */
  getExtensions(): Promise<ExtensionsInfo> {
    const session = this.session
    if (!session) return Promise.resolve({ extensions: [], errors: [] })
    try {
      const result = session.resourceLoader.getExtensions()
      // One npm/git package can expose several file entries (e.g. pi-powerbar
      // ships src/*/index.ts); the user installed ONE package, so merge them
      // into a single card. Standalone files (source 'auto') stay one card
      // each, and built-in inline extensions are hidden entirely.
      const bySource = new Map<string, ExtensionInfo>()
      for (const extension of result.extensions) {
        const scope = extension.sourceInfo.scope
        if (scope === 'temporary') continue
        const source = extension.sourceInfo.source
        const isPackage = source.startsWith('npm:') || source.startsWith('git:')
        const key = isPackage ? source : extension.resolvedPath
        const stats = {
          commandCount: extension.commands.size,
          toolCount: extension.tools.size,
          handlerCount: [...extension.handlers.values()].reduce((n, handlers) => n + handlers.length, 0),
        }
        const existing = bySource.get(key)
        if (existing) {
          existing.commandCount += stats.commandCount
          existing.toolCount += stats.toolCount
          existing.handlerCount += stats.handlerCount
          continue
        }
        bySource.set(key, {
          path: extension.path,
          resolvedPath: extension.resolvedPath,
          sourceLabel: scope,
          name: isPackage ? source.slice(4) : this.extensionFileDisplayName(extension.resolvedPath),
          ...stats,
        })
      }
      return Promise.resolve({
        extensions: [...bySource.values()],
        errors: result.errors.map((e) => ({ path: e.path, error: e.error })),
      })
    } catch {
      return Promise.resolve({ extensions: [], errors: [] })
    }
  }

  /** File name without the script suffix, e.g. `~/…/hello.js` → `hello`. */
  private extensionFileDisplayName(resolvedPath: string): string {
    const file = resolvedPath.split(/[\\/]/).pop() ?? resolvedPath
    return file.replace(/\.(js|ts|mjs|cjs)$/i, '')
  }

  /** Registers a submitted runtime API key as a redaction target (memory only). */
  private rememberSecret(provider: string, key: string): void {    this.knownSecrets.add(key)
    let secrets = this.knownSecretsByProvider.get(provider)
    if (!secrets) { secrets = new Set(); this.knownSecretsByProvider.set(provider, secrets) }
    secrets.add(key)
  }

  /**
   * Drops a provider's known secrets once it has logged out. A secret shared
   * by several providers stays a redaction target until the LAST provider
   * using it logs out: only then is it removed from the global set.
   */
  private forgetSecrets(provider: string): void {
    const secrets = this.knownSecretsByProvider.get(provider)
    if (!secrets) return
    for (const secret of secrets) {
      const stillUsedElsewhere = [...this.knownSecretsByProvider.entries()]
        .some(([other, others]) => other !== provider && others.has(secret))
      if (!stillUsedElsewhere) this.knownSecrets.delete(secret)
    }
    this.knownSecretsByProvider.delete(provider)
  }

  refreshModels(): Promise<SettingsSnapshot> {
    return this.enqueue(async () => {
      try {
        await this.refreshModelCatalog()
        this.settingsError = null
      } catch {
        this.settingsError = { message: '刷新模型列表失败', recoverable: true }
      }
      this.emit()
      return this.settingsSnapshot()
    })
  }

  /**
   * Network-forced catalog refresh plus the local models-list reload. Refresh
   * errors are reduced to a single throw: per-provider Error messages may
   * embed credentials, so only the count (or none) is ever surfaced.
   */
  private async refreshModelCatalog(): Promise<void> {
    const result = await this.modelRuntime?.refresh({ allowNetwork: true, force: true })
    await this.reloadModels()
    if (result && result.errors.size > 0) throw new Error('Model refresh failed')
  }

  /**
   * Settings snapshot from the active session's SettingsManager; without a
   * session, safe defaults. Provider discovery failures set the local
   * settingsError to one fixed sanitized message (never the raw error, which
   * may embed config paths or keys). A successful read clears the error.
   */
  private async settingsSnapshot(): Promise<SettingsSnapshot> {
    try {
      const sm = this.session?.settingsManager ?? null
      // EVERY SettingsManager getter (defaults, compaction, retry) runs inside
      // the try: a throwing getter resolves with the fixed sanitized error
      // instead of rejecting past IPC.
      const base = sm ? {
        defaultProvider: sm.getDefaultProvider() ?? null,
        defaultModel: sm.getDefaultModel() ?? null,
        defaultThinkingLevel: sm.getDefaultThinkingLevel() ?? 'medium',
        compactionEnabled: sm.getCompactionEnabled(),
        retryEnabled: sm.getRetryEnabled(),
        httpIdleTimeoutMs: sm.getHttpIdleTimeoutMs(),
        compaction: {
          reserveTokens: numberOrNull(sm.getCompactionSettings().reserveTokens),
          keepRecentTokens: numberOrNull(sm.getCompactionSettings().keepRecentTokens),
        },
        retry: {
          maxRetries: numberOrNull(sm.getRetrySettings().maxRetries),
          baseDelayMs: numberOrNull(sm.getRetrySettings().baseDelayMs),
          // Not part of the SDK's declared getRetrySettings; read defensively, null when absent.
          maxDelayMs: numberOrNull((sm.getRetrySettings() as { maxDelayMs?: unknown }).maxDelayMs),
        },
      } : {
        defaultProvider: null,
        defaultModel: null,
        defaultThinkingLevel: 'medium' as ThinkingLevel,
        compactionEnabled: false,
        retryEnabled: false,
        httpIdleTimeoutMs: DEFAULT_HTTP_IDLE_TIMEOUT_MS,
        compaction: { reserveTokens: null, keepRecentTokens: null } as CompactionConfig,
        retry: { maxRetries: null, baseDelayMs: null, maxDelayMs: null } as RetryConfig,
      }
      const providers = await this.providerStatuses()
      return { ...base, toolApprovalMode: this.getToolApprovalMode(), providers, keyPersistence: 'runtime-only', error: this.settingsError }
    } catch {
      // Fixed text only: raw getter/provider errors (getProviders,
      // getProviderAuthStatus, listCredentials, getAvailable) may embed
      // config paths or credentials and must never reject past IPC.
      this.settingsError = { message: '无法读取模型配置', recoverable: true }
      return {
        providers: [],
        defaultProvider: null,
        defaultModel: null,
        defaultThinkingLevel: 'medium' as ThinkingLevel,
        compactionEnabled: false,
        retryEnabled: false,
        httpIdleTimeoutMs: DEFAULT_HTTP_IDLE_TIMEOUT_MS,
        compaction: { reserveTokens: null, keepRecentTokens: null } as CompactionConfig,
        retry: { maxRetries: null, baseDelayMs: null, maxDelayMs: null } as RetryConfig,
        keyPersistence: 'runtime-only',
        toolApprovalMode: this.getToolApprovalMode(),
        error: this.settingsError,
      }
    }
  }

  /** Provider DTO: identity, auth-source mapping, credential type, available counts. */
  private async providerStatuses(): Promise<ProviderStatus[]> {
    const runtime = this.modelRuntime
    if (!runtime) return []
    const providers = runtime.getProviders()
    const credentials = await runtime.listCredentials()
    const available = await runtime.getAvailable()
    const counts = new Map<string, number>()
    for (const model of available) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1)
    return providers.map((provider) => {
      const status = runtime.getProviderAuthStatus(provider.id)
      const authStatus: ProviderStatus['authStatus'] = !status?.configured ? 'none'
        : status.source === 'stored' ? 'stored'
        : status.source === 'runtime' ? 'runtime'
        : status.source === 'environment' ? 'environment'
        : status.source === 'fallback' ? 'fallback'
        : status.source === 'models_json_key' || status.source === 'models_json_command' ? 'models-json'
        : 'none'
      return {
        id: provider.id,
        name: provider.name || provider.id,
        authStatus,
        authLabel: status?.label ?? null,
        credentialType: credentials.find((c) => c.providerId === provider.id)?.type ?? null,
        availableModelCount: counts.get(provider.id) ?? 0,
      }
    })
  }

  private handleEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'message_start': {
        const message = this.eventMessage(event)
        if (RECORD(message) && message.role === 'assistant') this.beginLiveAssistant(message)
        this.flushNow()
        return
      }
      case 'message_update': {
        const message = this.eventMessage(event)
        if (this.liveAssistant && RECORD(message) && message.role === 'assistant') {
          // The SDK message is cumulative: replace wholesale, never merge deltas.
          this.liveAssistant.message = message
          this.updateLiveTelemetry(message)
          this.scheduleFlush()
        }
        return
      }
      case 'message_end': {
        const message = this.eventMessage(event)
        if (this.liveAssistant && RECORD(message) && message.role === 'assistant') {
          this.liveAssistant.message = message
          this.liveAssistant.streaming = false
          this.finalizeTelemetry(message)
        }
        this.flushNow()
        return
      }
      case 'agent_start': this.runState = 'running'; this.statusText = 'Pi is working…'; break
      case 'agent_settled': {
        // The SDK has appended the final message to session.messages by now;
        // dropping the cached final snapshot AND all live tool state makes
        // serialize rebuild purely from the persisted results.
        this.clearLiveState()
        this.runState = 'idle'; this.statusText = 'Ready'; this.queueCount = 0
        const session = this.session
        const epoch = this.epoch
        void this.refreshSessions().catch((error) => {
          if (this.session === session && this.epoch === epoch) this.recordError('Failed to refresh sessions', error)
        })
        this.flushNow()
        return
      }
      case 'queue_update': this.queueCount = event.steering.length + event.followUp.length; break
      case 'compaction_start': this.runState = 'compacting'; this.statusText = 'Compacting context…'; break
      case 'auto_retry_start': this.runState = 'retrying'; this.statusText = `Retrying (${event.attempt}/${event.maxAttempts})…`; break
      case 'tool_execution_start': {
        // Occurrence-level FIFO: claim the next not-yet-started live
        // occurrence of this raw id, never overwriting a sibling card. A
        // start whose every occurrence is already claimed is a stale
        // duplicate and is dropped.
        const id = this.liveStartTarget(event.toolCallId)
        if (id === null) break
        this.liveTools.set(id, { type: 'tool', id, name: event.toolName, status: 'running', input: clip(event.args) })
        break
      }
      case 'tool_execution_update': {
        const id = this.liveUpdateTarget(event.toolCallId)
        if (id === null) break
        const previous = this.liveTools.get(id)
        // An update can arrive before its start: the target may hold no card
        // yet, so create (or keep) its running block instead of dropping the
        // partial result.
        this.liveTools.set(id, {
          type: 'tool', id, name: previous?.name ?? event.toolName,
          status: previous?.status ?? 'running', input: previous?.input ?? '',
          output: clip(event.partialResult),
        })
        break
      }
      case 'tool_execution_end': {
        const id = this.liveEndTarget(event.toolCallId)
        if (id === null) break
        const previous = this.liveTools.get(id)
        const details = RECORD(event.result) && RECORD(event.result.details) ? event.result.details : null
        const patch = patchOf(details)
        this.liveTools.set(id, {
          type: 'tool', id, name: event.toolName,
          status: event.isError ? 'error' : 'success', input: previous?.input ?? '', output: clip(event.result),
          ...(patch ? { patch } : {}),
        })
        break
      }
    }
    this.emit()
  }

  /**
   * Rebuilds the ToolIndex over session.messages: every assistant toolCall
   * occurrence at its stable position (assistant ordinal + content index),
   * per-rawId occurrence ordinals and the live turn's ordinal. Shared by
   * serialize AND the live tool queues, so the historical occurrence index
   * and live occurrence id generation always come from the same helper and
   * can never drift apart. Rebuilt on every serialize so the merge always
   * reflects the latest session state.
   */
  private buildToolIndex(): ToolIndex {
    const live = this.liveAssistant
    const index: ToolIndex = {
      occurrences: new Map(), byRawId: new Map(), rawIdOrdinals: new Map(),
      liveOrdinal: live?.ordinal ?? null,
    }
    let assistantOrdinal = 0
    for (const [messageIndex, message] of (this.session?.messages ?? []).entries()) {
      if (!RECORD(message) || typeof message.role !== 'string') continue
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
      const ordinal = assistantOrdinal
      assistantOrdinal += 1
      message.content.forEach((part, contentIndex) => {
        if (!RECORD(part) || part.type !== 'toolCall' || typeof part.id !== 'string' || typeof part.name !== 'string') return
        const occurrence: ToolOccurrence = {
          key: `${ordinal}:${contentIndex}`, rawId: part.id, name: part.name,
          args: part.arguments, messageIndex, ordinal, contentIndex, matched: false, result: null,
        }
        index.occurrences.set(occurrence.key, occurrence)
        const sameRaw = index.byRawId.get(part.id)
        if (sameRaw) sameRaw.push(occurrence)
        else index.byRawId.set(part.id, [occurrence])
        const ordinals = index.rawIdOrdinals.get(part.id)
        if (ordinals) ordinals.push(ordinal)
        else index.rawIdOrdinals.set(part.id, [ordinal])
      })
    }
    return index
  }

  private serializeMessages(): ChatMessage[] {
    if (!this.session) return []
    const messages: ChatMessage[] = []
    const live = this.liveAssistant
    // Output index of the assistant serialized at the live turn's locked
    // ordinal; -1 while session.messages has no assistant there yet (the SDK
    // has not appended the current turn).
    let liveCandidate = -1
    let assistantOrdinal = 0
    // Positional index of every assistant toolCall occurrence in
    // session.messages, plus the live turn's ordinal (see ToolIndex). Tool
    // usage stays out of this index so it can never leak into the LLM usage
    // totals.
    const index = this.buildToolIndex()
    // Orphan toolResults (no preceding unmatched same-rawId call), keyed by
    // message index: each keeps its own card.
    const orphans = new Map<number, { rawId: string; block: ToolBlock }>()
    // Pre-scan the message sequence: pair each toolResult with the NEAREST
    // assistant ordinal group of unmatched same-rawId calls — FIFO by content
    // order inside that group — so a raw id reused across turns attaches
    // results to the newest turn first, repeated ids in one assistant pair in
    // source order, and no result is overwritten by a later one.
    this.session.messages.forEach((message, messageIndex) => {
      if (!RECORD(message) || typeof message.role !== 'string') return
      if (message.role === 'toolResult' && typeof message.toolCallId === 'string' && typeof message.toolName === 'string') {
        const candidates = index.byRawId.get(message.toolCallId) ?? []
        let matched: ToolOccurrence | null = null
        // Candidates are sorted in message order, so one assistant's
        // occurrences form a contiguous group. A result pairs to the NEAREST
        // assistant ordinal group first (cross-assistant reuse favors the
        // newest turn) and FIFO by content order within that group (repeated
        // same-turn ids pair in source order).
        let groupEnd = candidates.length
        while (groupEnd > 0 && matched === null) {
          const groupOrdinal = candidates[groupEnd - 1]!.ordinal
          let groupStart = groupEnd - 1
          while (groupStart > 0 && candidates[groupStart - 1]!.ordinal === groupOrdinal) groupStart -= 1
          for (let i = groupStart; i < groupEnd && matched === null; i += 1) {
            const candidate = candidates[i]!
            if (!candidate.matched && candidate.messageIndex < messageIndex) matched = candidate
          }
          groupEnd = groupStart
        }
        if (matched) {
          matched.matched = true
          matched.result = this.toolResultToBlock(message)
        } else {
          orphans.set(messageIndex, { rawId: message.toolCallId, block: this.toolResultToBlock(message) })
        }
      }
    })
    // Orphan instance ids: the plain rawId only when no assistant occurrence
    // shares it anywhere and no earlier orphan took it; otherwise a unique
    // messageIndex-scoped id so repeated rawIds never swallow each other.
    const orphanRawIds = new Set<string>()
    const lastOrphanByRawId = new Map<string, string>()
    for (const [messageIndex, orphan] of orphans) {
      const id = !index.byRawId.has(orphan.rawId) && !orphanRawIds.has(orphan.rawId)
        ? orphan.rawId
        : `orphan-${messageIndex}-${orphan.rawId}`
      orphanRawIds.add(orphan.rawId)
      orphan.block = { ...orphan.block, id }
      lastOrphanByRawId.set(orphan.rawId, id)
    }
    assistantOrdinal = 0
    this.session.messages.forEach((message, messageIndex) => {
      if (!RECORD(message) || typeof message.role !== 'string') return
      const timestamp = typeof message.timestamp === 'number' ? message.timestamp : undefined
      if (message.role === 'user') {
        messages.push({
          id: `user-${messageIndex}-${timestamp ?? 0}`,
          role: 'user',
          blocks: [{ type: 'text', text: textOf(message.content) }, ...imagesOf(message.content)],
          ...(timestamp ? { timestamp } : {}),
        })
        return
      }
      if (message.role === 'assistant') {
        const ordinal = assistantOrdinal
        assistantOrdinal += 1
        // The final appended by the SDK always lands at the live turn's locked
        // ordinal, so it adopts the live stable id: the partial and the final
        // keep one key even when tool results shifted the raw index or the
        // final snapshot gained a timestamp.
        const atLiveOrdinal = live !== null && ordinal === live.ordinal
        const suffix = atLiveOrdinal ? live.stableSuffix : (timestamp ?? 0)
        if (atLiveOrdinal) liveCandidate = messages.length
        messages.push(this.assistantToChatMessage(message, `assistant-${ordinal}-${suffix}`, timestamp, message.stopReason === 'pending', { ordinal, liveTurn: atLiveOrdinal, index }))
        return
      }
      if (message.role === 'toolResult' && typeof message.toolCallId === 'string' && typeof message.toolName === 'string') {
        // A toolResult claimed by an assistant toolCall is already merged into
        // that assistant's card: emit exactly one card per occurrence; only
        // orphans keep their own card.
        const orphan = orphans.get(messageIndex)
        if (!orphan) return
        // Live tool state may only dress up the LATEST orphan of its rawId;
        // older orphan cards keep their persisted result.
        const liveTool = lastOrphanByRawId.get(orphan.rawId) === orphan.block.id ? this.liveTools.get(orphan.rawId) : undefined
        messages.push({ id: `tool-${orphan.block.id}`, role: 'tool', blocks: [liveTool ?? orphan.block], ...(timestamp ? { timestamp } : {}) })
        return
      }
    })
    this.appendLiveAssistant(messages, liveCandidate, index)
    return messages
  }

  /**
   * Persistent ToolBlock for a session toolResult message: content text as
   * output (never the whole message JSON), error flag as status, and the
   * tool's own details patch (details.diff as a compatible fallback) so edit
   * history restores into the right-panel diff list. Input is unknown here;
   * the assistant toolCall merge supplies it from the call arguments.
   */
  private toolResultToBlock(message: Record<string, unknown>): ToolBlock {
    const patch = patchOf(message.details)
    return {
      type: 'tool',
      id: String(message.toolCallId),
      name: String(message.toolName),
      status: message.isError ? 'error' : 'success',
      input: '',
      output: textOf(message.content),
      ...(patch ? { patch } : {}),
    }
  }

  /** Shared assistant block conversion for session messages and live partials. */
  private assistantToChatMessage(
    message: Record<string, unknown>,
    id: string,
    timestamp: number | undefined,
    isStreaming: boolean,
    ctx: { ordinal: number; liveTurn: boolean; index: ToolIndex },
  ): ChatMessage {
    const blocks: MessageBlock[] = []
    if (Array.isArray(message.content)) {
      // Per-message count of already-seen rawIds: content positions are
      // stable, so the instance id of a reused id is deterministic.
      const seenInMessage = new Map<string, number>()
      for (const [contentIndex, part] of message.content.entries()) {
        if (!RECORD(part) || typeof part.type !== 'string') continue
        if (part.type === 'text' && typeof part.text === 'string') blocks.push({ type: 'text', text: part.text })
        // Thinking parts: the SDK emits { type:'thinking', thinking: string }
        // (pi-ai ThinkingContent) — older/other shapes may use `text`. Both
        // are accepted so reasoning is never silently dropped.
        else if (part.type === 'thinking') {
          const thinkingText = typeof part.thinking === 'string' ? part.thinking : typeof part.text === 'string' ? part.text : null
          if (thinkingText !== null) blocks.push({ type: 'thinking', text: thinkingText })
        }
        if (part.type === 'toolCall' && typeof part.id === 'string' && typeof part.name === 'string') {
          blocks.push(this.resolveToolBlock(part.id, part.name, part.arguments, ctx.ordinal, contentIndex, seenInMessage, ctx))
        }
      }
    }
    return { id, role: 'assistant', blocks, ...(timestamp ? { timestamp } : {}), isStreaming }
  }

  /**
   * Tool block merge priority for ONE assistant toolCall occurrence, keyed by
   * its stable position (assistant ordinal + content index), never by raw id
   * alone: live tool state first — but only for the exact occurrence's own
   * instance id, and only while that occurrence is eligible (the current live
   * turn's occurrence, or the latest occurrence of the rawId when no live
   * turn is streaming) — so a reused id can never leak a live card onto older
   * history and repeated same-turn ids never share one state — then the
   * paired persistent toolResult restored from session history (arguments
   * kept as input, content text as output, restored patch), and finally
   * pending while the call belongs to the current live turn, otherwise
   * interrupted (a historical call that never produced a result must never
   * masquerade as pending).
   */
  private resolveToolBlock(
    rawId: string,
    name: string,
    args: unknown,
    ordinal: number,
    contentIndex: number,
    seenInMessage: Map<string, number>,
    ctx: { liveTurn: boolean; index: ToolIndex },
  ): ToolBlock {
    const id = this.toolCallInstanceId(rawId, ordinal, contentIndex, seenInMessage, ctx.index)
    // Live state is occurrence-level: only the exact instance id may take it.
    const live = this.liveTools.get(id)
    if (live && (ctx.liveTurn || (ctx.index.liveOrdinal === null && ctx.index.byRawId.get(rawId)?.at(-1)?.key === `${ordinal}:${contentIndex}`))) {
      return live
    }
    const occurrence = ctx.index.occurrences.get(`${ordinal}:${contentIndex}`)
    if (occurrence?.result) return { ...occurrence.result, id, input: clip(args) }
    return { type: 'tool', id, name, status: ctx.liveTurn ? 'pending' : 'interrupted', input: clip(args) }
  }

  /**
   * Stable UI instance id for a toolCall occurrence: the raw id for the first
   * occurrence of that id in the message sequence, and
   * rawId::ordinal-contentIndex for every later reuse. Both halves derive
   * purely from session.messages positions (plus the live message's own
   * cumulative content), so partials, finals and re-serializations always
   * produce the same id and dedupe happens per occurrence, not per raw id.
   */
  private toolCallInstanceId(rawId: string, ordinal: number, contentIndex: number, seenInMessage: Map<string, number>, index: ToolIndex): string {
    const before = (index.rawIdOrdinals.get(rawId) ?? []).filter((o) => o < ordinal).length
    const prior = before + (seenInMessage.get(rawId) ?? 0)
    seenInMessage.set(rawId, prior + 1)
    return prior === 0 ? rawId : `${rawId}::${ordinal}-${contentIndex}`
  }

  /**
   * Stable instance ids of every occurrence of `rawId` in the LIVE turn's
   * cached message content, in content order. Generated with the exact same
   * helper (and the same session-derived index) as serialize, so live state
   * always lands on the occurrence id the renderer computes for that card.
   */
  private liveQueueIds(rawId: string): string[] {
    const live = this.liveAssistant
    if (!live?.message || !Array.isArray(live.message.content)) return []
    const index = this.buildToolIndex()
    const seen = new Map<string, number>()
    const ids: string[] = []
    live.message.content.forEach((part, contentIndex) => {
      if (!RECORD(part) || part.type !== 'toolCall' || part.id !== rawId || typeof part.name !== 'string') return
      ids.push(this.toolCallInstanceId(rawId, live.ordinal, contentIndex, seen, index))
    })
    return ids
  }

  /**
   * tool_execution_start target: the first not-yet-started occurrence of the
   * raw id in the current live turn (FIFO by content order). The queue is
   * rebuilt when exhausted so occurrences that appeared in later partials are
   * still claimable; ids are deterministic, so already-claimed ids keep their
   * slots and a new start never overwrites a sibling card. Without any live
   * occurrence, falls back to the session's latest unassigned occurrence.
   */
  private liveStartTarget(rawId: string): string | null {
    const live = this.liveAssistant
    if (live) {
      let queue = this.liveQueues.get(rawId)
      if (queue === undefined || queue.nextStart >= queue.ids.length) {
        const ids = this.liveQueueIds(rawId)
        if (queue === undefined) {
          queue = { ids, nextStart: 0 }
          this.liveQueues.set(rawId, queue)
        } else {
          queue.ids = ids
        }
      }
      this.advanceQueueCursor(queue)
      if (queue.nextStart < queue.ids.length) return queue.ids[queue.nextStart++]!
    }
    return this.liveFallbackTarget(rawId, false)
  }

  /** Builds the rawId's live queue from the cached live message when missing. */
  private ensureLiveQueue(rawId: string): LiveToolQueue | null {
    const existing = this.liveQueues.get(rawId)
    if (existing) return existing
    if (!this.liveAssistant) return null
    const queue: LiveToolQueue = { ids: this.liveQueueIds(rawId), nextStart: 0 }
    this.liveQueues.set(rawId, queue)
    return queue
  }

  /**
   * Advances the queue's start cursor past every occurrence that already
   * holds live state, so a rebuilt queue can never hand a claimed occurrence
   * back to tool_execution_start. The cursor never moves backwards.
   */
  private advanceQueueCursor(queue: LiveToolQueue): void {
    while (queue.nextStart < queue.ids.length && this.liveTools.has(queue.ids[queue.nextStart]!)) {
      queue.nextStart += 1
    }
  }

  /**
   * Claims the first unconsumed occurrence of a live queue for an
   * update/end that arrived before its start: the target gets its live card
   * and the start cursor is advanced past it, so the following
   * tool_execution_start claims the NEXT occurrence and never overwrites the
   * card this event created. Returns null when every occurrence is consumed.
   */
  private claimUnconsumed(queue: LiveToolQueue): string | null {
    for (let i = 0; i < queue.ids.length; i += 1) {
      const id = queue.ids[i]!
      if (this.liveTools.has(id)) continue
      queue.nextStart = Math.max(queue.nextStart, i + 1)
      return id
    }
    return null
  }

  /**
   * tool_execution_update target: when the live turn HAS occurrences of the
   * raw id, FIFO — the earliest running, not-yet-ended occurrence; nothing
   * running falls back to claiming the first unconsumed occurrence (an update
   * can arrive before its start), only dropping the event when every
   * occurrence already holds state. Without a live-turn occurrence, falls
   * back to the session's latest occurrence (the one already holding live
   * state, or the latest unassigned one).
   */
  private liveUpdateTarget(rawId: string): string | null {
    const queue = this.ensureLiveQueue(rawId)
    if (queue && queue.ids.length > 0) {
      for (const id of queue.ids) {
        const state = this.liveTools.get(id)
        if (state?.status === 'running') return id
      }
      return this.claimUnconsumed(queue)
    }
    return this.liveFallbackTarget(rawId, true)
  }

  /**
   * tool_execution_end target: like update, but an end may also create the
   * state on the first unconsumed occurrence (an end can arrive without a
   * start), marking it consumed so a later start claims the next occurrence;
   * when every live occurrence already holds state the event is a stale
   * duplicate and is dropped. Without a live-turn occurrence, falls back to
   * the session's latest occurrence.
   */
  private liveEndTarget(rawId: string): string | null {
    const queue = this.ensureLiveQueue(rawId)
    if (queue && queue.ids.length > 0) {
      for (const id of queue.ids) {
        const state = this.liveTools.get(id)
        if (state?.status === 'running') return id
      }
      return this.claimUnconsumed(queue)
    }
    return this.liveFallbackTarget(rawId, true)
  }

  /**
   * Session fallback for events whose raw id has no live-turn occurrence (or
   * no live turn at all): the rawId's session occurrences in instance-id
   * form. Returns the latest occurrence that already holds live state when
   * `preferAssigned` (update/end follow-up), otherwise the latest unassigned
   * one (start assignment); the bare raw id when the raw id has no occurrence
   * anywhere. A start never falls back onto an already-claimed occurrence:
   * with every occurrence claimed it returns null so the event is dropped
   * instead of overwriting a card.
   */
  private liveFallbackTarget(rawId: string, preferAssigned: boolean): string | null {
    const index = this.buildToolIndex()
    const candidates = index.byRawId.get(rawId) ?? []
    if (candidates.length === 0) return rawId
    const seen = new Map<string, number>()
    let lastOrdinal = -1
    let latestAssigned: string | null = null
    let latestUnassigned: string | null = null
    for (const candidate of candidates) {
      if (candidate.ordinal !== lastOrdinal) { seen.clear(); lastOrdinal = candidate.ordinal }
      const id = this.toolCallInstanceId(rawId, candidate.ordinal, candidate.contentIndex, seen, index)
      if (this.liveTools.has(id)) latestAssigned = id
      else latestUnassigned = id
    }
    if (preferAssigned) return latestAssigned ?? latestUnassigned
    return latestUnassigned
  }

  private liveId(live: LiveAssistant): string {
    // Locked at message_start; serialize gives the SDK-appended final the
    // same id so partial and final always share one React key.
    return live.stableId
  }

  private liveToChatMessage(live: LiveAssistant, index: ToolIndex): ChatMessage | null {
    if (!live.message || live.message.role !== 'assistant') return null
    return this.assistantToChatMessage(live.message, this.liveId(live), live.timestamp, live.streaming, { ordinal: live.ordinal, liveTurn: true, index })
  }

  /**
   * Serializes the live assistant turn exactly once. When session.messages
   * already holds the current partial, the regular serialization above
   * emitted it under the locked stable id (the same id the final will get) —
   * this overrides that entry with the live snapshot instead of appending a
   * duplicate, so partial and final always share one key. When the partial is
   * not in session.messages yet, it is appended. Timestamp fallback, only
   * when the timestamp is unique among the session's assistant messages AND
   * that message sits at the live turn's locked ordinal (its own final). A
   * timestamp shared with any older turn — or a still-streaming live — never
   * suppresses the live turn: the new turn must always display.
   */
  private appendLiveAssistant(messages: ChatMessage[], liveCandidate: number, index: ToolIndex): void {
    const live = this.liveAssistant
    if (!live) return
    const converted = this.liveToChatMessage(live, index)
    if (!converted) return
    // Override by stable id: session.messages may already hold the current
    // partial (serialized above with this exact id); never append a second
    // entry with the same key.
    const existing = messages.findIndex((message) => message.role === 'assistant' && message.id === converted.id)
    if (existing >= 0) {
      messages[existing] = converted
      return
    }
    if (!live.streaming && live.timestamp !== undefined && liveCandidate >= 0) {
      const candidate = messages[liveCandidate]
      if (candidate?.role === 'assistant' && candidate.timestamp === live.timestamp) {
        const matches = messages.filter((message) => message.role === 'assistant' && message.timestamp === live.timestamp)
        if (matches.length === 1) return
      }
    }
    messages.push(converted)
  }

  /**
   * 0-based assistant ordinal the live turn must lock, counted against
   * session.messages. pi-agent-core may push the current partial into
   * session.messages BEFORE emitting message_start (handing listeners a
   * spread copy), or append it only at message_end — both states must yield
   * the same ordinal. Matching order:
   * 1. exact object reference in session.messages;
   * 2. the LAST assistant whose stopReason is 'pending' (a streaming partial;
   *    historical finals carry done/end_turn/… and can never match) and whose
   *    timestamp equals the event message's — toolResult entries never count;
   * 3. otherwise the partial is not in session.messages yet: the current
   *    total assistant count.
   * Always returns the assistant count strictly BEFORE the located element,
   * so the ordinal is never negative and never double-counts the turn itself.
   */
  private liveOrdinalInSession(message: Record<string, unknown>): number {
    const messages = this.session?.messages ?? []
    const assistantsBefore = (index: number): number =>
      messages.slice(0, index).reduce((count, entry) => count + (RECORD(entry) && entry.role === 'assistant' ? 1 : 0), 0)
    // (1) Same reference: the SDK sometimes hands us the exact appended object.
    const byReference = messages.findIndex((entry) => (entry as unknown) === message)
    if (byReference >= 0) return assistantsBefore(byReference)
    // (2) Streaming partial: the event message is pending and usually a spread
    // copy, while the original (pending, same timestamp) already sits in
    // session.messages. Only a pending assistant can be the current partial;
    // same-millisecond historical finals are never mistaken for it.
    if (message.stopReason === 'pending') {
      const timestamp = typeof message.timestamp === 'number' ? message.timestamp : undefined
      if (timestamp !== undefined) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const entry = messages[index]
          if (!RECORD(entry) || entry.role !== 'assistant' || entry.stopReason !== 'pending') continue
          if (entry.timestamp === timestamp) return assistantsBefore(index)
        }
      }
    }
    // (3) Not in session.messages yet: the next assistant ordinal.
    return assistantsBefore(messages.length)
  }

  /** Starts caching a new assistant turn; drops any pending throttled flush. */
  private beginLiveAssistant(message: Record<string, unknown>): void {
    this.clearLiveFlushTimer()
    if (!this.session) { this.liveAssistant = null; return }
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : undefined
    // A NEW assistant turn must never inherit the previous turn's live tool
    // state: a reused raw id would show the old completed card until its own
    // tool_execution_start lands. Only a repeated message_start for the SAME
    // turn (same session + locked ordinal) keeps the current turn's state.
    const ordinal = this.liveOrdinalInSession(message)
    const sameTurn = this.liveAssistant !== null
      && this.liveAssistant.session === this.session
      && this.liveAssistant.ordinal === ordinal
    if (!sameTurn) {
      this.liveTools.clear()
      this.liveQueues.clear()
      // A new turn opens a fresh telemetry window: no rate, no TTFT, no latest output yet.
      this.turnStartedAt = performance.now()
      this.firstContentAt = null
      this.telemetryRate = null
      this.telemetryRateKind = 'unavailable'
      this.ttftMs = null
      this.latestOutputTokens = null
    }
    // Lock the turn's stable identity at message_start: its 0-based assistant
    // ordinal (see liveOrdinalInSession — the SDK may already hold the
    // current partial in session.messages) plus the timestamp or a generated
    // fallback. Serialize reuses exactly this id for the partial already in
    // session.messages and for the final the SDK appends, so partials and
    // final share one React key.
    const stableSuffix = timestamp !== undefined ? String(timestamp) : `live-${(this.liveFallbackSeq += 1)}`
    this.liveAssistant = {
      session: this.session, epoch: this.epoch, message,
      timestamp,
      stableId: `assistant-${ordinal}-${stableSuffix}`,
      stableSuffix,
      ordinal,
      streaming: true,
    }
  }

  private eventMessage(event: AgentSessionEvent): Record<string, unknown> | null {
    const message = (event as unknown as { message?: unknown }).message
    return RECORD(message) ? message : null
  }

  /** Cancels a pending trailing flush; a cleared timer must never emit. */
  private clearLiveFlushTimer(): void {
    if (this.liveFlushTimer !== null) {
      clearTimeout(this.liveFlushTimer)
      this.liveFlushTimer = null
    }
  }

  /** Clears the live turn cache, its pending flush and all live tool state. */
  private clearLiveState(): void {
    this.liveAssistant = null
    this.liveTools.clear()
    this.liveQueues.clear()
    this.clearLiveFlushTimer()
  }

  /** Emits immediately, dropping any pending trailing flush. */
  private flushNow(): void {
    this.clearLiveFlushTimer()
    this.emit()
  }

  /** Trailing 16ms merge for high-frequency message_update events; unref'd. */
  private scheduleFlush(): void {
    if (this.liveFlushTimer !== null) return
    this.liveFlushTimer = setTimeout(() => {
      this.liveFlushTimer = null
      const live = this.liveAssistant
      // Session/epoch check: a stale timer must never emit for a newer session.
      if (live && live.session === this.session && live.epoch === this.epoch) this.emit()
    }, LIVE_FLUSH_DELAY_MS)
    this.liveFlushTimer.unref?.()
  }

  private usage(): UsageInfo {
    if (!this.session) return EMPTY_USAGE
    return this.session.messages.reduce<UsageInfo>((sum, message) => {
      if (!RECORD(message) || message.role !== 'assistant' || !RECORD(message.usage)) return sum
      const usage = message.usage
      const cost = RECORD(usage.cost) && typeof usage.cost.total === 'number' ? usage.cost.total : 0
      return { input: sum.input + numberOf(usage.input), output: sum.output + numberOf(usage.output), cacheRead: sum.cacheRead + numberOf(usage.cacheRead), cacheWrite: sum.cacheWrite + numberOf(usage.cacheWrite), cost: sum.cost + cost }
    }, { ...EMPTY_USAGE })
  }

  /** Cumulative text+thinking character count of a cumulative assistant message. */
  private contentChars(message: Record<string, unknown>): number {
    if (!Array.isArray(message.content)) return 0
    return message.content.reduce<number>((sum, part) => {
      if (!RECORD(part) || (part.type !== 'text' && part.type !== 'thinking')) return sum
      // The SDK emits thinking as { type:'thinking', thinking: string }
      // (pi-ai ThinkingContent); older/other shapes may use `text`. Count it
      // too so reasoning shows up in the live speed estimate.
      const text = part.type === 'thinking'
        ? (typeof part.thinking === 'string' ? part.thinking : typeof part.text === 'string' ? part.text : null)
        : (typeof part.text === 'string' ? part.text : null)
      if (text === null) return sum
      return sum + text.length
    }, 0)
  }

  /**
   * Live-estimate telemetry for one cumulative message_update: the first
   * streamed content fixes firstContentAt and TTFT; the token rate is a
   * rough chars/4 estimate divided by the seconds since first content.
   */
  private updateLiveTelemetry(message: Record<string, unknown>): void {
    if (this.turnStartedAt === null) return
    const chars = this.contentChars(message)
    if (chars <= 0) return
    const now = performance.now()
    if (this.firstContentAt === null) {
      this.firstContentAt = now
      this.ttftMs = Math.max(0, Math.round(now - this.turnStartedAt))
    }
    const elapsedSec = (now - this.firstContentAt) / 1000
    if (elapsedSec > 0) {
      this.telemetryRate = (chars / 4) / elapsedSec
      this.telemetryRateKind = 'live-estimate'
    }
  }

  /**
   * Final telemetry at message_end, only when the assistant message carries a
   * legal usage.output: rate = output / seconds between first content and the
   * end, with the elapsed floored at MIN_RATE_ELAPSED_SEC so instant
   * responses cannot report absurd rates. latestOutputTokens adopts the final
   * output (0 is legal when usage truly reports it). Without legal usage the
   * turn stays unavailable/null — a missing usage is never treated as 0.
   */
  private finalizeTelemetry(message: Record<string, unknown>): void {
    const usage = RECORD(message.usage) ? message.usage : null
    const output = usage !== null && typeof usage.output === 'number' && Number.isFinite(usage.output) ? usage.output : null
    if (output === null) {
      this.telemetryRate = null
      this.telemetryRateKind = 'unavailable'
      this.latestOutputTokens = null
      return
    }
    this.latestOutputTokens = output
    const started = this.firstContentAt ?? this.turnStartedAt
    if (started === null) {
      this.telemetryRate = null
      this.telemetryRateKind = 'unavailable'
      return
    }
    const elapsedSec = Math.max((performance.now() - started) / 1000, MIN_RATE_ELAPSED_SEC)
    this.telemetryRate = output / elapsedSec
    this.telemetryRateKind = 'final'
  }

  /**
   * Error/abort without a usable final: partial measurements must never
   * masquerade as results, so the whole turn window is dropped.
   */
  private invalidateTelemetry(): void {
    this.telemetryRate = null
    this.telemetryRateKind = 'unavailable'
    this.ttftMs = null
    this.latestOutputTokens = null
  }

  /**
   * Restores the last known assistant output for a reopened session; the
   * rate stays unavailable until a live turn measures it.
   */
  private restoreHistoryTelemetry(): void {
    let latest: number | null = null
    for (const message of this.session?.messages ?? []) {
      if (!RECORD(message) || message.role !== 'assistant' || !RECORD(message.usage)) continue
      const output = message.usage.output
      if (typeof output === 'number' && Number.isFinite(output)) latest = output
    }
    this.latestOutputTokens = latest
  }

  /** Context usage is best-effort: the SDK method may be missing or throw. */
  private contextUsage(): { tokens: number | null; window: number | null; percent: number | null } {
    const get = this.session
      ? (this.session as unknown as { getContextUsage?: () => unknown }).getContextUsage
      : undefined
    if (typeof get !== 'function') return { tokens: null, window: null, percent: null }
    try {
      const ctx = get.call(this.session)
      if (!RECORD(ctx)) return { tokens: null, window: null, percent: null }
      return {
        tokens: typeof ctx.tokens === 'number' ? ctx.tokens : null,
        // The SDK ContextUsage field is contextWindow; the legacy `window`
        // name is kept only as a compatibility fallback for older fakes.
        window: typeof ctx.contextWindow === 'number'
          ? ctx.contextWindow
          : typeof ctx.window === 'number' ? ctx.window : null,
        percent: typeof ctx.percent === 'number' ? ctx.percent : null,
      }
    } catch { return { tokens: null, window: null, percent: null } }
  }

  /** Per-snapshot telemetry: context usage plus accumulated turn metrics. */
  private telemetry(): TelemetryInfo {
    const context = this.contextUsage()
    const usage = this.usage()
    const cacheDenominator = usage.input + usage.cacheRead + usage.cacheWrite
    return {
      tokenRate: this.telemetryRate,
      tokenRateKind: this.telemetryRateKind,
      ttftMs: this.ttftMs,
      cacheHitRate: cacheDenominator > 0 ? usage.cacheRead / cacheDenominator : null,
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      contextTokens: context.tokens,
      contextWindow: context.window,
      contextPercent: context.percent,
      contextEstimated: context.tokens !== null,
      latestOutputTokens: this.latestOutputTokens,
    }
  }

  /** Rebuilds this.models from the runtime catalog (no network). */
  private async reloadModels(): Promise<void> {
    if (!this.modelRuntime) return
    const available = await this.modelRuntime.getAvailable()
    this.models = available.map((model) => ({ provider: model.provider, id: model.id, name: model.name || model.id, ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}) }))
  }

  private async refreshSessions(): Promise<void> {
    const myEpoch = this.epoch
    if (!this.workspace) return
    const sessions = await SessionManager.list(this.workspace.path)
    if (myEpoch !== this.epoch) return // a workspace switch happened while listing
    this.sessions = sessions.map((item) => ({
      id: item.id,
      path: item.path,
      title: (this.sessionNameOverrides.get(canonicalizeEvenIfMissing(item.path)) ?? item.name) || item.firstMessage || 'New session',
      preview: item.firstMessage || 'No messages yet',
      modifiedAt: item.modified.toISOString(),
      messageCount: item.messageCount,
    }))
    this.emit()
  }

  /** Stable path of the active session; the SDK assigns one at creation, before any JSONL exists. */
  private activePath(): string | null {
    return this.session?.sessionFile ?? null
  }

  /**
   * Ensures the active empty session (not yet flushed to disk) still appears in the
   * sidebar. Once its JSONL exists and refreshSessions lists it, the real entry with
   * the same path replaces this temporary one.
   */
  private withActiveSession(sessions: SessionListItem[], activePath: string | null): SessionListItem[] {
    if (!this.session || !activePath) return sessions
    if (sessions.some((item) => item.path === activePath)) return sessions
    return [{
      id: this.session.sessionId, path: activePath, title: this.sessionNameOverrides.get(canonicalizeEvenIfMissing(activePath)) ?? 'New session',
      preview: 'No messages yet', modifiedAt: new Date().toISOString(), messageCount: 0,
    }, ...sessions]
  }

  snapshot(): AppSnapshot {
    const model = this.session?.model
    const activeSessionPath = this.activePath()
    return {
      workspace: this.workspace, activeSessionPath,
      sessions: this.withActiveSession(this.sessions, activeSessionPath), models: this.models,
      activeModel: model ? `${model.provider}:${model.id}` : null,
      thinkingLevel: (this.session?.thinkingLevel ?? 'medium') as ThinkingLevel,
      toolApprovalMode: this.getToolApprovalMode(),
      messages: this.serializeMessages(), runState: this.runState, statusText: this.statusText,
      queueCount: this.queueCount, usage: this.usage(), telemetry: this.telemetry(), error: this.lastError,
    }
  }

  private emit(): void { if (this.window && !this.window.isDestroyed()) this.window.webContents.send('pi:changed', this.snapshot()) }

  private async disposeSession(): Promise<void> {
    this.epoch += 1
    this.unsubscribe?.(); this.unsubscribe = null
    const session = this.session
    this.session = null
    this.clearLiveState()
    this.queueCount = 0
    // Session-scoped telemetry: a switched/closed session must not leak its
    // measurements into the next one.
    this.turnStartedAt = null
    this.firstContentAt = null
    this.telemetryRate = null
    this.telemetryRateKind = 'unavailable'
    this.ttftMs = null
    this.latestOutputTokens = null
    if (session) {
      this.markClosing(session)
      try {
        // Wait for pending preflights first so they cannot start a run after
        // the abort, then clear the queue, abort, and wait for runs to settle
        // before disposing — the old session must not write to disk anymore.
        // Bounded: a wedged provider/preflight cannot hang workspace switching
        // or app exit.
        await this.teardownSession(session, { recordTimeout: true })
      } catch { /* session may be switching away */ }
      session.dispose()
    }
  }

  dispose(): Promise<void> { return this.enqueue(() => this.disposeSession()) }
}

function numberOf(value: unknown): number { return typeof value === 'number' ? value : 0 }
