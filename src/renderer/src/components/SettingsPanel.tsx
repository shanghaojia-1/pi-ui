import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Bot, Image as ImageIcon, LoaderCircle, Pencil, Plus, RefreshCw, RotateCcw, Search, TriangleAlert, X } from 'lucide-react'
import type {
  AppSnapshot,
  CustomProviderApi,
  DingtalkConfig,
  DingtalkStatus,
  EngineStatus,
  ExtensionsInfo,
  PackagesInfo,
  ProviderStatus,
  ProviderTypeInfo,
  SettingsPatch,
  SettingsSnapshot,
  SkillsInfo,
  SubagentConfig,
  SubagentEdit,
  ThinkingLevel,
  ToolApprovalMode,
} from '@shared/contracts'
import { CUSTOM_PROVIDER_APIS, HTTP_IDLE_TIMEOUT_MAX_MS, HTTP_IDLE_TIMEOUT_MIN_MS } from '../../../shared/contracts'
import { errorMessage } from '../hooks'
import { formatDuration, formatTime, formatTokens } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { THEMES, useTheme, type ThemeId } from '../lib/theme'

const AUTH_KEYS: Record<ProviderStatus['authStatus'], string> = {
  stored: 'settings.auth.stored',
  runtime: 'settings.auth.runtime',
  environment: 'settings.auth.environment',
  fallback: 'settings.auth.fallback',
  'models-json': 'settings.auth.modelsJson',
  none: 'settings.auth.none',
  error: 'settings.auth.error',
}

/** DingTalk bridge states surfaced as translated labels in the status card. */
const DINGTALK_STATE_KEYS: Record<DingtalkStatus['state'], string> = {
  disabled: 'settings.dingtalk.state.disabled',
  stopped: 'settings.dingtalk.state.stopped',
  connecting: 'settings.dingtalk.state.connecting',
  connected: 'settings.dingtalk.state.connected',
  error: 'settings.dingtalk.state.error',
}

/** Tool presets offered as click-to-toggle chips in the subagent editor. */
const SUBAGENT_TOOL_OPTIONS = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']

const THINKING_KEYS: { value: ThinkingLevel; labelKey: string }[] = [
  { value: 'off', labelKey: 'topbar.thinking.off' },
  { value: 'minimal', labelKey: 'topbar.thinking.minimal' },
  { value: 'low', labelKey: 'topbar.thinking.low' },
  { value: 'medium', labelKey: 'topbar.thinking.medium' },
  { value: 'high', labelKey: 'topbar.thinking.high' },
  { value: 'xhigh', labelKey: 'topbar.thinking.xhigh' },
  { value: 'max', labelKey: 'topbar.thinking.max' },
]

const TIMEOUT_MIN_S = HTTP_IDLE_TIMEOUT_MIN_MS / 1000
const TIMEOUT_MAX_S = HTTP_IDLE_TIMEOUT_MAX_MS / 1000

/** One model draft in the New/Edit-provider dialog (id is the unique key). */
interface CustomModelDraft {
  id: string
  /** Optional display name; falls back to the id. */
  name?: string | undefined
  /** Context window in tokens; undefined = engine default. */
  contextWindow?: number | undefined
  /** Supported input formats; undefined = text-only default. */
  input?: ('text' | 'image')[] | undefined
}

/** Settings sections shown in the left navigation rail. */
const NAV_ITEMS = [
  { id: 'appearance', labelKey: 'settings.appearance' },
  { id: 'providers', labelKey: 'settings.providers' },
  { id: 'subagents', labelKey: 'settings.subagents' },
  { id: 'skills', labelKey: 'settings.skills' },
  { id: 'extensions', labelKey: 'settings.extensions' },
  { id: 'engine', labelKey: 'settings.engine' },
  { id: 'defaults', labelKey: 'settings.defaults' },
  { id: 'dingtalk', labelKey: 'settings.dingtalk' },
  { id: 'approval', labelKey: 'settings.approval' },
] as const
type NavId = (typeof NAV_ITEMS)[number]['id']

type BusyAction = 'refresh' | 'save' | 'approval' | 'custom' | 'delete' | null

interface LiveMessage {
  kind: 'success' | 'error' | 'info'
  text: string
}

interface SettingsPanelProps {
  snapshot: AppSnapshot
  onClose: () => void
  /** Landing section to scroll to and focus once the sheet loads. */
  initialSection?: 'approval' | null
}

/**
 * Right-side settings sheet (Codex style). All state lives in this component:
 * snapshot updates never touch the draft, so streaming while the dialog is
 * open cannot lose unsaved edits. Keys are runtime-only by contract: they are
 * sent over IPC and never written to storage or the URL.
 */
export default function SettingsPanel({ snapshot, onClose, initialSection }: SettingsPanelProps) {
  const { t, lang, setLang } = useI18n()
  const { theme, setTheme } = useTheme()
  const [phase, setPhase] = useState<'loading' | 'error' | 'ready'>('loading')
  const [loadMessage, setLoadMessage] = useState('')
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [live, setLive] = useState<LiveMessage | null>(null)
  const [approvalStatus, setApprovalStatus] = useState<LiveMessage | null>(null)

  // DingTalk robot bridge: persisted config + live status + busy guard.
  const [dingtalkConfig, setDingtalkConfig] = useState<DingtalkConfig | null>(null)
  const [dingtalkStatus, setDingtalkStatus] = useState<DingtalkStatus | null>(null)
  const [dingtalkBusy, setDingtalkBusy] = useState(false)
  // Form draft (initialized from the persisted config on mount).
  const [dingtalkEnabled, setDingtalkEnabled] = useState(false)
  const [dingtalkClientId, setDingtalkClientId] = useState('')
  const [dingtalkClientSecret, setDingtalkClientSecret] = useState('')
  const [dingtalkAllowText, setDingtalkAllowText] = useState('')

  // Draft of editable default settings; initialized from the loaded snapshot.
  // `baseline` is the last persisted snapshot: the save patch is derived by
  // diffing the draft against it, so only changed fields are ever sent and
  // provider/model are never injected as null.
  const [baseline, setBaseline] = useState<SettingsSnapshot | null>(null)
  const [defaultProvider, setDefaultProvider] = useState<string | null>(null)
  const [defaultModel, setDefaultModel] = useState<string | null>(null)
  const [thinking, setThinking] = useState<ThinkingLevel>('medium')
  const [compaction, setCompaction] = useState(false)
  const [retry, setRetry] = useState(false)
  const [notify, setNotify] = useState(false)
  const [timeoutSec, setTimeoutSec] = useState(String(TIMEOUT_MIN_S))
  const [extensionsInfo, setExtensionsInfo] = useState<ExtensionsInfo | null>(null)
  const [skillsInfo, setSkillsInfo] = useState<SkillsInfo | null>(null)
  const [skillQuery, setSkillQuery] = useState('')
  /** User-level subagent definitions for the Subagents section. */
  const [subagents, setSubagents] = useState<SubagentConfig[] | null>(null)
  /** Subagent editor state: open + the file key being edited (null = create). */
  const [subagentEditor, setSubagentEditor] = useState<{
    open: boolean
    editingName: string | null
    name: string
    description: string
    /** Selected model id (empty = follow the default model). */
    model: string
    /** Selected tool ids (empty = the agent's own defaults). */
    tools: string[]
    systemPrompt: string
  }>({ open: false, editingName: null, name: '', description: '', model: '', tools: [], systemPrompt: '' })
  /** Configured packages (pi package manager) for the Extensions section. */
  const [packagesInfo, setPackagesInfo] = useState<PackagesInfo | null>(null)
  const [packageInput, setPackageInput] = useState('')
  const [packageBusy, setPackageBusy] = useState<null | 'install' | 'update' | 'remove' | 'check'>(null)
  /** Engine-management state (loaded engine + installed external versions). */
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null)
  /** Compatible versions fetched from the npm registry (null = not fetched). */
  const [registryVersions, setRegistryVersions] = useState<string[] | null>(null)
  const [engineInput, setEngineInput] = useState('')
  const [engineBusy, setEngineBusy] = useState<null | 'install' | 'activate' | 'delete' | 'fetch' | 'deactivate'>(null)
  // Custom-provider form (adds a provider to the agent's models.json).
  const [customOpen, setCustomOpen] = useState(false)
  /** Provider id being edited (null = creating a new provider). */
  const [editingId, setEditingId] = useState<string | null>(null)
  /** Editing a pi built-in key-only config (no custom baseUrl/models). */
  const [editingBuiltin, setEditingBuiltin] = useState(false)
  const [customId, setCustomId] = useState('')
  const [customName, setCustomName] = useState('')
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [customApi, setCustomApi] = useState<CustomProviderApi>('openai-completions')
  const [customApiKey, setCustomApiKey] = useState('')
  /** Models of the new provider, added one by one. */
  const [customModels, setCustomModels] = useState<CustomModelDraft[]>([])
  const [modelInput, setModelInput] = useState('')
  /** Selectable provider types (pi built-ins + custom), from main. */
  const [providerTypes, setProviderTypes] = useState<ProviderTypeInfo[]>([])
  /** Connection-test state for the New-provider modal. */
  const [testResult, setTestResult] = useState<{ testing: boolean } | { testing: false; ok: boolean; status: number | null; kind: 'ok' | 'auth' | 'http' | 'network' }>({ testing: false })

  const sheetRef = useRef<HTMLElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  /** Currently active settings partition (tab-style isolation). */
  const [activeNav, setActiveNav] = useState<NavId>(initialSection === 'approval' ? 'approval' : 'appearance')
  // Only the section requested at open time is auto-focused; once handled it
  // is cleared so a later re-render can never re-scroll the sheet.
  const pendingSectionRef = useRef<'approval' | null>(initialSection ?? null)

  // Configured providers shown as a read-only list in the Providers section.
  const providers = settings?.providers ?? []
  // "Configured" means a credential is present: stored / runtime / env /
  // fallback / models.json keys count; `none` (no API key) is excluded.
  const configuredProviders = providers.filter((p) => p.authStatus !== 'none')
  const anyBusy = busy !== null
  // Parsed DingTalk allowlist lines (trimmed, empty lines dropped); also
  // drives the empty-allowlist warning.
  const dingtalkAllowLines = dingtalkAllowText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

  const load = useCallback(async () => {
    setPhase('loading')
    setLoadMessage('')
    try {
      const s = await window.pi.getSettings()
      setSettings(s)
      setBaseline(s)
      setDefaultProvider(s.defaultProvider)
      setDefaultModel(s.defaultModel)
      setThinking(s.defaultThinkingLevel)
      setCompaction(s.compactionEnabled)
      setRetry(s.retryEnabled)
      setNotify(s.notifyOnCompletion)
      setTimeoutSec(String(Math.round(s.httpIdleTimeoutMs / 1000)))
      setPhase('ready')
    } catch (e) {
      setLoadMessage(errorMessage(e))
      setPhase('error')
    }
  }, [])

  // Mount = open: remember the trigger, focus the close button; on unmount
  // restore focus so keyboard users land back where they opened the dialog.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    void load()
    const closeBtn = sheetRef.current?.querySelector<HTMLButtonElement>('[data-sett-close]')
    closeBtn?.focus()
    return () => {
      restoreFocusRef.current?.focus()
    }
  }, [load])

  // Loaded-extension inventory for the Extensions section.
  useEffect(() => {
    window.pi.getExtensions().then(setExtensionsInfo, () => setExtensionsInfo(null))
  }, [])

  // Loaded skills and discovery diagnostics for the Skills section.
  useEffect(() => {
    window.pi.getSkills().then(setSkillsInfo, () => setSkillsInfo(null))
  }, [])

  // User-level subagents for the Subagents section.
  useEffect(() => {
    window.pi.listSubagents().then(setSubagents, () => setSubagents(null))
  }, [])

  // Configured packages for the Extensions section (pi package manager).
  useEffect(() => {
    window.pi.getPackages().then(setPackagesInfo, () => setPackagesInfo(null))
  }, [])

  // Engine status for the Engine section (active engine + installed versions).
  useEffect(() => {
    window.pi.getEngineStatus().then(setEngineStatus, () => setEngineStatus(null))
  }, [])

  // Provider type catalog (pi built-ins + custom) for the New-provider modal.
  useEffect(() => {
    window.pi.getProviderTypes().then(setProviderTypes, () => setProviderTypes([]))
  }, [])

  // DingTalk robot bridge: initialize the config draft and subscribe to live
  // status pushes from main (unsubscribe on unmount).
  useEffect(() => {
    let cancelled = false
    void Promise.all([window.pi.getDingtalkConfig(), window.pi.getDingtalkStatus()]).then(
      ([cfg, status]) => {
        if (cancelled) return
        setDingtalkConfig(cfg)
        setDingtalkEnabled(cfg.enabled)
        setDingtalkClientId(cfg.clientId)
        setDingtalkClientSecret(cfg.clientSecret)
        setDingtalkAllowText(cfg.allowList.join('\n'))
        setDingtalkStatus(status)
      },
      () => {
        if (!cancelled) setDingtalkStatus(null)
      },
    )
    const unsubscribe = window.pi.onDingtalkStatus((status) => {
      if (!cancelled) setDingtalkStatus(status)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // When opened from the TopBar approval badge: land on the danger partition
  // (scroll it into view) and put focus on its switch.
  useEffect(() => {
    if (phase !== 'ready' || pendingSectionRef.current !== 'approval') return
    const section = sheetRef.current?.querySelector<HTMLElement>('[data-sett-approval]')
    if (!section) return
    pendingSectionRef.current = null
    setActiveNav('approval')
    section.querySelector<HTMLElement>('[data-sett-approval-toggle]')?.focus()
  }, [phase])

  const closeSheet = useCallback((): void => {
    onClose()
  }, [onClose])

  const onSheetKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape') {
      // Do not let the app-level Escape handler abort the run / blur behind us.
      e.stopPropagation()
      closeSheet()
      return
    }
    if (e.key !== 'Tab' || !sheetRef.current) return
    const focusables = Array.from(
      sheetRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    )
    if (focusables.length === 0) return
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const refreshEngineStatus = async (): Promise<void> => {
    const status = await window.pi.getEngineStatus()
    setEngineStatus(status)
  }

  /** Switches the visible partition; the rail owns focus via arrow keys. */
  const goToSection = (id: NavId): void => {
    setActiveNav(id)
  }

  /** Roving focus on the nav rail: ArrowUp/Down cycle, Home/End jump. */
  const onNavKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    let next: number
    if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = NAV_ITEMS.length - 1
    else next = e.key === 'ArrowDown' ? Math.min(index + 1, NAV_ITEMS.length - 1) : Math.max(index - 1, 0)
    const item = NAV_ITEMS[next]!
    setActiveNav(item.id)
    navRef.current?.querySelectorAll<HTMLButtonElement>('.sett-nav-item')[next]?.focus()
  }

  const fetchRegistryVersions = async (): Promise<void> => {
    if (engineBusy !== null) return
    setEngineBusy('fetch')
    try {
      const versions = await window.pi.getEngineVersions()
      setRegistryVersions(versions)
    } catch {
      setLive({ kind: 'error', text: t('settings.engine.listFailed') })
    } finally {
      setEngineBusy(null)
    }
  }

  const installEngine = async (): Promise<void> => {
    const version = engineInput.trim()
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      setLive({ kind: 'error', text: t('settings.engine.versionInvalid') })
      return
    }
    if (engineBusy !== null) return
    setEngineBusy('install')
    try {
      await window.pi.installEngine(version)
      setLive({ kind: 'success', text: t('settings.engine.installedOk', { version }) })
      setEngineInput('')
      setRegistryVersions(null)
      await refreshEngineStatus()
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setEngineBusy(null)
    }
  }

  const activateEngine = async (version: string): Promise<void> => {
    if (engineBusy !== null) return
    setEngineBusy('activate')
    try {
      await window.pi.activateEngine(version)
      setLive({ kind: 'success', text: t('settings.engine.activateOk', { version }) })
      await refreshEngineStatus()
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setEngineBusy(null)
    }
  }

  const deactivateEngine = async (): Promise<void> => {
    if (engineBusy !== null) return
    setEngineBusy('deactivate')
    try {
      await window.pi.deactivateEngine()
      setLive({ kind: 'success', text: t('settings.engine.deactivated') })
      await refreshEngineStatus()
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setEngineBusy(null)
    }
  }

  const deleteEngine = async (version: string): Promise<void> => {
    if (engineBusy !== null) return
    setEngineBusy('delete')
    try {
      await window.pi.uninstallEngine(version)
      setLive({ kind: 'success', text: t('settings.engine.deleted', { version }) })
      if (engineStatus?.active?.source === 'userdata' && engineStatus.active.version === version) {
        setRegistryVersions(null)
      }
      await refreshEngineStatus()
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setEngineBusy(null)
    }
  }

  const refreshPackages = async (): Promise<void> => {
    const info = await window.pi.getPackages()
    setPackagesInfo(info)
  }

  const installPackage = async (): Promise<void> => {
    const source = packageInput.trim()
    if (!/^(npm|git):[^\s"'`$&;|<>]+$/.test(source)) {
      setLive({ kind: 'error', text: t('settings.packageSourceInvalid') })
      return
    }
    if (packageBusy !== null) return
    setPackageBusy('install')
    try {
      await window.pi.installPackage(source)
      setLive({ kind: 'success', text: t('settings.packageInstalledOk', { source }) })
      setPackageInput('')
      const [packages, extensions] = await Promise.all([window.pi.getPackages(), window.pi.getExtensions()])
      setPackagesInfo(packages)
      setExtensionsInfo(extensions)
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setPackageBusy(null)
    }
  }

  const updatePackage = async (source?: string): Promise<void> => {
    if (packageBusy !== null) return
    setPackageBusy('update')
    try {
      await window.pi.updatePackages(source)
      const label = source ?? t('settings.packages')
      setLive({ kind: 'success', text: t('settings.packageUpdatedOk', { source: label }) })
      await refreshPackages()
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setPackageBusy(null)
    }
  }

  const removePackage = async (source: string): Promise<void> => {
    if (packageBusy !== null) return
    if (!window.confirm(t('settings.packageRemoveConfirm', { source }))) return
    setPackageBusy('remove')
    try {
      await window.pi.removePackage(source)
      setLive({ kind: 'success', text: t('settings.packageRemovedOk', { source }) })
      const [packages, extensions] = await Promise.all([window.pi.getPackages(), window.pi.getExtensions()])
      setPackagesInfo(packages)
      setExtensionsInfo(extensions)
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setPackageBusy(null)
    }
  }

  const checkPackageUpdates = async (): Promise<void> => {
    if (packageBusy !== null) return
    setPackageBusy('check')
    try {
      const updates = await window.pi.checkPackageUpdates()
      if (updates.length === 0) {
        setLive({ kind: 'success', text: t('settings.packageNoUpdates') })
      } else {
        setLive({ kind: 'info', text: t('settings.packageUpdatesFound', { n: updates.length }) })
        setPackagesInfo((prev) => (prev ? { ...prev, updateSources: updates } : prev))
      }
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setPackageBusy(null)
    }
  }

  const openNewSubagent = (): void => {
    setSubagentEditor({ open: true, editingName: null, name: '', description: '', model: '', tools: [], systemPrompt: '' })
  }

  const openEditSubagent = (agent: SubagentConfig): void => {
    setSubagentEditor({
      open: true,
      editingName: agent.name,
      name: agent.name,
      description: agent.description,
      model: agent.model ?? '',
      tools: agent.tools ?? [],
      systemPrompt: agent.systemPrompt,
    })
  }

  const toggleSubagentTool = (tool: string): void => {
    setSubagentEditor((prev) => ({
      ...prev,
      tools: prev.tools.includes(tool) ? prev.tools.filter((t) => t !== tool) : [...prev.tools, tool],
    }))
  }

  const closeSubagentEditor = (): void => {
    setSubagentEditor((prev) => ({ ...prev, open: false }))
  }

  const saveSubagent = async (): Promise<void> => {
    if (anyBusy) return
    const name = subagentEditor.name.trim()
    const description = subagentEditor.description.trim()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
      setLive({ kind: 'error', text: t('settings.subagentNameRequired') })
      return
    }
    if (description === '') {
      setLive({ kind: 'error', text: t('settings.subagentDescRequired') })
      return
    }
    setBusy('save')
    try {
      const edit: SubagentEdit = {
        name,
        description,
        systemPrompt: subagentEditor.systemPrompt,
        ...(subagentEditor.model.trim() !== '' ? { model: subagentEditor.model.trim() } : {}),
        ...(subagentEditor.tools.length > 0 ? { tools: subagentEditor.tools } : {}),
      }
      const list = await window.pi.saveSubagent(name, edit)
      setSubagents(list)
      setLive({ kind: 'success', text: t('settings.saved') })
      closeSubagentEditor()
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  const deleteSubagent = async (name: string): Promise<void> => {
    if (anyBusy) return
    if (!window.confirm(t('settings.subagentDeleteConfirm', { name }))) return
    setBusy('delete')
    try {
      const list = await window.pi.deleteSubagent(name)
      setSubagents(list)
      setLive({ kind: 'success', text: t('settings.packageRemovedOk', { source: name }) })
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  const refresh = async (): Promise<void> => {
    if (anyBusy) return
    setBusy('refresh')
    setLive({ kind: 'info', text: t('settings.refreshingModels') })
    try {
      const s = await window.pi.refreshModels()
      setSettings(s)
      setLive(s.error !== null ? { kind: 'error', text: s.error.message } : { kind: 'success', text: t('settings.modelsRefreshed') })
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  /**
   * Selected provider type: 'custom' or a pi built-in id from providerTypes.
   */
  const [customType, setCustomType] = useState<string>('custom')
  const selectedType = providerTypes.find((p) => p.id === customType) ?? null

  const selectProviderType = (typeId: string): void => {
    setCustomType(typeId)
    // Built-in types carry their official endpoint (used by the connection
    // test and shown as a hint); custom leaves the URL to the user.
    const type = providerTypes.find((p) => p.id === typeId)
    if (type?.baseUrl !== undefined) setCustomBaseUrl(type.baseUrl)
    else setCustomBaseUrl('')
  }

  const addModel = (): void => {
    const id = modelInput.trim()
    if (id === '') {
      setLive({ kind: 'error', text: t('settings.modelIdRequired') })
      return
    }
    if (customModels.some((m) => m.id === id)) {
      setLive({ kind: 'error', text: t('settings.duplicateModel') })
      return
    }
    // cc-switch style: Enter or the button turns the typed ID into a card.
    setCustomModels((prev) => [...prev, { id }])
    setModelInput('')
    setLive(null)
  }

  /** Merges a partial patch into one model draft (id is the stable key). */
  const updateModel = (id: string, patch: Partial<CustomModelDraft>): void => {
    setCustomModels((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)))
  }

  /** Toggles image input for one model (text stays always on). */
  const toggleModelImage = (id: string): void => {
    setCustomModels((prev) =>
      prev.map((m) => (m.id !== id ? m : { ...m, input: m.input?.includes('image') ? undefined : ['text', 'image'] })),
    )
  }

  /** Batch action: every model accepts image input. */
  const enableImageForAll = (): void => {
    setCustomModels((prev) => prev.map((m) => ({ ...m, input: ['text', 'image'] })))
  }

  /** Tests the typed base URL + API key against the provider's /models endpoint. */
  const testConnection = async (): Promise<void> => {
    if (anyBusy) return
    const baseUrl = customBaseUrl.trim()
    if (baseUrl === '') {
      setLive({ kind: 'error', text: t('settings.customUrlInvalid') })
      return
    }
    setTestResult({ testing: true })
    try {
      // Editing an existing provider without retyping its key: main falls
      // back to the key stored in models.json (the form never shows it).
      const result = await window.pi.testProviderConnection({
        ...(editingId !== null ? { providerId: editingId } : {}),
        baseUrl,
        api: customApi,
        ...(customApiKey.trim() !== '' ? { apiKey: customApiKey.trim() } : {}),
      })
      setTestResult({ testing: false, ok: result.ok, status: result.status, kind: result.kind })
    } catch {
      setTestResult({ testing: false, ok: false, status: null, kind: 'network' })
    }
  }

  const closeCustomModal = (): void => {
    setCustomOpen(false)
    setTestResult({ testing: false })
    setLive(null)
  }

  /** Resets every New/Edit-provider form field (live message untouched). */
  const resetCustomForm = (): void => {
    setEditingId(null)
    setEditingBuiltin(false)
    setCustomId('')
    setCustomName('')
    setCustomBaseUrl('')
    setCustomApi('openai-completions')
    setCustomApiKey('')
    setCustomModels([])
    setModelInput('')
    setCustomType('custom')
    setTestResult({ testing: false })
  }

  const openNewProvider = (): void => {
    resetCustomForm()
    setLive(null)
    setCustomOpen(true)
  }

  /** Opens the edit dialog pre-filled from models.json (API key never shown). */
  const openEditProvider = async (id: string): Promise<void> => {
    resetCustomForm()
    setLive(null)
    try {
      const config = await window.pi.getProviderConfig(id)
      if (config === null) {
        setLive({ kind: 'error', text: t('settings.providerLoadFailed') })
        return
      }
      setEditingId(id)
      setEditingBuiltin(config.builtin)
      setCustomType(config.builtin ? id : 'custom')
      setCustomId(config.id)
      setCustomName(config.name ?? '')
      setCustomBaseUrl(config.baseUrl)
      setCustomApi(config.api)
      setCustomModels(
        config.models.map((m) => ({
          id: m.id,
          ...(m.name !== undefined && m.name !== '' ? { name: m.name } : {}),
          ...(m.input !== undefined && m.input.length > 0 ? { input: m.input } : {}),
          ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
        })),
      )
      setCustomOpen(true)
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    }
  }

  const saveCustom = async (): Promise<void> => {
    if (anyBusy) return
    // Built-in flow: pick a pi provider type, fill the key, done.
    const builtinForm = editingId !== null ? editingBuiltin : customType !== 'custom'
    if (builtinForm) {
      const providerId = editingId ?? customType
      const key = customApiKey.trim()
      if (providerId === 'custom' || providerId === '') {
        setLive({ kind: 'error', text: t('settings.providerTypeRequired') })
        return
      }
      if (key === '') {
        setLive({ kind: 'error', text: t('settings.providerKeyRequired') })
        return
      }
      setBusy('custom')
      setLive({ kind: 'info', text: t('settings.addingCustom') })
      try {
        const s = await window.pi.saveProviderKey(providerId, key)
        setSettings(s)
        if (s.error !== null) {
          setLive({ kind: 'error', text: s.error.message })
        } else {
          const type = providerTypes.find((p) => p.id === providerId)
          setLive({ kind: 'success', text: editingId !== null
            ? t('settings.customUpdated', { name: type?.name ?? providerId })
            : t('settings.customAdded', { name: type?.name ?? providerId }) })
          setCustomOpen(false)
          resetCustomForm()
        }
      } catch (e) {
        setLive({ kind: 'error', text: errorMessage(e) })
      } finally {
        setBusy(null)
      }
      return
    }
    const id = customId.trim()
    const baseUrl = customBaseUrl.trim()
    const models = customModels
    if (id === '' || baseUrl === '' || models.length === 0) {
      setLive({ kind: 'error', text: t('settings.customValidation') })
      return
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      setLive({ kind: 'error', text: t('settings.customUrlInvalid') })
      return
    }
    // Per-model validation before the payload leaves the UI: the main-process
    // whitelist rejects the whole config otherwise, with a generic failure.
    for (const m of models) {
      if (m.name !== undefined && m.name.length > 128) {
        setLive({ kind: 'error', text: t('settings.modelNameTooLong') })
        return
      }
      if (m.contextWindow !== undefined && (!Number.isInteger(m.contextWindow) || m.contextWindow < 1)) {
        setLive({ kind: 'error', text: t('settings.modelContextInvalid') })
        return
      }
    }
    setBusy('custom')
    setLive({ kind: 'info', text: t('settings.addingCustom') })
    const key = customApiKey.trim()
    try {
      const s = await window.pi.addCustomProvider({
        id,
        ...(customName.trim() !== '' ? { name: customName.trim() } : {}),
        baseUrl,
        api: customApi,
        ...(key !== '' ? { apiKey: key } : {}),
        models: models.map((m) => ({
          id: m.id,
          ...(m.name !== undefined && m.name.trim() !== '' && m.name.trim() !== m.id
            ? { name: m.name.trim() }
            : {}),
          ...(m.input?.includes('image') ? { input: ['text', 'image'] as const } : {}),
          ...(m.contextWindow !== undefined && Number.isInteger(m.contextWindow) && m.contextWindow >= 1
            ? { contextWindow: m.contextWindow }
            : {}),
        })),
      })
      setSettings(s)
      if (s.error !== null) {
        setLive({ kind: 'error', text: s.error.message })
      } else {
        setLive({ kind: 'success', text: editingId !== null
          ? t('settings.customUpdated', { name: customName.trim() !== '' ? customName.trim() : id })
          : t('settings.customAdded', { name: customName.trim() !== '' ? customName.trim() : id }) })
        // Reset and collapse the form; the provider list now reflects it.
        setCustomOpen(false)
        resetCustomForm()
      }
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  /**
   * Tool-approval switch. The dangerous ask→managed enable is confirmed by a
   * native dialog in main; a cancellation returns 'ask' unchanged. The UI
   * never enables optimistically: the returned snapshot is merged in and its
   * real mode drives the switch, so a cancelled dialog, a failed store write
   * or an IPC rejection all leave the switch reflecting main's truth. The
   * merge never touches the defaults draft or the typed API key.
   */
  const toggleApproval = async (): Promise<void> => {
    if (anyBusy || settings === null) return
    const target: ToolApprovalMode = settings.toolApprovalMode === 'managed' ? 'ask' : 'managed'
    setBusy('approval')
    setApprovalStatus({
      kind: 'info',
      text: target === 'managed' ? t('settings.approvalRequesting') : t('settings.approvalDisabling'),
    })
    try {
      const s = await window.pi.setToolApprovalMode(target)
      setSettings(s)
      if (s.error !== null) {
        setApprovalStatus({ kind: 'error', text: s.error.message })
      } else if (s.toolApprovalMode === 'managed' && target === 'ask') {
        // Defensive: a disable request that came back still managed.
        setApprovalStatus({ kind: 'error', text: t('settings.approvalStillManaged') })
      } else if (s.toolApprovalMode === 'managed') {
        setApprovalStatus({ kind: 'success', text: t('settings.approvalEnabled') })
      } else if (target === 'managed') {
        setApprovalStatus({ kind: 'info', text: t('settings.approvalCancelled') })
      } else {
        setApprovalStatus({ kind: 'success', text: t('settings.approvalDisabled') })
      }
    } catch (e) {
      setApprovalStatus({ kind: 'error', text: errorMessage(e) })
      // Re-sync so the switch reflects the mode main really persisted.
      try {
        const s = await window.pi.getSettings()
        setSettings(s)
      } catch {
        /* keep the last known settings */
      }
    } finally {
      setBusy(null)
    }
  }

  /**
   * DingTalk robot bridge. The allowlist textarea holds one staffId per line:
   * each line is trimmed and empty lines are dropped before the config leaves
   * the UI. The returned status drives the state card; an error state is
   * surfaced in the live bar.
   */
  const saveDingtalk = async (): Promise<void> => {
    if (dingtalkBusy || dingtalkConfig === null) return
    setDingtalkBusy(true)
    try {
      const status = await window.pi.saveDingtalkConfig({
        enabled: dingtalkEnabled,
        clientId: dingtalkClientId.trim(),
        clientSecret: dingtalkClientSecret,
        allowList: dingtalkAllowLines,
      })
      setDingtalkStatus(status)
      setLive(
        status.state === 'error'
          ? { kind: 'error', text: t('settings.dingtalk.saveFailed') }
          : { kind: 'success', text: t('settings.dingtalk.saved') },
      )
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setDingtalkBusy(false)
    }
  }

  const connectDingtalk = async (): Promise<void> => {
    if (dingtalkBusy) return
    setDingtalkBusy(true)
    try {
      setDingtalkStatus(await window.pi.startDingtalk())
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setDingtalkBusy(false)
    }
  }

  const disconnectDingtalk = async (): Promise<void> => {
    if (dingtalkBusy) return
    setDingtalkBusy(true)
    try {
      setDingtalkStatus(await window.pi.stopDingtalk())
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setDingtalkBusy(false)
    }
  }

  const saveDefaults = async (): Promise<void> => {
    if (anyBusy) return
    const sec = Number(timeoutSec)
    if (!Number.isFinite(sec) || sec < TIMEOUT_MIN_S || sec > TIMEOUT_MAX_S) {
      setLive({ kind: 'error', text: t('settings.timeoutInvalid', { min: TIMEOUT_MIN_S, max: TIMEOUT_MAX_S }) })
      return
    }
    if (Object.keys(patch).length === 0) {
      setLive({ kind: 'info', text: t('settings.noChanges') })
      return
    }
    setBusy('save')
    setLive({ kind: 'info', text: t('settings.savingDefaults') })
    try {
      const s = await window.pi.updateSettings(patch)
      setSettings(s)
      if (s.error !== null) {
        setLive({ kind: 'error', text: s.error.message })
      } else {
        setBaseline(s)
        // Success: align the draft with the persisted values.
        setDefaultProvider(s.defaultProvider)
        setDefaultModel(s.defaultModel)
        setThinking(s.defaultThinkingLevel)
        setCompaction(s.compactionEnabled)
        setRetry(s.retryEnabled)
        setNotify(s.notifyOnCompletion)
        setTimeoutSec(String(Math.round(s.httpIdleTimeoutMs / 1000)))
        setLive({ kind: 'success', text: t('settings.saved') })
      }
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  // The default model carries its provider (same as the topbar selector), so
  // the Defaults section has a single picker instead of provider + model.
  const modelOptions = useMemo(
    () =>
      snapshot.models.map((m) => ({
        value: `${m.provider}:${m.id}`,
        label: `${m.provider} · ${m.name || m.id}`,
        provider: m.provider,
        id: m.id,
      })),
    [snapshot.models],
  )

  const filteredSkills = useMemo(() => {
    if (skillsInfo === null) return []
    const query = skillQuery.trim().toLocaleLowerCase()
    if (query === '') return skillsInfo.skills
    return skillsInfo.skills.filter((skill) =>
      [skill.name, skill.description, skill.filePath, skill.source]
        .some((value) => value.toLocaleLowerCase().includes(query)),
    )
  }, [skillQuery, skillsInfo])
  // The currently selected option value, or '' for "follow last".
  const currentModelValue = useMemo(
    () => modelOptions.find((o) => o.provider === defaultProvider && o.id === defaultModel)?.value ?? '',
    [modelOptions, defaultProvider, defaultModel],
  )

  // The save patch is a diff against the persisted baseline: only changed,
  // user-editable fields are sent, never null. Provider/model are included
  // only when non-empty AND a valid pair (the model must belong to the
  // provider). With no provider/model chosen, thinking/compaction/retry/
  // timeout can still be saved on their own.
  const patch = useMemo((): SettingsPatch => {
    if (baseline === null) return {}
    const p: SettingsPatch = {}
    if (thinking !== baseline.defaultThinkingLevel) p.defaultThinkingLevel = thinking
    if (compaction !== baseline.compactionEnabled) p.compactionEnabled = compaction
    if (retry !== baseline.retryEnabled) p.retryEnabled = retry
    if (notify !== baseline.notifyOnCompletion) p.notifyOnCompletion = notify
    const sec = Number(timeoutSec)
    if (Number.isFinite(sec) && Math.round(sec) * 1000 !== baseline.httpIdleTimeoutMs) {
      p.httpIdleTimeoutMs = Math.round(sec) * 1000
    }
    // A picked default model always saves a valid provider+model pair; the
    // empty "follow last" option clears the draft and sends neither.
    if (defaultModel !== null && defaultModel !== baseline.defaultModel) {
      const opt = modelOptions.find((o) => o.provider === defaultProvider && o.id === defaultModel)
      if (opt !== undefined) {
        p.defaultModel = defaultModel
        if (opt.provider !== baseline.defaultProvider) p.defaultProvider = opt.provider
      }
    }
    return p
  }, [baseline, thinking, compaction, retry, notify, timeoutSec, defaultProvider, defaultModel, modelOptions])

  const dirty = Object.keys(patch).length > 0
  // Current approval policy: the settings snapshot returned by main (never an
  // optimistic local flip). While settings are still loading the switch is
  // simply not rendered, and the TopBar badge keeps using the AppSnapshot.
  const approvalMode: ToolApprovalMode = settings?.toolApprovalMode ?? snapshot.toolApprovalMode
  // The New/Edit dialog runs a built-in flow (pick a pi type, fill the key)
  // unless a custom provider is being created or edited.
  const isBuiltinForm = editingId !== null ? editingBuiltin : customType !== 'custom'

  return (
    // Clicking the backdrop (outside the sheet) closes the settings; clicks
    // inside the sheet — or inside the nested New-provider modal — never do.
    <div
      className="sett-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSheet()
      }}
    >
      <section
        className="sett-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sett-title"
        ref={sheetRef}
        onKeyDown={onSheetKeyDown}
      >
        <header className="sett-head">
          <h2 id="sett-title" className="sett-title">
            {t('settings.title')}
          </h2>
          <button type="button" className="btn-icon" data-sett-close onClick={closeSheet} aria-label={t('settings.close')}>
            <X size={15} aria-hidden="true" />
          </button>
        </header>
        <div className="sett-live" role="status" aria-live="polite">
          {live !== null ? <span className={`sett-live-text sett-live-${live.kind}`}>{live.text}</span> : null}
        </div>
        <div className="sett-body">
          <nav className="sett-nav" aria-label={t('settings.sections')} ref={navRef}>
            {NAV_ITEMS.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={`sett-nav-item${activeNav === item.id ? ' sett-nav-item-active' : ''}`}
                aria-current={activeNav === item.id ? 'true' : undefined}
                onClick={() => goToSection(item.id)}
                onKeyDown={(e) => onNavKeyDown(e, index)}
              >
                {t(item.labelKey)}
              </button>
            ))}
          </nav>
          <div className="sett-scroll">
          {phase === 'loading' ? (
            <div className="sett-state">
              <LoaderCircle size={22} className="sett-spin" aria-hidden="true" />
              <p>{t('settings.loading')}</p>
            </div>
          ) : phase === 'error' ? (
            <div className="sett-state">
              <TriangleAlert size={22} aria-hidden="true" />
              <p>{t('settings.loadFailed')}{loadMessage}</p>
              <button type="button" className="btn" onClick={() => void load()}>
                <RotateCcw size={13} aria-hidden="true" />
                {t('common.retry')}
              </button>
            </div>
          ) : settings === null ? null : (
            <>
              {/* Appearance: language + theme (UI-local preferences). */}
              {activeNav === 'appearance' ? (
              <section className="sett-section" aria-labelledby="sett-appearance-title" data-sett-nav-target="appearance">
                <h3 id="sett-appearance-title">{t('settings.appearance')}</h3>
                <p className="sett-hint">{t('settings.appearanceHint')}</p>
                <div className="sett-field">
                  <label htmlFor="sett-lang">{t('settings.language')}</label>
                  <select
                    id="sett-lang"
                    className="sett-select"
                    value={lang}
                    onChange={(e) => setLang(e.target.value as 'zh' | 'en')}
                  >
                    <option value="zh">{t('settings.language.zh')}</option>
                    <option value="en">{t('settings.language.en')}</option>
                  </select>
                </div>
                <div className="sett-field">
                  <label>{t('settings.theme')}</label>
                  <div className="sett-theme-row" role="radiogroup" aria-label={t('settings.theme')}>
                    {THEMES.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="radio"
                        aria-checked={theme === item.id}
                        className={`sett-theme${theme === item.id ? ' sett-theme-active' : ''}`}
                        onClick={() => setTheme(item.id as ThemeId)}
                        title={t(item.labelKey)}
                      >
                        <span
                          className={`sett-theme-swatch${item.artwork === undefined ? '' : ' sett-theme-swatch-artwork'}`}
                          style={
                            item.artwork === undefined
                              ? { background: item.swatch }
                              : {
                                  backgroundImage: `url(${JSON.stringify(item.artwork)})`,
                                  backgroundPosition: item.artworkPosition ?? 'center',
                                }
                          }
                          aria-hidden="true"
                        />
                        <span className="sett-theme-copy">
                          <span>{t(item.labelKey)}</span>
                          {item.hintKey !== undefined ? <small>{t(item.hintKey)}</small> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </section>
              ) : null}

              {activeNav === 'providers' ? (
              <section className="sett-section" aria-labelledby="sett-providers-title" data-sett-nav-target="providers">
                <div className="sett-section-head">
                  <h3 id="sett-providers-title">{t('settings.providers')}</h3>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={anyBusy}
                    onClick={openNewProvider}
                  >
                    <Plus size={13} aria-hidden="true" />
                    {t('settings.newProvider')}
                  </button>
                </div>
                <p className="sett-hint">{t('settings.providersHint')}</p>
                <div className="sett-provider-actions">
                  <button type="button" className="btn" disabled={anyBusy} onClick={() => void refresh()}>
                    <RefreshCw size={13} aria-hidden="true" />
                    {busy === 'refresh' ? t('settings.refreshing') : t('settings.refreshModels')}
                  </button>
                </div>
                {configuredProviders.length > 0 ? (
                  <>
                    <h4 className="sett-subtitle">{t('settings.providersConfigured')}</h4>
                    <div className="sett-provider-list">
                      {configuredProviders.map((p) => (
                        <div className="sett-provider-card" key={p.id}>
                          <div className="sett-provider-card-line">
                            <span className="sett-provider-card-name" title={p.id}>{p.name}</span>
                            <span className="sett-provider-card-actions">
                              <button
                                type="button"
                                className="btn-icon sett-provider-edit"
                                aria-label={t('settings.editProvider')}
                                title={t('settings.editProvider')}
                                disabled={anyBusy}
                                onClick={() => void openEditProvider(p.id)}
                              >
                                <Pencil size={11} aria-hidden="true" />
                              </button>
                              <span className={`rp-auth rp-auth-${p.authStatus}`}>{t(AUTH_KEYS[p.authStatus])}</span>
                            </span>
                          </div>
                          <div className="sett-provider-card-sub">
                            <code>{p.id}</code>
                            <span>{t('settings.models', { n: p.availableModelCount })}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
              </section>
              ) : null}

              {activeNav === 'subagents' ? (
              <section className="sett-section" aria-labelledby="sett-subagents-title" data-sett-nav-target="subagents">
                <div className="sett-section-head">
                  <h3 id="sett-subagents-title">{t('settings.subagents')}</h3>
                  <button type="button" className="btn btn-primary" disabled={anyBusy} onClick={openNewSubagent}>
                    <Plus size={13} aria-hidden="true" />
                    {t('settings.subagentNew')}
                  </button>
                </div>
                <p className="sett-hint">{t('settings.subagentsHint')}</p>
                {subagentEditor.open ? (
                  <div className="sett-custom sett-subagent-form">
                    <div className="sett-custom-grid">
                      <div className="sett-field">
                        <label htmlFor="subagent-name">{t('settings.subagentName')}</label>
                        <input
                          id="subagent-name"
                          className="sett-input"
                          value={subagentEditor.name}
                          disabled={anyBusy || subagentEditor.editingName !== null}
                          onChange={(e) => setSubagentEditor((prev) => ({ ...prev, name: e.target.value }))}
                        />
                      </div>
                      <div className="sett-field">
                        <label htmlFor="subagent-desc">{t('settings.subagentDescription')}</label>
                        <input
                          id="subagent-desc"
                          className="sett-input"
                          value={subagentEditor.description}
                          disabled={anyBusy}
                          onChange={(e) => setSubagentEditor((prev) => ({ ...prev, description: e.target.value }))}
                        />
                      </div>
                      <div className="sett-field">
                        <label htmlFor="subagent-model">{t('settings.subagentModel')}</label>
                        <select
                          id="subagent-model"
                          className="sett-select"
                          value={subagentEditor.model}
                          disabled={anyBusy}
                          onChange={(e) => setSubagentEditor((prev) => ({ ...prev, model: e.target.value }))}
                        >
                          <option value="">{t('settings.subagentModelDefault')}</option>
                          {modelOptions.map((o) => (
                            <option key={`${o.provider}:${o.id}`} value={o.id}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                      <div className="sett-field">
                        <label>{t('settings.subagentTools')}</label>
                        <div className="sett-subagent-tool-opts" role="group" aria-label={t('settings.subagentTools')}>
                          {SUBAGENT_TOOL_OPTIONS.map((tool) => (
                            <button
                              key={tool}
                              type="button"
                              className={`sett-subagent-tool-opt${subagentEditor.tools.includes(tool) ? ' sett-subagent-tool-opt-active' : ''}`}
                              aria-pressed={subagentEditor.tools.includes(tool)}
                              disabled={anyBusy}
                              onClick={() => toggleSubagentTool(tool)}
                            >
                              {tool}
                            </button>
                          ))}
                        </div>
                        <span className="sett-field-hint">{t('settings.subagentToolsHint')}</span>
                      </div>
                    </div>
                    <div className="sett-field">
                      <label htmlFor="subagent-prompt">{t('settings.subagentPrompt')}</label>
                      <textarea
                        id="subagent-prompt"
                        className="sett-textarea"
                        rows={8}
                        value={subagentEditor.systemPrompt}
                        disabled={anyBusy}
                        onChange={(e) => setSubagentEditor((prev) => ({ ...prev, systemPrompt: e.target.value }))}
                      />
                    </div>
                    <div className="sett-custom-actions">
                      <button type="button" className="btn btn-primary" disabled={anyBusy} onClick={() => void saveSubagent()}>
                        {busy === 'save' ? t('settings.saving') : t('settings.subagentSave')}
                      </button>
                      <button type="button" className="btn" disabled={anyBusy} onClick={closeSubagentEditor}>
                        {t('settings.subagentCancel')}
                      </button>
                    </div>
                  </div>
                ) : null}
                {subagents === null ? (
                  <div className="sett-state sett-state-inline">
                    <LoaderCircle size={16} className="sett-spin" aria-hidden="true" />
                  </div>
                ) : subagents.length === 0 ? (
                  <p className="sett-hint">{t('settings.subagentNoAgents')}</p>
                ) : (
                  <div className="sett-provider-list">
                    {subagents.map((agent) => (
                      <div className="sett-provider-card" key={agent.name}>
                        <div className="sett-provider-card-line">
                          <span className="sett-provider-card-name" title={agent.filePath}>{agent.name}</span>
                          <span className="sett-provider-card-actions">
                            <button
                              type="button"
                              className="btn-icon sett-provider-edit"
                              aria-label={t('settings.subagentEdit')}
                              title={t('settings.subagentEdit')}
                              disabled={anyBusy}
                              onClick={() => openEditSubagent(agent)}
                            >
                              <Pencil size={11} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="btn-icon"
                              aria-label={t('settings.subagentDelete')}
                              title={t('settings.subagentDelete')}
                              disabled={anyBusy}
                              onClick={() => void deleteSubagent(agent.name)}
                            >
                              <X size={11} aria-hidden="true" />
                            </button>
                          </span>
                        </div>
                        <div className="sett-provider-card-sub">
                          <span className="sett-subagent-desc">{agent.description}</span>
                          {agent.model !== undefined ? <code>{agent.model}</code> : null}
                        </div>
                        {agent.tools !== undefined && agent.tools.length > 0 ? (
                          <div className="sett-subagent-tools">
                            {agent.tools.map((tool) => (
                              <span className="sett-subagent-tool" key={tool}>{tool}</span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </section>
              ) : null}

              {activeNav === 'skills' ? (
              <section className="sett-section" aria-labelledby="sett-skills-title" data-sett-nav-target="skills">
                <div className="sett-section-head">
                  <h3 id="sett-skills-title">{t('settings.skills')}</h3>
                  <button
                    type="button"
                    className="btn"
                    disabled={anyBusy}
                    onClick={() => {
                      setBusy('refresh')
                      window.pi
                        .reloadSession()
                        .then(async () => {
                          const info = await window.pi.getSkills()
                          setSkillsInfo(info)
                          setLive({ kind: 'success', text: t('settings.skillsReloaded') })
                        })
                        .catch((e: unknown) => setLive({ kind: 'error', text: errorMessage(e) }))
                        .finally(() => setBusy(null))
                    }}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    {busy === 'refresh' ? t('settings.refreshing') : t('settings.reloadSkills')}
                  </button>
                </div>
                <p className="sett-hint">{t('settings.skillsHint')}</p>
                {skillsInfo === null ? (
                  <div className="sett-state sett-state-inline">
                    <LoaderCircle size={16} className="sett-spin" aria-hidden="true" />
                  </div>
                ) : (
                  <>
                    <div className="sett-skill-toolbar">
                      <span className="sett-skill-count">
                        {t('settings.skillCount', { n: skillsInfo.skills.length })}
                      </span>
                      <label className="sett-skill-search">
                        <Search size={13} aria-hidden="true" />
                        <input
                          type="search"
                          value={skillQuery}
                          onChange={(event) => setSkillQuery(event.target.value)}
                          placeholder={t('settings.skillSearchPlaceholder')}
                          aria-label={t('settings.skillSearch')}
                        />
                        {skillQuery !== '' ? (
                          <button
                            type="button"
                            className="btn-icon"
                            onClick={() => setSkillQuery('')}
                            aria-label={t('settings.skillSearchClear')}
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        ) : null}
                      </label>
                    </div>

                    {skillsInfo.skills.length === 0 ? (
                      <p className="sett-hint">{t('settings.noSkills')}</p>
                    ) : filteredSkills.length === 0 ? (
                      <p className="sett-hint">{t('settings.noSkillMatches')}</p>
                    ) : (
                      <div className="sett-skill-list">
                        {filteredSkills.map((skill) => (
                          <details className="sett-skill" key={skill.filePath}>
                            <summary className="sett-skill-summary">
                              <span className="sett-skill-main">
                                <span className="sett-skill-title-row">
                                  <span className="sett-skill-name">{skill.name}</span>
                                  <span className={`sett-skill-scope sett-skill-scope-${skill.sourceLabel}`}>
                                    {t(`settings.skillSource.${skill.sourceLabel}`)}
                                  </span>
                                </span>
                                <span className="sett-skill-description">
                                  {skill.description || t('settings.skillNoDescription')}
                                </span>
                              </span>
                            </summary>
                            <div className="sett-skill-details">
                              <div>
                                <span>{t('settings.skillPath')}</span>
                                <code title={skill.filePath}>{skill.filePath}</code>
                              </div>
                              <div>
                                <span>{t('settings.skillSourceLabel')}</span>
                                <code>{skill.source}</code>
                                <small>{t(`settings.skillOrigin.${skill.origin}`)}</small>
                              </div>
                              <div>
                                <span>{t('settings.skillInvocation')}</span>
                                <strong>
                                  {skill.disableModelInvocation
                                    ? t('settings.skillInvocation.manual')
                                    : t('settings.skillInvocation.auto')}
                                </strong>
                                <code>/skill:{skill.name}</code>
                              </div>
                            </div>
                          </details>
                        ))}
                      </div>
                    )}

                    {skillsInfo.diagnostics.length > 0 ? (
                      <div className="sett-skill-diagnostics">
                        <p>{t('settings.skillDiagnostics')}</p>
                        {skillsInfo.diagnostics.map((diagnostic, index) => (
                          <div
                            className={`sett-skill-diagnostic sett-skill-diagnostic-${diagnostic.type}`}
                            key={`${diagnostic.type}:${diagnostic.path ?? ''}:${index}`}
                          >
                            <span>{diagnostic.message}</span>
                            {diagnostic.path !== null ? <code>{diagnostic.path}</code> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </section>
              ) : null}

              {activeNav === 'extensions' ? (
              <section className="sett-section" aria-labelledby="sett-extensions-title" data-sett-nav-target="extensions">
                <div className="sett-section-head">
                  <h3 id="sett-extensions-title">{t('settings.extensions')}</h3>
                  <button
                    type="button"
                    className="btn"
                    disabled={anyBusy}
                    onClick={() => {
                      setBusy('refresh')
                      window.pi
                        .reloadSession()
                        .then(async () => {
                          const info = await window.pi.getExtensions()
                          setExtensionsInfo(info)
                          setLive({ kind: 'success', text: t('settings.modelsRefreshed') })
                        })
                        .catch((e: unknown) => setLive({ kind: 'error', text: errorMessage(e) }))
                        .finally(() => setBusy(null))
                    }}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    {busy === 'refresh' ? t('settings.refreshing') : t('settings.reloadExtensions')}
                  </button>
                </div>
                <p className="sett-hint">{t('settings.extensionsHint')}</p>
                {extensionsInfo === null ? (
                  <div className="sett-state sett-state-inline">
                    <LoaderCircle size={16} className="sett-spin" aria-hidden="true" />
                  </div>
                ) : extensionsInfo.extensions.length === 0 && extensionsInfo.errors.length === 0 ? (
                  <p className="sett-hint">{t('settings.noExtensions')}</p>
                ) : (
                  <div className="sett-extension-list">
                    {extensionsInfo.extensions.map((extension) => (
                      <div className="sett-extension" key={extension.resolvedPath}>
                        <div className="sett-extension-main">
                          <span className="sett-extension-name" title={extension.path}>
                            {extension.name}
                          </span>
                          <span className="sett-extension-source">
                            {t(`settings.extensionsSource.${extension.sourceLabel}`)}
                            {extension.version !== null ? ` · v${extension.version}` : ''}
                          </span>
                        </div>
                        <span className="sett-extension-meta">
                          <span>{t('settings.extensionsCommands', { n: extension.commandCount })}</span>
                          <span>{t('settings.extensionsTools', { n: extension.toolCount })}</span>
                          <span>{t('settings.extensionsHandlers', { n: extension.handlerCount })}</span>
                        </span>
                      </div>
                    ))}
                    {extensionsInfo.errors.length > 0 ? (
                      <div className="sett-extension-errors">
                        <p>{t('settings.extensionsErrors')}</p>
                        {extensionsInfo.errors.map((error) => (
                          <div key={error.path} className="sett-extension-error">
                            <code>{error.path}</code>: {error.error}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}

                <p className="sett-hint">{t('settings.packages')}</p>
                <p className="sett-hint">{t('settings.packagesHint')}</p>
                {packagesInfo === null ? (
                  <div className="sett-state sett-state-inline">
                    <LoaderCircle size={16} className="sett-spin" aria-hidden="true" />
                  </div>
                ) : (
                  <>
                    {packagesInfo.packages.length === 0 ? (
                      <p className="sett-hint">{t('settings.packageNone')}</p>
                    ) : (
                      <div className="sett-extension-list">
                        {packagesInfo.packages.map((pkg) => {
                          const updatable = packagesInfo.updateSources.includes(pkg.source)
                          return (
                            <div className="sett-extension" key={pkg.source}>
                              <div className="sett-extension-main">
                                <span className="sett-extension-name">{pkg.displayName}</span>
                                <span className="sett-extension-source">
                                  {pkg.type} · {pkg.scope}
                                  {updatable ? ` · ${t('settings.packageUpdated')}` : ''}
                                </span>
                              </div>
                              <span className="sett-extension-meta">
                                <span>{pkg.version ?? t('settings.packageVersionUnknown')}</span>
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={packageBusy !== null}
                                  onClick={() => void updatePackage(pkg.source)}
                                >
                                  {t('settings.packageUpdate')}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-danger"
                                  disabled={packageBusy !== null}
                                  onClick={() => void removePackage(pkg.source)}
                                >
                                  {t('settings.packageRemove')}
                                </button>
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    <div className="sett-engine-install">
                      <input
                        type="text"
                        className="input"
                        value={packageInput}
                        onChange={(e) => setPackageInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void installPackage() }}
                        placeholder={t('settings.packageInstallPh')}
                        aria-label={t('settings.packageInstallPh')}
                      />
                      <button
                        type="button"
                        className="btn"
                        disabled={packageBusy !== null}
                        onClick={() => void installPackage()}
                      >
                        {packageBusy === 'install' ? t('settings.packageInstalling') : t('settings.packageInstall')}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={packageBusy !== null}
                        onClick={() => void checkPackageUpdates()}
                      >
                        {packageBusy === 'check' ? t('settings.packageChecking') : t('settings.packageCheck')}
                      </button>
                    </div>
                  </>
                )}
              </section>
              ) : null}

              {activeNav === 'engine' ? (
              <section className="sett-section" aria-labelledby="sett-engine-title" data-sett-nav-target="engine">
                <div className="sett-section-head">
                  <h3 id="sett-engine-title">{t('settings.engine')}</h3>
                </div>
                <p className="sett-hint">{t('settings.engineHint')}</p>
                <p className="sett-hint">{t('settings.engine.supportedRange', { range: engineStatus?.supportedRange ?? '' })}</p>
                {engineStatus === null ? (
                  <div className="sett-state sett-state-inline">
                    <LoaderCircle size={16} className="sett-spin" aria-hidden="true" />
                  </div>
                ) : (
                  <>
                    <div className="sett-engine-current">
                      <span className="sett-engine-name">
                        {t('settings.engine.current')}: {engineStatus.active?.version ?? '—'}
                      </span>
                      <span className="sett-extension-source">
                        {engineStatus.active === null
                          ? t('settings.engine.builtin')
                          : t(`settings.engine.${engineStatus.active.source}`)}
                      </span>
                      {engineStatus.active !== null ? (
                        <span className={engineStatus.compatible ? 'sett-engine-ok' : 'sett-engine-warn'}>
                          {engineStatus.compatible
                            ? t('settings.engine.compatible')
                            : t('settings.engine.incompatible', { range: engineStatus.supportedRange })}
                        </span>
                      ) : null}
                    </div>
                    {engineStatus.error !== null ? (
                      <div className="sett-extension-errors">
                        <p>{t('settings.engine.loadError', { error: engineStatus.error })}</p>
                      </div>
                    ) : null}
                    <p className="sett-hint">{t('settings.engine.installed')}</p>
                    {engineStatus.installed.length === 0 ? (
                      <p className="sett-hint">{t('settings.engine.noneInstalled')}</p>
                    ) : (
                      <div className="sett-extension-list">
                        {engineStatus.installed.map((version) => {
                          const isActive = engineStatus.active?.source === 'userdata' && engineStatus.active.version === version
                          return (
                            <div className="sett-extension" key={version}>
                              <div className="sett-extension-main">
                                <span className="sett-extension-name">{version}</span>
                                <span className="sett-extension-source">
                                  {isActive ? t('settings.engine.active') : ''}
                                </span>
                              </div>
                              <div className="sett-extension-meta">
                                {!isActive ? (
                                  <button
                                    type="button"
                                    className="btn"
                                    disabled={engineBusy !== null}
                                    onClick={() => void activateEngine(version)}
                                  >
                                    {t('settings.engine.activate')}
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className="btn btn-danger"
                                  disabled={engineBusy !== null}
                                  onClick={() => void deleteEngine(version)}
                                >
                                  {t('settings.engine.delete')}
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    <div className="sett-engine-install">
                      <input
                        type="text"
                        className="input"
                        value={engineInput}
                        onChange={(e) => setEngineInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void installEngine() }}
                        placeholder={t('settings.engine.versionPh')}
                        aria-label={t('settings.engine.versionPh')}
                      />
                      <button
                        type="button"
                        className="btn"
                        disabled={engineBusy !== null}
                        onClick={() => void installEngine()}
                      >
                        {engineBusy === 'install' ? t('settings.engine.installing') : t('settings.engine.install')}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={engineBusy !== null}
                        onClick={() => void fetchRegistryVersions()}
                      >
                        {engineBusy === 'fetch' ? t('settings.engine.fetchingVersions') : t('settings.engine.fetchVersions')}
                      </button>
                    </div>
                    {registryVersions !== null && registryVersions.length > 0 ? (
                      <div className="sett-engine-registry">
                        {registryVersions.slice(0, 10).map((version) => (
                          <button
                            type="button"
                            key={version}
                            className="btn"
                            disabled={engineBusy !== null}
                            onClick={() => { setEngineInput(version); void installEngine() }}
                          >
                            {version}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {!engineStatus.npm.available ? (
                      <div className="sett-extension-errors">
                        <p>{t('settings.engine.manualInstall')}</p>
                        <code className="sett-engine-cmd">
                          npm install --prefix &quot;{engineStatus.installDir}/&lt;版本&gt;&quot; --no-audit --no-fund @earendil-works/pi-coding-agent@&lt;版本&gt;
                        </code>
                        <p className="sett-hint">{t('settings.engine.manualInstallDir', { dir: engineStatus.installDir })}</p>
                      </div>
                    ) : null}
                    <p className="sett-hint">{t('settings.engine.restartHint')}</p>
                  </>
                )}
              </section>
              ) : null}

              {activeNav === 'defaults' ? (
              <section className="sett-section" aria-labelledby="sett-defaults-title" data-sett-nav-target="defaults">
                <h3 id="sett-defaults-title">{t('settings.defaults')}</h3>
                <p className="sett-hint">{t('settings.defaultsHint')}</p>
                <div className="sett-field">
                  <label htmlFor="sett-model">{t('settings.defaultModel')}</label>
                  <select
                    id="sett-model"
                    className="sett-select"
                    value={currentModelValue}
                    disabled={modelOptions.length === 0 || anyBusy}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '') {
                        setDefaultProvider(null)
                        setDefaultModel(null)
                        return
                      }
                      const opt = modelOptions.find((o) => o.value === v)
                      if (opt === undefined) return
                      setDefaultProvider(opt.provider)
                      setDefaultModel(opt.id)
                    }}
                  >
                    <option value="">{t('settings.followLast')}</option>
                    {modelOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {modelOptions.length === 0 ? (
                    <span className="sett-field-hint">{t('settings.noModelsHint')}</span>
                  ) : null}
                </div>
                <div className="sett-field">
                  <label htmlFor="sett-thinking">{t('settings.defaultThinking')}</label>
                  <select
                    id="sett-thinking"
                    className="sett-select"
                    value={thinking}
                    disabled={anyBusy}
                    onChange={(e) => {
                      setThinking(e.target.value as ThinkingLevel)
                    }}
                  >
                    {THINKING_KEYS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {t(o.labelKey)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sett-toggle-row">
                  <label className="sett-toggle">
                    <input
                      type="checkbox"
                      checked={compaction}
                      disabled={anyBusy}
                      onChange={(e) => {
                        setCompaction(e.target.checked)
                      }}
                    />
                    {t('settings.autoCompact')}
                  </label>
                  <label className="sett-toggle">
                    <input
                      type="checkbox"
                      checked={retry}
                      disabled={anyBusy}
                      onChange={(e) => {
                        setRetry(e.target.checked)
                      }}
                    />
                    {t('settings.autoRetry')}
                  </label>
                  <label className="sett-toggle">
                    <input
                      type="checkbox"
                      checked={notify}
                      disabled={anyBusy}
                      onChange={(e) => {
                        setNotify(e.target.checked)
                      }}
                    />
                    {t('settings.notifyOnCompletion')}
                  </label>
                </div>
                <div className="sett-field">
                  <label htmlFor="sett-timeout">{t('settings.httpTimeout')}</label>
                  <input
                    id="sett-timeout"
                    type="number"
                    className="sett-input sett-input-narrow"
                    min={TIMEOUT_MIN_S}
                    max={TIMEOUT_MAX_S}
                    step={1}
                    value={timeoutSec}
                    disabled={anyBusy}
                    onChange={(e) => {
                      setTimeoutSec(e.target.value)
                    }}
                  />
                  <span className="sett-field-hint">
                    {t('settings.timeoutRange', { min: TIMEOUT_MIN_S, max: TIMEOUT_MAX_S })}
                  </span>
                </div>
                <div className="sett-readonly" aria-label={t('settings.readonly')}>
                  <span>
                    {t('settings.reserveTokens')} <strong>{settings.compaction.reserveTokens !== null ? formatTokens(settings.compaction.reserveTokens) : '—'}</strong>
                  </span>
                  <span>
                    {t('settings.keepRecent')} <strong>{settings.compaction.keepRecentTokens !== null ? formatTokens(settings.compaction.keepRecentTokens) : '—'}</strong>
                  </span>
                  <span>
                    {t('settings.maxRetries')} <strong>{settings.retry.maxRetries !== null ? t('settings.retries', { n: settings.retry.maxRetries }) : '—'}</strong>
                  </span>
                  <span>
                    {t('settings.retryDelay')} <strong>{settings.retry.baseDelayMs !== null ? formatDuration(settings.retry.baseDelayMs) : '—'}</strong>
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={anyBusy || !dirty}
                  onClick={() => void saveDefaults()}
                >
                  {busy === 'save' ? t('settings.saving') : t('settings.saveDefaults')}
                </button>
              </section>
              ) : null}

              {activeNav === 'dingtalk' ? (
                <section className="sett-section" aria-labelledby="sett-dingtalk-title" data-sett-nav-target="dingtalk">
                <div className="sett-section-head">
                  <h3 id="sett-dingtalk-title">{t('settings.dingtalk')}</h3>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={dingtalkBusy}
                    onClick={() => void saveDingtalk()}
                  >
                    <Bot size={13} aria-hidden="true" />
                    {t('settings.dingtalk.save')}
                  </button>
                </div>
                <p className="sett-hint">{t('settings.dingtalkHint')}</p>
                <label className="sett-switch-row">
                  <span className="sett-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={dingtalkEnabled}
                      disabled={dingtalkBusy}
                      aria-label={t('settings.dingtalkEnabled')}
                      onChange={(e) => setDingtalkEnabled(e.target.checked)}
                    />
                    <span className="sett-switch-track" aria-hidden="true" />
                  </span>
                  <span className="sett-switch-text">
                    <span className="sett-switch-title">{t('settings.dingtalkEnabled')}</span>
                  </span>
                </label>
                <div className="sett-field">
                  <label htmlFor="dingtalk-client-id">{t('settings.dingtalkClientId')}</label>
                  <input
                    id="dingtalk-client-id"
                    className="sett-input"
                    value={dingtalkClientId}
                    disabled={dingtalkBusy}
                    onChange={(e) => setDingtalkClientId(e.target.value)}
                  />
                </div>
                <div className="sett-field">
                  <label htmlFor="dingtalk-client-secret">{t('settings.dingtalkClientSecret')}</label>
                  <input
                    id="dingtalk-client-secret"
                    type="password"
                    className="sett-input"
                    autoComplete="off"
                    value={dingtalkClientSecret}
                    disabled={dingtalkBusy}
                    onChange={(e) => setDingtalkClientSecret(e.target.value)}
                  />
                </div>
                <div className="sett-field">
                  <label htmlFor="dingtalk-allow-list">{t('settings.dingtalkAllowList')}</label>
                  <textarea
                    id="dingtalk-allow-list"
                    className="sett-textarea"
                    rows={4}
                    value={dingtalkAllowText}
                    disabled={dingtalkBusy}
                    onChange={(e) => setDingtalkAllowText(e.target.value)}
                  />
                  <span className="sett-field-hint">{t('settings.dingtalkAllowListHint')}</span>
                </div>
                {dingtalkEnabled && dingtalkAllowLines.length === 0 ? (
                  <p className="sett-live" role="status">
                    <span className="sett-live-text sett-live-error">{t('settings.dingtalk.warnAllowAll')}</span>
                  </p>
                ) : null}
                {dingtalkStatus !== null ? (
                  <div className="sett-readonly" aria-label={t('settings.dingtalkStatus')}>
                    <span>
                      {t('settings.dingtalkStatus')}: <strong>{t(DINGTALK_STATE_KEYS[dingtalkStatus.state])}</strong>
                      {dingtalkStatus.detail !== null ? ` — ${dingtalkStatus.detail}` : ''}
                    </span>
                    {dingtalkStatus.connectedAt !== null ? (
                      <span>
                        {t('settings.dingtalk.connectedAt')}
                        <strong>{formatTime(new Date(dingtalkStatus.connectedAt).toISOString())}</strong>
                      </span>
                    ) : null}
                    {dingtalkStatus.lastSender !== null ? (
                      <span>
                        {t('settings.dingtalk.lastSender')}
                        <strong>{dingtalkStatus.lastSender}</strong>
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <div className="sett-provider-actions">
                  {dingtalkStatus?.state === 'connected' ? (
                    <button type="button" className="btn btn-danger" disabled={dingtalkBusy} onClick={() => void disconnectDingtalk()}>
                      {t('settings.dingtalk.disconnect')}
                    </button>
                  ) : (
                    <button type="button" className="btn" disabled={dingtalkBusy} onClick={() => void connectDingtalk()}>
                      {t('settings.dingtalk.connect')}
                    </button>
                  )}
                </div>
                <p className="sett-hint">{t('settings.dingtalk.guide')}</p>
              </section>
              ) : null}

              {activeNav === 'approval' ? (
              <section
                className={`sett-section sett-approval${approvalMode === 'managed' ? ' sett-approval-managed' : ''}`}
                aria-labelledby="sett-approval-title"
                data-sett-nav-target="approval"
                data-sett-approval
              >
                <h3 id="sett-approval-title">
                  {t('settings.approval')}
                  <span className={`sett-approval-pill sett-approval-pill-${approvalMode}`}>
                    {approvalMode === 'managed' ? t('settings.approvalPillManaged') : t('settings.approvalPillAsk')}
                  </span>
                </h3>
                <p className="sett-approval-note">
                  {approvalMode === 'managed'
                    ? t('settings.approvalManagedNote')
                    : t('settings.approvalAskNote')}
                </p>
                <label className="sett-switch-row">
                  <span className="sett-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      data-sett-approval-toggle
                      checked={approvalMode === 'managed'}
                      disabled={anyBusy}
                      aria-label={t('settings.approvalAria')}
                      onChange={() => void toggleApproval()}
                    />
                    <span className="sett-switch-track" aria-hidden="true" />
                  </span>
                  <span className="sett-switch-text">
                    <span className="sett-switch-title">{t('settings.approvalSwitchTitle')}</span>
                    <span className="sett-switch-sub">
                      {approvalMode === 'managed'
                        ? t('settings.approvalSwitchManaged')
                        : t('settings.approvalSwitchAsk')}
                    </span>
                  </span>
                </label>
                <div className="sett-approval-status" role="status" aria-live="polite">
                  {approvalStatus !== null ? (
                    <span className={`sett-approval-status-${approvalStatus.kind}`}>{approvalStatus.text}</span>
                  ) : null}
                </div>
              </section>
              ) : null}
            </>
          )}
          </div>
        </div>
      </section>

      {/* New-provider modal: a real dialog instead of an inline block. */}
      {customOpen ? (
        <div
          className="stats-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t(editingId !== null ? 'settings.customTitleEdit' : 'settings.customTitle')}
          onClick={closeCustomModal}
        >
          <div className="stats-box sett-custom-modal" onClick={(e) => e.stopPropagation()}>
            <div className="stats-head">
              <h3>{t(editingId !== null ? 'settings.customTitleEdit' : 'settings.customTitle')}</h3>
              <button type="button" className="btn-icon" onClick={closeCustomModal} aria-label={t('common.close')}>
                <X size={15} aria-hidden="true" />
              </button>
            </div>
            <p className="sett-hint">{t('settings.customHint')}</p>
            {/* Step 1: pick a provider type — pi built-ins + custom. */}
            <div className="sett-field">
              <label htmlFor="provider-type">{t('settings.providerType')}</label>
              <select
                id="provider-type"
                className="sett-select"
                value={customType}
                disabled={anyBusy || editingId !== null}
                onChange={(e) => selectProviderType(e.target.value)}
              >
                <option value="custom">{t('settings.type.custom')}</option>
                {providerTypes.map((pt) => (
                  <option key={pt.id} value={pt.id}>
                    {pt.name}{pt.configured ? t('settings.providerTypeConfigured') : ''}
                  </option>
                ))}
              </select>
            </div>
            {isBuiltinForm ? (
              <>
                {selectedType?.baseUrl !== undefined ? (
                  <p className="sett-hint">{t('settings.builtinEndpoint', { url: selectedType.baseUrl })}</p>
                ) : null}
                {/* Step 2: the API key — base URL, API flavor and the model
                    catalog come from pi's built-in provider. */}
                <div className="sett-field">
                  <label htmlFor="custom-key">{t('settings.customKey')}</label>
                  <input
                    id="custom-key"
                    type="password"
                    className="sett-input"
                    autoComplete="new-password"
                    placeholder={t(editingId !== null ? 'settings.customKeyUpdatePh' : 'settings.providerKeyPh')}
                    value={customApiKey}
                    disabled={anyBusy}
                    onChange={(e) => setCustomApiKey(e.target.value)}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="sett-custom-grid">
                  <div className="sett-field">
                    <label htmlFor="custom-id">{t('settings.customId')}</label>
                    <input
                      id="custom-id"
                      className="sett-input"
                      placeholder={t('settings.customIdPh')}
                      value={customId}
                      disabled={anyBusy || editingId !== null}
                      onChange={(e) => setCustomId(e.target.value)}
                    />
                  </div>
                  <div className="sett-field">
                    <label htmlFor="custom-name">{t('settings.customName')}</label>
                    <input
                      id="custom-name"
                      className="sett-input"
                      placeholder={t('settings.customNamePh')}
                      value={customName}
                      disabled={anyBusy}
                      onChange={(e) => setCustomName(e.target.value)}
                    />
                  </div>
                  <div className="sett-field">
                    <label htmlFor="custom-url">{t('settings.customUrl')}</label>
                    <input
                      id="custom-url"
                      className="sett-input"
                      placeholder={t('settings.customUrlPh')}
                      value={customBaseUrl}
                      disabled={anyBusy}
                      onChange={(e) => setCustomBaseUrl(e.target.value)}
                    />
                  </div>
                  <div className="sett-field">
                    <label htmlFor="custom-api">{t('settings.customApi')}</label>
                    <select
                      id="custom-api"
                      className="sett-select"
                      value={customApi}
                      disabled={anyBusy}
                      onChange={(e) => setCustomApi(e.target.value as CustomProviderApi)}
                    >
                      {CUSTOM_PROVIDER_APIS.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="sett-field">
                    <label htmlFor="custom-key">{t('settings.customKey')}</label>
                    <input
                      id="custom-key"
                      type="password"
                      className="sett-input"
                      autoComplete="new-password"
                      placeholder={t(editingId !== null ? 'settings.customKeyKeepPh' : 'settings.customKeyPh')}
                      value={customApiKey}
                      disabled={anyBusy}
                      onChange={(e) => setCustomApiKey(e.target.value)}
                    />
                  </div>
                  <div className="sett-field">
                    <label>{t('settings.modelsList')}</label>
                    <div className="sett-model-toolbar">
                      <span className="sett-field-hint">{t('settings.modelsListHint')}</span>
                      <button
                        type="button"
                        className="sett-model-all-image"
                        disabled={anyBusy || customModels.length === 0}
                        onClick={enableImageForAll}
                      >
                        <ImageIcon size={11} aria-hidden="true" />
                        {t('settings.imageAll')}
                      </button>
                    </div>
                    {customModels.length > 0 ? (
                      <div className="sett-model-list">
                        {customModels.map((model) => {
                          const image = model.input?.includes('image') ?? false
                          return (
                            <div className="sett-model-card" key={model.id}>
                              <div className="sett-model-card-head">
                                <span className="sett-model-id" title={model.id}>
                                  {model.id}
                                </span>
                                <span className="sett-model-card-actions">
                                  <span className="sett-model-badges">
                                    {model.contextWindow !== undefined && Number.isFinite(model.contextWindow) ? (
                                      <span className="sett-model-badge">
                                        {formatTokens(model.contextWindow)} tokens
                                      </span>
                                    ) : null}
                                    {image ? (
                                      <span className="sett-model-badge sett-model-badge-image">
                                        <ImageIcon size={10} aria-hidden="true" />
                                        {t('settings.modelInputImage')}
                                      </span>
                                    ) : null}
                                  </span>
                                  <button
                                    type="button"
                                    className="btn-icon"
                                    aria-label={t('settings.removeModel')}
                                    title={t('settings.removeModel')}
                                    disabled={anyBusy}
                                    onClick={() => setCustomModels((prev) => prev.filter((m) => m.id !== model.id))}
                                  >
                                    <X size={11} aria-hidden="true" />
                                  </button>
                                </span>
                              </div>
                              <div className="sett-model-card-grid">
                                <div className="sett-field">
                                  <label htmlFor={`model-name-${model.id}`}>{t('settings.modelName')}</label>
                                  <input
                                    id={`model-name-${model.id}`}
                                    className="sett-input"
                                    placeholder={t('settings.modelNamePh')}
                                    value={model.name ?? ''}
                                    disabled={anyBusy}
                                    onChange={(e) => updateModel(model.id, { name: e.target.value })}
                                  />
                                </div>
                                <div className="sett-field">
                                  <label htmlFor={`model-ctx-${model.id}`}>{t('settings.modelContext')}</label>
                                  <div className="sett-model-ctx">
                                    <input
                                      id={`model-ctx-${model.id}`}
                                      type="number"
                                      min={1}
                                      step={1}
                                      className="sett-input"
                                      placeholder={t('settings.modelContextPh')}
                                      value={model.contextWindow ?? ''}
                                      disabled={anyBusy}
                                      onChange={(e) => {
                                        const v = e.target.value
                                        updateModel(model.id, { contextWindow: v === '' ? undefined : Number(v) })
                                      }}
                                    />
                                    <span className="sett-model-ctx-unit">tokens</span>
                                  </div>
                                  {model.contextWindow !== undefined && Number.isInteger(model.contextWindow) && model.contextWindow >= 1 ? (
                                    <span className="sett-field-hint">≈ {formatTokens(model.contextWindow)}</span>
                                  ) : null}
                                </div>
                                <div className="sett-field">
                                  <label>{t('settings.modelInputFormat')}</label>
                                  <div className="sett-model-chips" role="group" aria-label={t('settings.modelInputFormat')}>
                                    <span className="sett-model-chip sett-model-chip-on">{t('settings.modelInputText')}</span>
                                    <button
                                      type="button"
                                      className={`sett-model-chip${image ? ' sett-model-chip-on' : ''}`}
                                      aria-pressed={image}
                                      disabled={anyBusy}
                                      onClick={() => toggleModelImage(model.id)}
                                    >
                                      <ImageIcon size={10} aria-hidden="true" />
                                      {t('settings.modelInputImage')}
                                    </button>
                                  </div>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    ) : null}
                    <div className="sett-model-add">
                      <input
                        className="sett-input"
                        placeholder={t('settings.modelIdPh')}
                        aria-label={t('settings.modelIdAria')}
                        value={modelInput}
                        disabled={anyBusy}
                        onChange={(e) => setModelInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addModel()
                          }
                        }}
                      />
                      <button type="button" className="btn" disabled={anyBusy} onClick={addModel}>
                        <Plus size={13} aria-hidden="true" />
                        {t('settings.addModel')}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
            <div className="sett-custom-actions">
              <button
                type="button"
                className="btn"
                disabled={anyBusy}
                onClick={() => void testConnection()}
              >
                {testResult.testing ? t('settings.testingConnection') : t('settings.testConnection')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={anyBusy}
                onClick={() => void saveCustom()}
              >
                {busy === 'custom' ? t('settings.addingProvider') : t(editingId !== null ? 'settings.saveProvider' : 'settings.addProvider')}
              </button>
              <button type="button" className="btn" disabled={anyBusy} onClick={closeCustomModal}>
                {t('common.cancel')}
              </button>
            </div>
            {editingId !== null && customApiKey.trim() === '' ? (
              <p className="sett-hint">{t('settings.testUsesSavedKey')}</p>
            ) : null}
            {!testResult.testing && 'kind' in testResult ? (
              <div
                className={`sett-test-result sett-test-${testResult.ok ? 'ok' : 'fail'}`}
                role="status"
                aria-live="polite"
              >
                {testResult.ok
                  ? t('settings.testOk')
                  : testResult.kind === 'auth'
                    ? t('settings.testAuth', { status: String(testResult.status ?? '') })
                    : testResult.kind === 'http'
                      ? t('settings.testHttp', { status: String(testResult.status ?? '') })
                      : t('settings.testNetwork')}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
