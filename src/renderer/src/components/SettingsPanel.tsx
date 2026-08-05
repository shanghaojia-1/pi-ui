import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { LoaderCircle, LogOut, Plus, RefreshCw, RotateCcw, Search, TriangleAlert, X } from 'lucide-react'
import type {
  AppSnapshot,
  CustomProviderApi,
  ExtensionsInfo,
  ProviderStatus,
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

type BusyAction = 'key' | 'logout' | 'refresh' | 'save' | 'approval' | 'custom' | null

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
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<BusyAction>(null)
  const [live, setLive] = useState<LiveMessage | null>(null)
  const [confirmLogout, setConfirmLogout] = useState(false)
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
  const [providerQuery, setProviderQuery] = useState('')
  const [extensionsInfo, setExtensionsInfo] = useState<ExtensionsInfo | null>(null)
  // Custom-provider form (adds a provider to the agent's models.json).
  const [customOpen, setCustomOpen] = useState(false)
  const [customId, setCustomId] = useState('')
  const [customName, setCustomName] = useState('')
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [customApi, setCustomApi] = useState<CustomProviderApi>('openai-completions')
  const [customApiKey, setCustomApiKey] = useState('')
  /** Models of the new provider, added one by one. */
  const [customModels, setCustomModels] = useState<{ id: string; name?: string }[]>([])
  const [modelInput, setModelInput] = useState('')
  const [modelNameInput, setModelNameInput] = useState('')
  const [customImage, setCustomImage] = useState(false)
  /** Connection-test state for the New-provider modal. */
  const [testResult, setTestResult] = useState<{ testing: boolean } | { testing: false; ok: boolean; status: number | null; kind: 'ok' | 'auth' | 'http' | 'network' }>({ testing: false })

  const sheetRef = useRef<HTMLElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  // Only the section requested at open time is auto-focused; once handled it
  // is cleared so a later re-render can never re-scroll the sheet.
  const pendingSectionRef = useRef<'approval' | null>(initialSection ?? null)

  const providers = settings?.providers ?? []
  const selected = providers.find((p) => p.id === selectedProvider) ?? null
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
      setSelectedProvider((prev) => prev ?? s.providers[0]?.id ?? null)
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

  // Unmount must never leave a partially-submitted secret behind.
  useEffect(() => {
    return () => {
      setApiKey('')
    }
  }, [])

  // Closing clears any typed secret first so it cannot survive the sheet.
  const closeSheet = useCallback((): void => {
    setApiKey('')
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

  const submitKey = async (): Promise<void> => {
    const key = apiKey.trim()
    // Capture the target before clearing: even if the user switches provider
    // mid-flight, the key is never submitted to the wrong provider.
    const providerId = selectedProvider
    if (key === '' || providerId === null || anyBusy) return
    // Clear the secret immediately — success, settings-error and rejection alike.
    setApiKey('')
    setBusy('key')
    setLive({ kind: 'info', text: t('settings.keySetting') })
    setConfirmLogout(false)
    try {
      const s = await window.pi.setRuntimeApiKey(providerId, key)
      setSettings(s)
      if (s.error !== null) {
        setLive({ kind: 'error', text: s.error.message })
      } else {
        setLive({ kind: 'success', text: t('settings.keySuccess') })
      }
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  const logout = async (): Promise<void> => {
    if (selectedProvider === null || anyBusy) return
    if (!confirmLogout) {
      setConfirmLogout(true)
      return
    }
    setBusy('logout')
    setLive({ kind: 'info', text: t('settings.loggingOut') })
    try {
      const s = await window.pi.logoutProvider(selectedProvider)
      setSettings(s)
      setConfirmLogout(false)
      setLive(s.error !== null ? { kind: 'error', text: s.error.message } : { kind: 'success', text: t('settings.loggedOut') })
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
   * Provider type presets for the New-provider modal: picking one fills the
   * API flavor and (when untouched) a common base URL.
   */
  const PROVIDER_TYPES: { id: string; labelKey: string; api: CustomProviderApi; url?: string }[] = [
    { id: 'ollama', labelKey: 'settings.type.ollama', api: 'openai-completions', url: 'http://localhost:11434/v1' },
    { id: 'openai', labelKey: 'settings.type.openai', api: 'openai-completions' },
    { id: 'anthropic', labelKey: 'settings.type.anthropic', api: 'anthropic-messages', url: 'https://api.anthropic.com/v1' },
    { id: 'google', labelKey: 'settings.type.google', api: 'google-generative-ai', url: 'https://generativelanguage.googleapis.com/v1beta' },
    { id: 'custom', labelKey: 'settings.type.custom', api: 'openai-completions' },
  ]
  const [customType, setCustomType] = useState('custom')

  const selectProviderType = (typeId: string): void => {
    setCustomType(typeId)
    const preset = PROVIDER_TYPES.find((p) => p.id === typeId)
    if (!preset) return
    setCustomApi(preset.api)
    // Only pre-fill the URL while the user has not typed one.
    if (preset.url !== undefined && customBaseUrl.trim() === '') setCustomBaseUrl(preset.url)
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
    const name = modelNameInput.trim()
    setCustomModels((prev) => [...prev, { id, ...(name !== '' ? { name } : {}) }])
    setModelInput('')
    setModelNameInput('')
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

  const saveCustom = async (): Promise<void> => {
    if (anyBusy) return
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
        setLive({ kind: 'success', text: t('settings.customAdded', { name: customName.trim() !== '' ? customName.trim() : id }) })
        // Reset and collapse the form; the provider list now includes it.
        setCustomOpen(false)
        setCustomId('')
        setCustomName('')
        setCustomBaseUrl('')
        setCustomApiKey('')
        setCustomModels([])
        setModelInput('')
        setModelNameInput('')
        setCustomImage(false)
        setTestResult({ testing: false })
        // Select the new provider so its panel is ready for a runtime key.
        setSelectedProvider((prev) => prev ?? id)
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

  // Provider options: providers seen in the model catalog first, then any
  // known providers from settings. Model options are filtered from
  // AppSnapshot.models by the chosen default provider.
  const providerOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: { value: string; label: string }[] = []
    const push = (id: string): void => {
      if (seen.has(id)) return
      seen.add(id)
      const info = providers.find((p) => p.id === id)
      out.push({ value: id, label: info ? info.name : id })
    }
    for (const m of snapshot.models) push(m.provider)
    for (const p of providers) push(p.id)
    return out
  }, [snapshot.models, providers])

  const modelOptions = useMemo(
    () => snapshot.models.filter((m) => m.provider === defaultProvider).map((m) => ({ value: m.id, label: m.name || m.id })),
    [snapshot.models, defaultProvider],
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
    if (
      defaultProvider !== null &&
      defaultProvider !== baseline.defaultProvider &&
      providerOptions.some((o) => o.value === defaultProvider)
    ) {
      p.defaultProvider = defaultProvider
    }
    if (
      defaultModel !== null &&
      defaultProvider !== null &&
      defaultModel !== baseline.defaultModel &&
      modelOptions.some((o) => o.value === defaultModel)
    ) {
      p.defaultModel = defaultModel
    }
    return p
  }, [baseline, thinking, compaction, retry, timeoutSec, defaultProvider, defaultModel, providerOptions, modelOptions])

  const filteredProviders = useMemo(() => {
    const q = providerQuery.trim().toLowerCase()
    if (q === '') return providers
    return providers.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
  }, [providers, providerQuery])

  // The selected provider is always reachable: when the search filters it
  // out, it is pinned above the (possibly empty) result list.
  const selectedPinned = selected !== null && !filteredProviders.includes(selected)
  const dirty = Object.keys(patch).length > 0
  // Current approval policy: the settings snapshot returned by main (never an
  // optimistic local flip). While settings are still loading the switch is
  // simply not rendered, and the TopBar badge keeps using the AppSnapshot.
  const approvalMode: ToolApprovalMode = settings?.toolApprovalMode ?? snapshot.toolApprovalMode

  const renderProviderButton = (p: ProviderStatus) => {
    const active = p.id === selectedProvider
    const isDefault = p.id === settings?.defaultProvider
    return (
      <button
        key={p.id}
        type="button"
        className={`sett-provider${active ? ' sett-provider-active' : ''}`}
        aria-pressed={active}
        onClick={() => {
          // A key typed for one provider must never carry over to another.
          setApiKey('')
          setSelectedProvider(p.id)
          setConfirmLogout(false)
        }}
      >
        <span className="sett-provider-name">{p.name}</span>
        <span className="sett-provider-id">{p.id}</span>
        <span className="sett-provider-meta">
          <span className={`sett-auth sett-auth-${p.authStatus}`}>{t(AUTH_KEYS[p.authStatus])}</span>
          <span>{t('settings.models', { n: p.availableModelCount })}</span>
          {p.credentialType !== null ? <span>{p.credentialType}</span> : null}
          {isDefault ? <span className="sett-provider-default">{t('common.default')}</span> : null}
        </span>
      </button>
    )
  }

  return (
    <div className="sett-overlay">
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
                        <span className="sett-theme-swatch" style={{ background: item.swatch }} aria-hidden="true" />
                        <span>{t(item.labelKey)}</span>
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
                    onClick={() => {
                      setCustomOpen(true)
                      setLive(null)
                    }}
                  >
                    <Plus size={13} aria-hidden="true" />
                    {t('settings.newProvider')}
                  </button>
                </div>
                <p className="sett-hint">{t('settings.providersHint')}</p>
                {providers.length === 0 ? (
                  <div className="sett-empty">
                    <p>{t('settings.noProviders')}</p>
                    <p className="sett-empty-hint">
                      {t('settings.noProvidersHint')}
                    </p>
                    <button type="button" className="btn" onClick={() => void refresh()} disabled={anyBusy}>
                      <RefreshCw size={13} aria-hidden="true" />
                      {busy === 'refresh' ? t('settings.refreshing') : t('settings.refreshModels')}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="sett-provider-search">
                      <Search size={13} className="sett-provider-search-icon" aria-hidden="true" />
                      <input
                        type="search"
                        className="sett-provider-search-input"
                        placeholder={t('settings.searchProvider')}
                        aria-label={t('settings.searchAria')}
                        value={providerQuery}
                        onChange={(e) => setProviderQuery(e.target.value)}
                      />
                    </div>
                    {selectedPinned && selected !== null ? (
                      <div className="sett-provider-pinned">
                        <p className="sett-pinned-label">{t('settings.pinnedLabel')}</p>
                        {renderProviderButton(selected)}
                      </div>
                    ) : null}
                    {filteredProviders.length === 0 ? (
                      <p className="sett-search-empty">{t('settings.searchEmpty')}</p>
                    ) : (
                      <div className="sett-provider-list">{filteredProviders.map((p) => renderProviderButton(p))}</div>
                    )}
                  </>
                )}

                {/* Provider action panel: sits right under the list so the
                    choose-then-configure flow reads top-to-bottom. */}
                <div className="sett-provider-panel" aria-labelledby="sett-key-title">
                  <div className="sett-provider-panel-head">
                    <h3 id="sett-key-title">{t('settings.keyTitle')}</h3>
                    {selected !== null ? (
                      <span className={`sett-auth sett-auth-${selected.authStatus}`}>{t(AUTH_KEYS[selected.authStatus])}</span>
                    ) : null}
                  </div>
                  {selected === null ? (
                    <p className="sett-hint">{t('settings.selectProviderFirst')}</p>
                  ) : (
                    <>
                      <p className="sett-hint">{t('settings.keyHint', { name: selected.name })}</p>
                      <div className="sett-key-row">
                        <input
                          type="password"
                          className="sett-input"
                          autoComplete="new-password"
                          placeholder={t('settings.keyPlaceholder')}
                          aria-label="API Key"
                          value={apiKey}
                          disabled={anyBusy}
                          onChange={(e) => setApiKey(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void submitKey()
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={anyBusy || apiKey.trim() === ''}
                          onClick={() => void submitKey()}
                        >
                          {busy === 'key' ? t('settings.settingKey') : t('settings.setKey')}
                        </button>
                      </div>
                      <div className="sett-key-actions">
                        <button type="button" className="btn" disabled={anyBusy} onClick={() => void refresh()}>
                          <RefreshCw size={13} aria-hidden="true" />
                          {busy === 'refresh' ? t('settings.refreshing') : t('settings.refreshModels')}
                        </button>
                        <button
                          type="button"
                          className={`btn${confirmLogout ? ' btn-danger' : ''}`}
                          disabled={anyBusy}
                          onClick={() => void logout()}
                        >
                          <LogOut size={13} aria-hidden="true" />
                          {confirmLogout ? t('settings.confirmLogout') : t('settings.logout')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
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
                        <span className="sett-extension-path" title={extension.path}>
                          {extension.path}
                        </span>
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

              <section className="sett-section" aria-labelledby="sett-defaults-title">
                <h3 id="sett-defaults-title">{t('settings.defaults')}</h3>
                <p className="sett-hint">{t('settings.defaultsHint')}</p>
                <div className="sett-field">
                  <label htmlFor="sett-provider">{t('settings.defaultProvider')}</label>
                  <select
                    id="sett-provider"
                    className="sett-select"
                    value={providerOptions.some((o) => o.value === defaultProvider) ? (defaultProvider ?? '') : ''}
                    disabled={providerOptions.length === 0 || anyBusy}
                    onChange={(e) => {
                      const v = e.target.value
                      setDefaultProvider(v === '' ? null : v)
                      setDefaultModel(null)
                    }}
                  >
                    <option value="">{t('settings.followLast')}</option>
                    {providerOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {providerOptions.length === 0 ? (
                    <span className="sett-field-hint">{t('settings.noModelsHint')}</span>
                  ) : null}
                </div>
                <div className="sett-field">
                  <label htmlFor="sett-model">{t('settings.defaultModel')}</label>
                  <select
                    id="sett-model"
                    className="sett-select"
                    value={modelOptions.some((o) => o.value === defaultModel) ? (defaultModel ?? '') : ''}
                    disabled={defaultProvider === null || modelOptions.length === 0 || anyBusy}
                    onChange={(e) => {
                      const v = e.target.value
                      setDefaultModel(v === '' ? null : v)
                    }}
                  >
                    <option value="">{t('settings.providerDefault')}</option>
                    {modelOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
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
          aria-label={t('settings.customTitle')}
          onClick={closeCustomModal}
        >
          <div className="stats-box sett-custom-modal" onClick={(e) => e.stopPropagation()}>
            <div className="stats-head">
              <h3>{t('settings.customTitle')}</h3>
              <button type="button" className="btn-icon" onClick={closeCustomModal} aria-label={t('common.close')}>
                <X size={15} aria-hidden="true" />
              </button>
            </div>
            <p className="sett-hint">{t('settings.customHint')}</p>
            {/* Provider type presets: pre-fill API flavor + common URL. */}
            <div className="sett-field">
              <label>{t('settings.providerType')}</label>
              <div className="sett-type-row" role="radiogroup" aria-label={t('settings.providerType')}>
                {PROVIDER_TYPES.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={customType === preset.id}
                    className={`sett-type${customType === preset.id ? ' sett-type-active' : ''}`}
                    onClick={() => selectProviderType(preset.id)}
                  >
                    {t(preset.labelKey)}
                  </button>
                ))}
              </div>
              <span className="sett-field-hint">{t('settings.providerTypeHint')}</span>
            </div>
            <div className="sett-custom-grid">
              <div className="sett-field">
                <label htmlFor="custom-id">{t('settings.customId')}</label>
                <input
                  id="custom-id"
                  className="sett-input"
                  placeholder={t('settings.customIdPh')}
                  value={customId}
                  disabled={anyBusy}
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
                  placeholder={t('settings.customKeyPh')}
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
                        {model.name !== undefined ? <span className="sett-model-name">{model.name}</span> : null}
                        <button
                          type="button"
                          className="btn-icon"
                          aria-label={t('settings.removeModel')}
                          title={t('settings.removeModel')}
                          onClick={() => setCustomModels((prev) => prev.filter((m) => m.id !== model.id))}
                        >
                          <X size={12} aria-hidden="true" />
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
                  <input
                    className="sett-input"
                    placeholder={t('settings.modelNamePh')}
                    aria-label={t('settings.modelNamePh')}
                    value={modelNameInput}
                    disabled={anyBusy}
                    onChange={(e) => setModelNameInput(e.target.value)}
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
                {busy === 'custom' ? t('settings.addingProvider') : t('settings.addProvider')}
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
