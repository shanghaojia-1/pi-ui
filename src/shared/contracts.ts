export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type RunState = 'idle' | 'running' | 'retrying' | 'compacting' | 'error'

/** Tool approval policy: ask per tool call, or fully managed (auto-approve). */
export type ToolApprovalMode = 'ask' | 'managed'

/** Host platforms the desktop shell can run on. */
export type DesktopPlatform = 'darwin' | 'win32' | 'linux' | 'other'

/** Immutable host-platform info exposed to the renderer by the preload. */
export interface DesktopInfo {
  readonly platform: DesktopPlatform
  /** Optional forced UI language (test/CI override via PI_STUDIO_LANG). */
  readonly lang?: 'zh' | 'en'
}

export interface WorkspaceInfo { path: string; name: string }

/**
 * A user-created sidebar group: a name plus workspace directories. Sessions
 * whose cwd matches one of `dirs` land here automatically; explicit drag
 * memberships (`members` map, value `groupId` or the sentinel `ungrouped`)
 * override the dir rule. Persisted at ~/.pi/agent/session-groups.json.
 */
export interface SessionGroup {
  id: string
  name: string
  /** Workspace directories bound to this group (canonical paths). */
  dirs: string[]
}

export interface SessionGroupsConfig {
  version: 1
  groups: SessionGroup[]
  /** Explicit session membership: canonical session path -> group id or 'ungrouped'. */
  members: Record<string, string>
}

/** Sentinel membership value: pinned OUT of every group, even when the cwd matches. */
export const UNGROUPED = 'ungrouped'

export interface SessionListItem {
  id: string
  path: string
  title: string
  preview: string
  modifiedAt: string
  messageCount: number
  /** Working directory this session belongs to; may differ from the active workspace. */
  workspace: WorkspaceInfo | null
  /** Sidebar group this session belongs to; null = ungrouped. */
  groupId: string | null
}
export interface ModelInfo {
  provider: string
  id: string
  name: string
  contextWindow?: number
}
export interface TextBlock { type: 'text' | 'thinking'; text: string }
/** Image inside a user message; `data` is the raw base64 payload (no data: URL prefix). */
export interface ImageBlock { type: 'image'; data: string; mimeType: string }
/** Attachment pending send from the composer; mirrors ImageBlock. */
export interface ImageAttachment { data: string; mimeType: string }

/** API flavors a custom provider can speak (models.json `api` values). */
export const CUSTOM_PROVIDER_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const
export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number]

export interface CustomProviderConfig {
  /** Unique provider id (identifier, used in `/model`). */
  id: string
  /** Optional display name; falls back to `id`. */
  name?: string
  /** API endpoint (http/https). */
  baseUrl: string
  api: CustomProviderApi
  /** Optional static key; empty means env-var / runtime-key auth. */
  apiKey?: string
  models: { id: string; name?: string; input?: ('text' | 'image')[]; contextWindow?: number }[]
}

/**
 * Existing provider config for the edit dialog. The stored API key is never
 * returned — only whether one exists, so the UI can hint "keep the current key".
 */
export interface ProviderEditConfig {
  id: string
  /** Optional display name; falls back to `id`. */
  name?: string
  baseUrl: string
  api: CustomProviderApi
  models: { id: string; name?: string; input?: ('text' | 'image')[]; contextWindow?: number }[]
  hasApiKey: boolean
  /** True for a pi built-in configured by key only (no custom baseUrl/models). */
  builtin: boolean
}

/** A selectable provider type for the New-provider dialog. */
export interface ProviderTypeInfo {
  id: string
  name: string
  /** Official endpoint; undefined for non-URL (credential-based) providers. */
  baseUrl?: string
  /** True when models.json already defines this provider. */
  configured: boolean
}

const CUSTOM_PROVIDER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const CUSTOM_MODEL_ID_MAX = 256

/**
 * Whitelist-based validation for addCustomProvider IPC. Everything is
 * bounded; the payload is written verbatim to models.json, so any
 * out-of-schema field is rejected here before it can reach disk.
 */
/** Whitelist validation for testProviderConnection (no secrets echoed). */
export function isProviderConnectionTest(value: unknown): value is ProviderConnectionTest {
  if (!isPlainObject(value)) return false
  const { baseUrl, api, apiKey } = value as Record<string, unknown>
  if (typeof baseUrl !== 'string' || baseUrl.length < 1 || baseUrl.length > 512) return false
  if (!/^https?:\/\//i.test(baseUrl.trim())) return false
  if (!CUSTOM_PROVIDER_APIS.includes(api as CustomProviderApi)) return false
  if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 4096)) return false
  return true
}

export function isCustomProviderConfig(value: unknown): value is CustomProviderConfig {
  if (!isPlainObject(value)) return false
  const { id, name, baseUrl, api, apiKey, models } = value as Record<string, unknown>
  if (typeof id !== 'string' || !CUSTOM_PROVIDER_ID_RE.test(id)) return false
  if (name !== undefined && (typeof name !== 'string' || name.length < 1 || name.length > 128)) return false
  if (typeof baseUrl !== 'string' || baseUrl.length < 1 || baseUrl.length > 512) return false
  if (!/^https?:\/\//i.test(baseUrl)) return false
  if (!CUSTOM_PROVIDER_APIS.includes(api as CustomProviderApi)) return false
  if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length < 1 || apiKey.length > 4096)) return false
  if (!Array.isArray(models) || models.length < 1 || models.length > 20) return false
  for (const model of models) {
    if (!isPlainObject(model)) return false
    const mid = (model as Record<string, unknown>).id
    if (typeof mid !== 'string' || mid.length < 1 || mid.length > CUSTOM_MODEL_ID_MAX) return false
    const mname = (model as Record<string, unknown>).name
    if (mname !== undefined && (typeof mname !== 'string' || mname.length < 1 || mname.length > 128)) return false
    const input = (model as Record<string, unknown>).input
    if (input !== undefined && (!Array.isArray(input) || input.length === 0 || input.some((t) => t !== 'text' && t !== 'image'))) return false
    const ctx = (model as Record<string, unknown>).contextWindow
    if (ctx !== undefined && (typeof ctx !== 'number' || !Number.isFinite(ctx) || ctx < 1)) return false
  }
  return true
}
export type SubagentTaskStatus =
  | 'queued'
  | 'starting'
  | 'thinking'
  | 'running_tool'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface SubagentUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  contextTokens: number
  turns: number
}

export interface SubagentEvent {
  id: string
  kind: 'lifecycle' | 'thinking' | 'message' | 'tool' | 'error'
  status: 'running' | 'success' | 'error'
  label: string
  timestamp: number
  toolName?: string
  toolCallId?: string
  args?: string
  output?: string
  text?: string
}

/** Version 1 fields remain optional-compatible with persisted legacy sessions. */
export interface SubagentResult {
  id?: string
  agent: string
  agentSource?: 'user' | 'project' | 'unknown'
  task: string
  status?: SubagentTaskStatus
  exitCode: number
  messages?: Array<{ role: string; content: unknown }>
  events?: SubagentEvent[]
  liveText?: string
  output?: string
  stderr?: string
  usage?: Partial<SubagentUsage>
  model?: string
  stopReason?: string
  errorMessage?: string
  step?: number
  startedAt?: number
  finishedAt?: number
  durationMs?: number
}

export interface SubagentDetails {
  version?: 1 | 2
  runId?: string
  mode: 'single' | 'parallel' | 'chain'
  agentScope?: string
  projectAgentsDir?: string | null
  total?: number
  maxConcurrency?: number
  results: SubagentResult[]
}

export interface ToolBlock {
  type: 'tool'
  id: string
  name: string
  status: 'pending' | 'running' | 'success' | 'error' | 'interrupted'
  input: string
  output?: string
  patch?: string
  durationMs?: number
  /** Structured tool payload (e.g. subagent results) for GUI-specific rendering. */
  details?: unknown
  /** Document/video files this tool produced; rendered as clickable preview links. */
  artifacts?: ArtifactFile[]
}

/** Previewable artifact produced by the agent during a task. */
export type ArtifactKind = 'text' | 'pdf' | 'video' | 'binary'

/** A file the agent produced; clickable blue text that opens a sidebar preview. */
export interface ArtifactFile {
  /** Canonical absolute path of the artifact. */
  path: string
  /** File name for display (basename). */
  name: string
  kind: ArtifactKind
}

/** Payload of the artifact-preview IPC: inline content and/or a renderable URL. */
export interface ArtifactPreview {
  path: string
  name: string
  kind: ArtifactKind
  /** UTF-8 text content for text artifacts, bounded (see previewTextLimitChars). */
  content?: string
  /** True when content was truncated at the preview bound. */
  truncated?: boolean
  /** Internal pi-preview:// URL for video/pdf artifacts (one token per file). */
  url?: string
  /** Byte size of the artifact on disk. */
  size?: number
}

/**
 * Extensions whose files count as previewable artifacts (documents and
 * videos). Lowercase, no dot. Text-ish formats are previewed inline; pdf gets
 * an embedded viewer; video gets a <video> element; the rest surface as
 * open-externally entries. Mirrored by the main-process artifact discovery
 * so renderer link gating and main validation can never drift apart.
 */
export const ARTIFACT_EXTENSIONS = [
  // text documents (inline preview)
  'md', 'markdown', 'mdx', 'txt', 'text', 'rtf', 'html', 'htm', 'csv', 'json', 'yaml', 'yml', 'xml', 'log', 'ini', 'conf', 'toml', 'svg',
  // pdf (embedded viewer)
  'pdf',
  // videos (inline <video>)
  'mp4', 'webm', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'm4v', 'ogv', 'mpeg', 'mpg', '3gp',
  // office/binary documents (open externally)
  'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'epub',
] as const

export type ArtifactExtension = (typeof ARTIFACT_EXTENSIONS)[number]

export const ARTIFACT_EXTENSION_SET: ReadonlySet<string> = new Set(ARTIFACT_EXTENSIONS)

/** Maps an artifact file name (or extension) to its preview kind; null = not an artifact. */
export function artifactKindOf(fileName: string): ArtifactKind | null {
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase() : fileName.toLowerCase()
  if (!ARTIFACT_EXTENSION_SET.has(ext)) return null
  if (ext === 'pdf') return 'pdf'
  if (['mp4', 'webm', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'm4v', 'ogv', 'mpeg', 'mpg', '3gp'].includes(ext)) return 'video'
  if (['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'epub', 'rtf'].includes(ext)) return 'binary'
  return 'text'
}

/**
 * True when `href` looks like a local artifact path (relative or absolute,
 * no scheme) — the Markdown renderer turns such links into clickable preview
 * text. Main re-validates existence/containment before anything is read.
 */
export function isArtifactLinkHref(href: string | undefined | null): href is string {
  if (!href || href.length < 2 || href.length > 4096) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
    // A drive-letter prefix (C:\...) is a local path, not a scheme.
    if (!/^[a-zA-Z]:[\\/]/.test(href)) return false
  }
  if (href.includes('\\') && !/^[a-zA-Z]:[\\/]/.test(href)) return false
  const name = href.split(/[\\/]/).pop() ?? ''
  return artifactKindOf(name) !== null
}
export type MessageBlock = TextBlock | ImageBlock | ToolBlock
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  blocks: MessageBlock[]
  timestamp?: number
  isStreaming?: boolean
}
export interface UsageInfo { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }

/** `/session` command payload: stats of the active session. */
export interface SessionStatsInfo {
  sessionId: string
  sessionFile: string | null
  sessionName: string | null
  userMessages: number
  assistantMessages: number
  toolCalls: number
  totalMessages: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cost: number
}
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

/** Read-only app identity for the about dialog / status bar. */
export interface AppInfo {
  name: string
  version: string
  electron: string
  platform: DesktopPlatform
  agentDir: string
}

/** A slash command the composer can offer, beyond the built-in GUI set. */
export interface DynamicCommand {
  name: string
  description?: string
  argHint?: string
  source: 'extension' | 'prompt' | 'skill'
}

/** One loaded extension, as surfaced to the Settings extensions section. */
export interface ExtensionInfo {
  path: string
  resolvedPath: string
  /** Card title: package name for npm/git extensions, file name for standalone ones. */
  name: string
  /** Extension origin scope: user, project or built-in. */
  sourceLabel: 'user' | 'project' | 'temporary'
  /** Version from the nearest package.json (npm/git packages); null otherwise. */
  version: string | null
  commandCount: number
  toolCount: number
  handlerCount: number
}

export interface ExtensionsInfo {
  extensions: ExtensionInfo[]
  errors: { path: string; error: string }[]
}

/** One loaded skill, as surfaced to the Settings skills section. */
export interface SkillInfo {
  name: string
  description: string
  filePath: string
  baseDir: string
  /** Discovery scope reported by pi's resource loader. */
  sourceLabel: 'user' | 'project' | 'temporary'
  /** Original configured source (`auto`, `npm:…`, `git:…`, etc.). */
  source: string
  origin: 'package' | 'top-level'
  /** True means the skill is available only through `/skill:<name>`. */
  disableModelInvocation: boolean
}

export interface SkillDiagnosticInfo {
  type: 'warning' | 'error' | 'collision'
  message: string
  path: string | null
}

export interface SkillsInfo {
  skills: SkillInfo[]
  diagnostics: SkillDiagnosticInfo[]
}

/** A user-level subagent definition (frontmatter + system prompt body). */
export interface SubagentConfig {
  name: string
  description: string
  tools?: string[]
  model?: string
  systemPrompt: string
  /** Absolute file path of the definition (for display/identification). */
  filePath: string
}

/** Editable fields of a subagent definition (name is the file key). */
export interface SubagentEdit {
  name: string
  description: string
  tools?: string[]
  model?: string
  systemPrompt: string
}

/** Payload for the provider connection test (Settings → New provider). */
export interface ProviderConnectionTest {
  /** Provider id being edited, when the test runs from the edit dialog. */
  providerId?: string
  baseUrl: string
  api: CustomProviderApi
  /** Typed key; when empty, main falls back to the stored models.json key. */
  apiKey?: string
}

export interface ConnectionTestResult {
  ok: boolean
  status: number | null
  kind: 'ok' | 'auth' | 'http' | 'network'
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
  groups: SessionGroup[]
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

/** A configured pi package (settings.json `packages` entry) with its installed version. */
export interface PackageInfo {
  /** Settings source string, e.g. `npm:pi-subagents`. */
  source: string
  /** Package name without the `npm:` / `git:` prefix. */
  displayName: string
  type: 'npm' | 'git'
  scope: 'user' | 'project'
  /** Version read from the installed package.json; null when not installed. */
  version: string | null
}

/** Package-management state surfaced to the Settings extensions section. */
export interface PackagesInfo {
  packages: PackageInfo[]
  /** Sources with newer versions available on the registry. */
  updateSources: string[]
}

/** Active pi engine: version, source and where it was loaded from. */
export interface ActiveEngineInfo {
  version: string
  source: 'userdata'
  path: string
}

/** DingTalk robot bridge states surfaced to the settings UI. */
export type DingtalkState =
  | 'disabled'   // feature off: config.enabled is false
  | 'stopped'    // configured but not connected
  | 'connecting' // connecting / reconnecting
  | 'connected'  // stream channel open
  | 'error'      // credential/network failure; detail carries a fixed message

/** Persisted DingTalk robot bridge configuration (<userData>/dingtalk.json). */
export interface DingtalkConfig {
  enabled: boolean
  /** DingTalk open-platform app Client ID (AppKey). */
  clientId: string
  /** DingTalk open-platform app Client Secret (AppSecret). */
  clientSecret: string
  /** senderStaffId allowlist; empty = anyone who @s the bot can drive Pi. */
  allowList: string[]
}

/** Live bridge status pushed to the renderer (and returned by IPC). */
export interface DingtalkStatus {
  state: DingtalkState
  /** Fixed-text detail for error/connecting states; null when idle. */
  detail: string | null
  connectedAt: number | null
  lastMessageAt: number | null
  lastSender: string | null
}

const DINGTALK_ALLOWLIST_MAX = 32
const DINGTALK_ALLOWLIST_ENTRY_MAX = 128

export function isDingtalkConfig(value: unknown): value is DingtalkConfig {
  if (!isPlainObject(value)) return false
  const { enabled, clientId, clientSecret, allowList } = value as Record<string, unknown>
  if (typeof enabled !== 'boolean') return false
  if (typeof clientId !== 'string' || clientId.length > 128) return false
  if (typeof clientSecret !== 'string' || clientSecret.length > 512) return false
  if (!Array.isArray(allowList) || allowList.length > DINGTALK_ALLOWLIST_MAX) return false
  for (const entry of allowList) {
    if (typeof entry !== 'string' || entry.length < 1 || entry.length > DINGTALK_ALLOWLIST_ENTRY_MAX) return false
  }
  return true
}

/** Engine-management state surfaced to the settings UI. */
export interface EngineStatus {
  active: ActiveEngineInfo | null
  /** True when the active engine is inside the GUI's supported range. */
  compatible: boolean
  supportedRange: string
  /** Installed external versions (directory names under <userData>/engine/). */
  installed: string[]
  npm: { available: boolean; path: string | null }
  /** Directory external engines are installed into (for manual install hints). */
  installDir: string
  /** Fixed-text reason why the configured engine could not be loaded. */
  error: string | null
}

export interface PiDesktopApi {
  getSnapshot(): Promise<AppSnapshot>
  chooseWorkspace(): Promise<AppSnapshot>
  openWorkspace(path: string): Promise<AppSnapshot>
  /** Frameless-window controls (win32 custom title bar). */
  minimizeWindow(): Promise<void>
  toggleMaximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  getWindowMaximized(): Promise<boolean>
  /** Subscribe to maximize/unmaximize changes; returns the unsubscribe fn. */
  onMaximizedChange(listener: (maximized: boolean) => void): () => void
  /** Creates a session; null pins it ungrouped, a group id pins it there, undefined uses directory matching. */
  newSession(groupId?: string | null): Promise<AppSnapshot>
  openSession(path: string): Promise<AppSnapshot>
  deleteSession(path: string): Promise<AppSnapshot>
  renameSession(name: string): Promise<AppSnapshot>
  compactSession(customInstructions?: string): Promise<AppSnapshot>
  copyLastMessage(): Promise<boolean>
  exportSession(): Promise<string | null>
  getSessionStats(): Promise<SessionStatsInfo | null>
  reloadSession(): Promise<AppSnapshot>
  /** Picks a directory via the native dialog; null when cancelled. Used by group creation. */
  pickDirectory(): Promise<string | null>
  /** Resolves and loads an artifact (workspace document/video) for inline preview; null when not previewable. */
  previewArtifact(path: string): Promise<ArtifactPreview | null>
  /** Opens an artifact with the OS default app (same workspace/extension validation as preview). */
  openArtifactExternal(path: string): Promise<void>
  /** Creates a session group bound to the given workspace directories. */
  createSessionGroup(name: string, dirs: string[]): Promise<AppSnapshot>
  renameSessionGroup(id: string, name: string): Promise<AppSnapshot>
  /** Updates both the display name and bound directories of an existing group. */
  updateSessionGroup(id: string, name: string, dirs: string[]): Promise<AppSnapshot>
  deleteSessionGroup(id: string): Promise<AppSnapshot>
  /** Pins a session to a group (drag) — or out of every group when id is null. */
  moveSessionToGroup(sessionPath: string, groupId: string | null): Promise<AppSnapshot>
  quitApp(): Promise<void>
  getAppInfo(): Promise<AppInfo>
  getDynamicCommands(): Promise<DynamicCommand[]>
  getExtensions(): Promise<ExtensionsInfo>
  getSkills(): Promise<SkillsInfo>
  getProviderConfig(providerId: string): Promise<ProviderEditConfig | null>
  getProviderTypes(): Promise<ProviderTypeInfo[]>
  /** Persists an API key for a pi built-in provider (models.json). */
  saveProviderKey(providerId: string, apiKey: string): Promise<SettingsSnapshot>
  testProviderConnection(config: ProviderConnectionTest): Promise<ConnectionTestResult>
  sendPrompt(text: string, images?: ImageAttachment[]): Promise<void>
  abort(): Promise<void>
  /** Cancels one active subagent task without stopping its siblings. */
  cancelSubagent(taskId: string): Promise<boolean>
  setModel(provider: string, id: string): Promise<AppSnapshot>
  setThinking(level: ThinkingLevel): Promise<AppSnapshot>
  setToolApprovalMode(mode: ToolApprovalMode): Promise<SettingsSnapshot>
  getSettings(): Promise<SettingsSnapshot>
  updateSettings(patch: SettingsPatch): Promise<SettingsSnapshot>
  setRuntimeApiKey(provider: string, key: string): Promise<SettingsSnapshot>
  logoutProvider(provider: string): Promise<SettingsSnapshot>
  addCustomProvider(config: CustomProviderConfig): Promise<SettingsSnapshot>
  refreshModels(): Promise<SettingsSnapshot>
  getEngineStatus(): Promise<EngineStatus>
  /** Compatible versions available on the npm registry, newest first. */
  getEngineVersions(): Promise<string[]>
  /** Installs a version under <userData>/engine/ (npm required); rejects on failure. */
  installEngine(version: string): Promise<void>
  /** Activates an installed version for the next launch; rejects on failure. */
  activateEngine(version: string): Promise<void>
  /** Removes an installed version (and its activation if active). */
  uninstallEngine(version: string): Promise<void>
  /** Clears the configured engine; next launch returns to first-run setup. */
  deactivateEngine(): Promise<void>
  getPackages(): Promise<PackagesInfo>
  /** Installs a package source (npm:name or git:url) and persists it to settings.json. */
  installPackage(source: string): Promise<void>
  /** Updates one configured package, or all of them when source is omitted. */
  updatePackages(source?: string): Promise<void>
  /** Uninstalls a package and removes it from settings.json. */
  removePackage(source: string): Promise<void>
  /** Sources with newer versions available on the registry. */
  checkPackageUpdates(): Promise<string[]>
  /** User-level subagent definitions (~/.pi/agent/agents/*.md), sorted by name. */
  listSubagents(): Promise<SubagentConfig[]>
  /** Creates or overwrites a subagent definition; the name is the file key. */
  saveSubagent(name: string, edit: SubagentEdit): Promise<SubagentConfig[]>
  /** Deletes a subagent definition by name. */
  deleteSubagent(name: string): Promise<SubagentConfig[]>
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void
  /** DingTalk remote-control bridge: persisted config (secrets included, local file only). */
  getDingtalkConfig(): Promise<DingtalkConfig>
  /** Persists the config; enabling it (or changing credentials) (re)starts the bridge. */
  saveDingtalkConfig(config: DingtalkConfig): Promise<DingtalkStatus>
  /** Connects the robot stream channel now (no config change). */
  startDingtalk(): Promise<DingtalkStatus>
  /** Disconnects the robot stream channel now (config kept). */
  stopDingtalk(): Promise<DingtalkStatus>
  getDingtalkStatus(): Promise<DingtalkStatus>
  onDingtalkStatus(listener: (status: DingtalkStatus) => void): () => void
}

export const IPC = {
  snapshot: 'pi:snapshot', chooseWorkspace: 'pi:choose-workspace', openWorkspace: 'pi:open-workspace',
  newSession: 'pi:new-session', openSession: 'pi:open-session', deleteSession: 'pi:delete-session', prompt: 'pi:prompt', abort: 'pi:abort', cancelSubagent: 'pi:cancel-subagent',
  windowMinimize: 'pi:window-minimize', windowMaximizeToggle: 'pi:window-maximize-toggle', windowClose: 'pi:window-close',
  windowMaximized: 'pi:window-maximized', windowMaximizedChanged: 'pi:window-maximized-changed',
  model: 'pi:model', thinking: 'pi:thinking', settings: 'pi:settings', updateSettings: 'pi:update-settings',
  runtimeApiKey: 'pi:runtime-api-key', logoutProvider: 'pi:logout-provider', customProvider: 'pi:custom-provider', refreshModels: 'pi:refresh-models',
  renameSession: 'pi:rename-session', compactSession: 'pi:compact-session', copyLastMessage: 'pi:copy-last-message',
  exportSession: 'pi:export-session', sessionStats: 'pi:session-stats', reloadSession: 'pi:reload-session', quitApp: 'pi:quit-app', appInfo: 'pi:app-info',
  pickDirectory: 'pi:pick-directory', artifactPreview: 'pi:artifact-preview', artifactOpenExternal: 'pi:artifact-open-external',
  createSessionGroup: 'pi:create-session-group', renameSessionGroup: 'pi:rename-session-group', updateSessionGroup: 'pi:update-session-group', deleteSessionGroup: 'pi:delete-session-group', moveSessionToGroup: 'pi:move-session-to-group',
  dynamicCommands: 'pi:dynamic-commands', extensions: 'pi:extensions', skills: 'pi:skills', testConnection: 'pi:test-connection', providerConfig: 'pi:provider-config', providerTypes: 'pi:provider-types', saveProviderKey: 'pi:save-provider-key',
  setToolApprovalMode: 'pi:set-tool-approval-mode',
  engineStatus: 'pi:engine-status', engineVersions: 'pi:engine-versions', engineInstall: 'pi:engine-install', engineActivate: 'pi:engine-activate', engineUninstall: 'pi:engine-uninstall', engineDeactivate: 'pi:engine-deactivate',
  packages: 'pi:packages', packageInstall: 'pi:package-install', packageUpdate: 'pi:package-update', packageRemove: 'pi:package-remove', packageCheck: 'pi:package-check',
  subagents: 'pi:subagents', subagentSave: 'pi:subagent-save', subagentDelete: 'pi:subagent-delete',
  dingtalkConfig: 'pi:dingtalk-config', dingtalkSaveConfig: 'pi:dingtalk-save-config',
  dingtalkStart: 'pi:dingtalk-start', dingtalkStop: 'pi:dingtalk-stop', dingtalkStatus: 'pi:dingtalk-status',
  dingtalkChanged: 'pi:dingtalk-changed',
  changed: 'pi:changed',
} as const

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && ['off','minimal','low','medium','high','xhigh','max'].includes(value)
}

export function isToolApprovalMode(value: unknown): value is ToolApprovalMode {
  return value === 'ask' || value === 'managed'
}

export function isEngineVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value)
}

/** Whitelist for package sources: `npm:name` or `git:url`, no whitespace/control chars. */
export function isPackageSource(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 4 && value.length <= 512
    && /^(npm|git):[^\s"'`$&;|<>]+$/.test(value)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Group id: a short identifier ('g' + 8 hex chars). Never user-controlled.
 */
export function isSessionGroupName(value: unknown): value is string {
  return isBoundedString(value, 1, 64)
}

/** Bounded list of canonical directory paths for a group (1..20 entries). */
export function isGroupDirs(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return false
  for (const dir of value) {
    if (typeof dir !== 'string' || dir.length < 1 || dir.length > 1024) return false
  }
  return true
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

export const MAX_ATTACHED_IMAGES = 5
export const MAX_ATTACHED_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * Validates an image-attachment list for IPC: array of { data, mimeType }
 * entries with base64 data (no data: URL prefix) and an image/* mime type,
 * bounded in count and per-image size (base64 expands ~1.33×, so the byte
 * budget is measured against the base64 length / 4 * 3).
 */
export function isImageAttachments(value: unknown): value is ImageAttachment[] {
  if (!Array.isArray(value)) return false
  if (value.length > MAX_ATTACHED_IMAGES) return false
  for (const item of value) {
    if (!isPlainObject(item)) return false
    const { data, mimeType } = item as Record<string, unknown>
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(data)) return false
    if (typeof mimeType !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(mimeType)) return false
    if (Math.floor(data.replace(/\s/g, '').length / 4) * 3 > MAX_ATTACHED_IMAGE_BYTES) return false
  }
  return true
}

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
