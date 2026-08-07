import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { LoaderCircle, Pencil, Plus, RefreshCw, RotateCcw, TriangleAlert, X } from 'lucide-react'
import type {
  AppSnapshot,
  CustomProviderApi,
  EngineStatus,
  ExtensionsInfo,
  ProviderStatus,
  ProviderTypeInfo,
  SettingsPatch,
  SettingsSnapshot,
  ThinkingLevel,
  ToolApprovalMode,
} from '@shared/contracts'
import { CUSTOM_PROVIDER_APIS, HTTP_IDLE_TIMEOUT_MAX_MS, HTTP_IDLE_TIMEOUT_MIN_MS } from '../../../shared/contracts'
import { errorMessage } from '../hooks'
import { formatDuration, formatTokens } from '../lib/format'
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

type BusyAction = 'refresh' | 'save' | 'approval' | 'custom' | null

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
  const [timeoutSec, setTimeoutSec] = useState(String(TIMEOUT_MIN_S))
  const [extensionsInfo, setExtensionsInfo] = useState<ExtensionsInfo | null>(null)
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
  const [customModels, setCustomModels] = useState<{ id: string }[]>([])
  const [modelInput, setModelInput] = useState('')
  const [customImage, setCustomImage] = useState(false)
  /** Selectable provider types (pi built-ins + custom), from main. */
  const [providerTypes, setProviderTypes] = useState<ProviderTypeInfo[]>([])
  /** Connection-test state for the New-provider modal. */
  const [testResult, setTestResult] = useState<{ testing: boolean } | { testing: false; ok: boolean; status: number | null; kind: 'ok' | 'auth' | 'http' | 'network' }>({ testing: false })

  const sheetRef = useRef<HTMLElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  // Only the section requested at open time is auto-focused; once handled it
  // is cleared so a later re-render can never re-scroll the sheet.
  const pendingSectionRef = useRef<'approval' | null>(initialSection ?? null)

  // Configured providers shown as a read-only list in the Providers section.
  const providers = settings?.providers ?? []
  // "Configured" means a credential is present: stored / runtime / env /
  // fallback / models.json keys count; `none` (no API key) is excluded.
  const configuredProviders = providers.filter((p) => p.authStatus !== 'none')
  const anyBusy = busy !== null

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

  // Engine status for the Engine section (active engine + installed versions).
  useEffect(() => {
    window.pi.getEngineStatus().then(setEngineStatus, () => setEngineStatus(null))
  }, [])

  // Provider type catalog (pi built-ins + custom) for the New-provider modal.
  useEffect(() => {
    window.pi.getProviderTypes().then(setProviderTypes, () => setProviderTypes([]))
  }, [])

  // When opened from the TopBar approval badge: land on the danger partition
  // (scroll it into view) and put focus on its switch.
  useEffect(() => {
    if (phase !== 'ready' || pendingSectionRef.current !== 'approval') return
    const section = sheetRef.current?.querySelector<HTMLElement>('[data-sett-approval]')
    if (!section) return
    pendingSectionRef.current = null
    if (typeof section.scrollIntoView === 'function') section.scrollIntoView({ block: 'nearest' })
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
    // cc-switch style: Enter or the button turns the typed ID into a chip.
    setCustomModels((prev) => [...prev, { id }])
    setModelInput('')
    setLive(null)
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
      const result = await window.pi.testProviderConnection({
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
    setCustomImage(false)
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
      setCustomModels(config.models.map((m) => ({ id: m.id })))
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
          ...m,
          ...(customImage ? { input: ['text', 'image'] as const } : {}),
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
  }, [baseline, thinking, compaction, retry, timeoutSec, defaultProvider, defaultModel, modelOptions])

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
              <section className="sett-section" aria-labelledby="sett-appearance-title">
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

              <section className="sett-section" aria-labelledby="sett-providers-title">
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

              <section className="sett-section" aria-labelledby="sett-extensions-title">
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
                          <span className="sett-extension-source">{t(`settings.extensionsSource.${extension.sourceLabel}`)}</span>
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
              </section>

              <section className="sett-section" aria-labelledby="sett-engine-title">
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

              <section className="sett-section" aria-labelledby="sett-defaults-title">
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

              <section
                className={`sett-section sett-approval${approvalMode === 'managed' ? ' sett-approval-managed' : ''}`}
                aria-labelledby="sett-approval-title"
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
            </>
          )}
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
                    <span className="sett-field-hint">{t('settings.modelsListHint')}</span>
                    {customModels.length > 0 ? (
                      <div className="sett-model-list">
                        {customModels.map((model) => (
                          <div className="sett-model-row" key={model.id}>
                            <span className="sett-model-id">{model.id}</span>
                            <button
                              type="button"
                              className="btn-icon"
                              aria-label={t('settings.removeModel')}
                              title={t('settings.removeModel')}
                              onClick={() => setCustomModels((prev) => prev.filter((m) => m.id !== model.id))}
                            >
                              <X size={11} aria-hidden="true" />
                            </button>
                          </div>
                        ))}
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
                <label className="sett-toggle">
                  <input
                    type="checkbox"
                    checked={customImage}
                    disabled={anyBusy}
                    onChange={(e) => setCustomImage(e.target.checked)}
                  />
                  {t('settings.customImage')}
                </label>
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
