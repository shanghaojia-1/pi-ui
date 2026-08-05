export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type RunState = 'idle' | 'running' | 'retrying' | 'compacting' | 'error'

/** Tool approval policy: ask per tool call, or fully managed (auto-approve). */
export type ToolApprovalMode = 'ask' | 'managed'

/** Host platforms the desktop shell can run on. */
export type DesktopPlatform = 'darwin' | 'win32' | 'linux' | 'other'

/** Immutable host-platform info exposed to the renderer by the preload. */
export interface DesktopInfo {
  readonly platform: DesktopPlatform
}

export interface WorkspaceInfo { path: string; name: string }
export interface SessionListItem {
  id: string
  path: string
  title: string
  preview: string
  modifiedAt: string
  messageCount: number
}
export interface ModelInfo {
  provider: string
  id: string
  name: string
  contextWindow?: number
}
export interface TextBlock { type: 'text' | 'thinking'; text: string }
export interface ToolBlock {
  type: 'tool'
  id: string
  name: string
  status: 'pending' | 'running' | 'success' | 'error' | 'interrupted'
  input: string
  output?: string
  patch?: string
  durationMs?: number
}
export type MessageBlock = TextBlock | ToolBlock
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  blocks: MessageBlock[]
  timestamp?: number
  isStreaming?: boolean
}
export interface UsageInfo { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export interface AppError { message: string; detail?: string; recoverable: boolean }

/** Auth state of a model provider as surfaced to the renderer. */
export interface ProviderStatus {
  id: string
  name: string
  authStatus: 'stored' | 'runtime' | 'environment' | 'fallback' | 'models-json' | 'none' | 'error'
  authLabel: string | null
  credentialType: string | null
  availableModelCount: number
}

/** Read-only compaction settings. */
export interface CompactionConfig {
  reserveTokens: number | null
  keepRecentTokens: number | null
}

/** Read-only retry settings. */
export interface RetryConfig {
  maxRetries: number | null
  baseDelayMs: number | null
  maxDelayMs: number | null
}

export interface SettingsSnapshot {
  providers: ProviderStatus[]
  defaultProvider: string | null
  defaultModel: string | null
  defaultThinkingLevel: ThinkingLevel
  compactionEnabled: boolean
  retryEnabled: boolean
  httpIdleTimeoutMs: number
  compaction: CompactionConfig
  retry: RetryConfig
  keyPersistence: 'runtime-only'
  toolApprovalMode: ToolApprovalMode
  error: AppError | null
}

/** Optional settings the renderer is allowed to change. */
export interface SettingsPatch {
  defaultProvider?: string | null
  defaultModel?: string | null
  defaultThinkingLevel?: ThinkingLevel
  compactionEnabled?: boolean
  retryEnabled?: boolean
  httpIdleTimeoutMs?: number
}

export interface TelemetryInfo {
  tokenRate: number | null
  tokenRateKind: 'live-estimate' | 'final' | 'unavailable'
  ttftMs: number | null
  cacheHitRate: number | null
  input: number
  cacheRead: number
  cacheWrite: number
  contextTokens: number | null
  contextWindow: number | null
  contextPercent: number | null
  contextEstimated: boolean
  latestOutputTokens: number | null
}
export interface AppSnapshot {
  workspace: WorkspaceInfo | null
  activeSessionPath: string | null
  sessions: SessionListItem[]
  models: ModelInfo[]
  activeModel: string | null
  thinkingLevel: ThinkingLevel
  toolApprovalMode: ToolApprovalMode
  messages: ChatMessage[]
  runState: RunState
  statusText: string
  queueCount: number
  usage: UsageInfo
  telemetry: TelemetryInfo
  error: AppError | null
}

export interface PiDesktopApi {
  getSnapshot(): Promise<AppSnapshot>
  chooseWorkspace(): Promise<AppSnapshot>
  openWorkspace(path: string): Promise<AppSnapshot>
  newSession(): Promise<AppSnapshot>
  openSession(path: string): Promise<AppSnapshot>
  sendPrompt(text: string): Promise<void>
  abort(): Promise<void>
  setModel(provider: string, id: string): Promise<AppSnapshot>
  setThinking(level: ThinkingLevel): Promise<AppSnapshot>
  setToolApprovalMode(mode: ToolApprovalMode): Promise<SettingsSnapshot>
  getSettings(): Promise<SettingsSnapshot>
  updateSettings(patch: SettingsPatch): Promise<SettingsSnapshot>
  setRuntimeApiKey(provider: string, key: string): Promise<SettingsSnapshot>
  logoutProvider(provider: string): Promise<SettingsSnapshot>
  refreshModels(): Promise<SettingsSnapshot>
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void
}

export const IPC = {
  snapshot: 'pi:snapshot', chooseWorkspace: 'pi:choose-workspace', openWorkspace: 'pi:open-workspace',
  newSession: 'pi:new-session', openSession: 'pi:open-session', prompt: 'pi:prompt', abort: 'pi:abort',
  model: 'pi:model', thinking: 'pi:thinking', settings: 'pi:settings', updateSettings: 'pi:update-settings',
  runtimeApiKey: 'pi:runtime-api-key', logoutProvider: 'pi:logout-provider', refreshModels: 'pi:refresh-models',
  setToolApprovalMode: 'pi:set-tool-approval-mode',
  changed: 'pi:changed',
} as const

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && ['off','minimal','low','medium','high','xhigh','max'].includes(value)
}

export function isToolApprovalMode(value: unknown): value is ToolApprovalMode {
  return value === 'ask' || value === 'managed'
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Bounded non-empty string; reusable by main for provider/key/name validation. */
export function isBoundedString(value: unknown, minLength = 1, maxLength = 128): value is string {
  return typeof value === 'string' && value.length >= minLength && value.length <= maxLength
}

export function isProviderName(value: unknown): value is string {
  return isBoundedString(value, 1, 128)
}

export function isModelId(value: unknown): value is string {
  return isBoundedString(value, 1, 256)
}

export function isApiKey(value: unknown): value is string {
  return isBoundedString(value, 1, 4096)
}

/** Bound on sanitized error text; long SDK/provider errors are truncated. */
export const MAX_SANITIZED_ERROR_LENGTH = 1000

/**
 * Pure error-text sanitizer for anything that may embed credentials
 * (unknown SDK/provider errors, URLs). Replaces exact known secrets (raw,
 * JSON-escaped and URL-encoded forms) plus Bearer/Authorization tokens,
 * sensitive key/value assignments (exact field names), sk- keys, JWTs, URL
 * userinfo and URL query secrets, then truncates to a bounded length.
 * Returns `fallback` when nothing usable remains.
 */
export function sanitizeErrorText(value: unknown, fallback: string, knownSecrets?: ReadonlySet<string>): string {
  let text: string
  if (typeof value === 'string') text = value
  else if (value instanceof Error) text = value.message
  else {
    try { text = JSON.stringify(value) } catch { text = String(value) }
    text = String(text)
  }
  // Exact known secrets first (submitted runtime keys). Each secret is
  // replaced in its raw form, its JSON-escaped form (as it appears inside a
  // serialized JSON string) and its URL-encoded form. Forms are applied
  // longest-first so a short secret can never shred a longer one; empty and
  // too-short secrets are skipped to avoid destroying ordinary text.
  if (knownSecrets) {
    const forms = new Set<string>()
    for (const secret of knownSecrets) {
      if (typeof secret !== 'string' || secret.length < 3) continue
      forms.add(secret)
      forms.add(JSON.stringify(secret).slice(1, -1))
      forms.add(encodeURIComponent(secret))
    }
    for (const form of [...forms].sort((a, b) => b.length - a.length)) {
      text = text.split(form).join('[REDACTED]')
    }
  }
  // Bearer tokens and Authorization headers.
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
  text = text.replace(/\bAuthorization\s*[=:]\s*[A-Za-z0-9._~+/=-]+/gi, 'Authorization: [REDACTED]')
  // Sensitive key/value assignments in JSON/log forms. Field names must match
  // one of the exact names (case-insensitive) and be delimited by non-word,
  // non-hyphen characters, so `notkey`, `tokenizer`, `secretary`, `monkey` or
  // `x-api-key` never match. Keys may be bare or quoted with single/double
  // quotes, each optionally backslash-escaped (JSON embedded in an outer
  // string); the separator is `:` or `=` with optional whitespace. Values are
  // full quoted strings (escaped quotes/backslashes included), escaped-quoted
  // strings, or bare tokens — the whole value is replaced so no fragment of
  // it survives. The key and its quoting are kept verbatim.
  text = text.replace(
    /(^|[^A-Za-z0-9_-])(\\?["']?)(api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|token|password|secret)(\\?["']?)\s*[=:]\s*(?:\\?"(?:\\.|[^"\\])*\\?"|\\?'(?:\\.|[^'\\])*\\?'|[^\s,;]+)/gi,
    '$1$2$3$4: [REDACTED]',
  )
  // sk- prefixed keys.
  text = text.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-[REDACTED]')
  // Long JWTs: three dot-separated base64url segments.
  text = text.replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[JWT REDACTED]')
  // URL userinfo (https://user:pass@host).
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@')
  // URL query secrets (?key=..., &token=...).
  text = text.replace(/([?&](?:api[-_]?key|apikey|key|token|password|access[-_]?token|auth|signature|sig)=)[^&\s"'<>]+/gi, '$1[REDACTED]')
  text = text.trim()
  if (text.length === 0) return fallback
  return text.length > MAX_SANITIZED_ERROR_LENGTH
    ? `${text.slice(0, MAX_SANITIZED_ERROR_LENGTH)}… (truncated)`
    : text
}

export const HTTP_IDLE_TIMEOUT_MIN_MS = 1000
export const HTTP_IDLE_TIMEOUT_MAX_MS = 600000

export function isHttpIdleTimeoutMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= HTTP_IDLE_TIMEOUT_MIN_MS && value <= HTTP_IDLE_TIMEOUT_MAX_MS
}

const SETTINGS_PATCH_KEYS = new Set([
  'defaultProvider', 'defaultModel', 'defaultThinkingLevel',
  'compactionEnabled', 'retryEnabled', 'httpIdleTimeoutMs',
])

/** Whitelist-based patch guard: rejects unknown keys and out-of-range values. */
export function isSettingsPatch(value: unknown): value is SettingsPatch {
  if (!isPlainObject(value)) return false
  for (const key of Object.keys(value)) {
    if (!SETTINGS_PATCH_KEYS.has(key)) return false
  }
  // null is rejected outright: the SDK settings setters accept only strings,
  // so clearing is never persisted as an empty string. (The TS type stays
  // `string | null` for renderer compatibility; the guard and runtime reject.)
  if ('defaultProvider' in value && !isProviderName(value.defaultProvider)) return false
  if ('defaultModel' in value && !isModelId(value.defaultModel)) return false
  if ('defaultThinkingLevel' in value && !isThinkingLevel(value.defaultThinkingLevel)) return false
  if ('compactionEnabled' in value && typeof value.compactionEnabled !== 'boolean') return false
  if ('retryEnabled' in value && typeof value.retryEnabled !== 'boolean') return false
  if ('httpIdleTimeoutMs' in value && !isHttpIdleTimeoutMs(value.httpIdleTimeoutMs)) return false
  return true
}
