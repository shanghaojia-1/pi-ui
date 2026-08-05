import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { LoaderCircle, LogOut, RefreshCw, RotateCcw, Search, TriangleAlert, X } from 'lucide-react'
import type {
  AppSnapshot,
  ProviderStatus,
  SettingsPatch,
  SettingsSnapshot,
  ThinkingLevel,
  ToolApprovalMode,
} from '@shared/contracts'
import { HTTP_IDLE_TIMEOUT_MAX_MS, HTTP_IDLE_TIMEOUT_MIN_MS } from '../../../shared/contracts'
import { errorMessage } from '../hooks'
import { formatDuration, formatTokens } from '../lib/format'

const AUTH_LABELS: Record<ProviderStatus['authStatus'], string> = {
  stored: '已存储',
  runtime: '仅本次运行',
  environment: '环境变量',
  fallback: '回退配置',
  'models-json': 'models.json',
  none: '未配置',
  error: '鉴权异常',
}

const THINKING_OPTIONS: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'minimal', label: '最低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '很高' },
  { value: 'max', label: '最高' },
]

const TIMEOUT_MIN_S = HTTP_IDLE_TIMEOUT_MIN_MS / 1000
const TIMEOUT_MAX_S = HTTP_IDLE_TIMEOUT_MAX_MS / 1000

type BusyAction = 'key' | 'logout' | 'refresh' | 'save' | 'approval' | null

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
    setLive({ kind: 'info', text: '正在设置 API Key…' })
    setConfirmLogout(false)
    try {
      const s = await window.pi.setRuntimeApiKey(providerId, key)
      setSettings(s)
      if (s.error !== null) {
        setLive({ kind: 'error', text: s.error.message })
      } else {
        setLive({ kind: 'success', text: 'API Key 已设置（仅本次运行，关闭应用后失效）' })
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
    setLive({ kind: 'info', text: '正在退出登录…' })
    try {
      const s = await window.pi.logoutProvider(selectedProvider)
      setSettings(s)
      setConfirmLogout(false)
      setLive(s.error !== null ? { kind: 'error', text: s.error.message } : { kind: 'success', text: '已退出登录' })
    } catch (e) {
      setLive({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  const refresh = async (): Promise<void> => {
    if (anyBusy) return
    setBusy('refresh')
    setLive({ kind: 'info', text: '正在刷新模型列表…' })
    try {
      const s = await window.pi.refreshModels()
      setSettings(s)
      setLive(s.error !== null ? { kind: 'error', text: s.error.message } : { kind: 'success', text: '模型列表已刷新' })
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
      text: target === 'managed' ? '正在请求开启全托管模式…' : '正在关闭全托管模式…',
    })
    try {
      const s = await window.pi.setToolApprovalMode(target)
      setSettings(s)
      if (s.error !== null) {
        setApprovalStatus({ kind: 'error', text: s.error.message })
      } else if (s.toolApprovalMode === 'managed' && target === 'ask') {
        // Defensive: a disable request that came back still managed.
        setApprovalStatus({ kind: 'error', text: '仍处于全托管模式，请重试' })
      } else if (s.toolApprovalMode === 'managed') {
        setApprovalStatus({ kind: 'success', text: '已开启全托管模式' })
      } else if (target === 'managed') {
        setApprovalStatus({ kind: 'info', text: '已取消：未开启全托管模式' })
      } else {
        setApprovalStatus({ kind: 'success', text: '已关闭全托管模式' })
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
      setLive({ kind: 'error', text: `HTTP 空闲超时需在 ${TIMEOUT_MIN_S}–${TIMEOUT_MAX_S} 秒之间` })
      return
    }
    if (Object.keys(patch).length === 0) {
      setLive({ kind: 'info', text: '没有需要保存的更改' })
      return
    }
    setBusy('save')
    setLive({ kind: 'info', text: '正在保存默认设置…' })
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
        setLive({ kind: 'success', text: '默认设置已保存' })
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
          <span className={`sett-auth sett-auth-${p.authStatus}`}>{AUTH_LABELS[p.authStatus]}</span>
          <span>{p.availableModelCount} 个模型</span>
          {p.credentialType !== null ? <span>{p.credentialType}</span> : null}
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
            设置
          </h2>
          <button type="button" className="btn-icon" data-sett-close onClick={closeSheet} aria-label="关闭设置">
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
              <p>正在加载设置…</p>
            </div>
          ) : phase === 'error' ? (
            <div className="sett-state">
              <TriangleAlert size={22} aria-hidden="true" />
              <p>无法加载设置：{loadMessage}</p>
              <button type="button" className="btn" onClick={() => void load()}>
                <RotateCcw size={13} aria-hidden="true" />
                重试
              </button>
            </div>
          ) : settings === null ? null : (
            <>
              <section className="sett-section" aria-labelledby="sett-providers-title">
                <h3 id="sett-providers-title">模型提供商</h3>
                {providers.length === 0 ? (
                  <div className="sett-empty">
                    <p>未发现已配置的模型提供商。</p>
                    <p className="sett-empty-hint">
                      可在终端运行 <code>pi /login</code> 登录，然后刷新模型列表。
                    </p>
                    <button type="button" className="btn" onClick={() => void refresh()} disabled={anyBusy}>
                      <RefreshCw size={13} aria-hidden="true" />
                      {busy === 'refresh' ? '刷新中…' : '刷新模型列表'}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="sett-provider-search">
                      <Search size={13} className="sett-provider-search-icon" aria-hidden="true" />
                      <input
                        type="search"
                        className="sett-provider-search-input"
                        placeholder="搜索提供商（名称或 ID）"
                        aria-label="搜索提供商"
                        value={providerQuery}
                        onChange={(e) => setProviderQuery(e.target.value)}
                      />
                    </div>
                    {selectedPinned && selected !== null ? (
                      <div className="sett-provider-pinned">
                        <p className="sett-pinned-label">已选（不在搜索结果中）</p>
                        {renderProviderButton(selected)}
                      </div>
                    ) : null}
                    {filteredProviders.length === 0 ? (
                      <p className="sett-search-empty">未找到匹配的提供商</p>
                    ) : (
                      <div className="sett-provider-list">{filteredProviders.map((p) => renderProviderButton(p))}</div>
                    )}
                  </>
                )}
              </section>

              <section className="sett-section" aria-labelledby="sett-key-title">
                <h3 id="sett-key-title">API Key（仅本次运行）</h3>
                {selected === null ? (
                  <p className="sett-hint">请先在上方选择一个提供商。</p>
                ) : (
                  <>
                    <p className="sett-hint">
                      为 <strong>{selected.name}</strong> 配置临时 API Key。仅本次运行有效，关闭应用后失效，不会写入磁盘。
                    </p>
                    <div className="sett-key-row">
                      <input
                        type="password"
                        className="sett-input"
                        autoComplete="new-password"
                        placeholder="粘贴 API Key"
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
                        {busy === 'key' ? '设置中…' : '设置 Key'}
                      </button>
                    </div>
                    <div className="sett-key-actions">
                      <button type="button" className="btn" disabled={anyBusy} onClick={() => void refresh()}>
                        <RefreshCw size={13} aria-hidden="true" />
                        {busy === 'refresh' ? '刷新中…' : '刷新模型列表'}
                      </button>
                      <button
                        type="button"
                        className={`btn${confirmLogout ? ' btn-danger' : ''}`}
                        disabled={anyBusy}
                        onClick={() => void logout()}
                      >
                        <LogOut size={13} aria-hidden="true" />
                        {confirmLogout ? '再次点击确认退出' : '退出登录'}
                      </button>
                    </div>
                  </>
                )}
              </section>

              <section className="sett-section" aria-labelledby="sett-defaults-title">
                <h3 id="sett-defaults-title">默认设置</h3>
                <p className="sett-hint">默认值用于新会话；当前会话模型仍由顶部选择器控制。</p>
                <div className="sett-field">
                  <label htmlFor="sett-provider">默认提供商</label>
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
                    <option value="">跟随上次选择</option>
                    {providerOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {providerOptions.length === 0 ? (
                    <span className="sett-field-hint">暂无可用模型，请先配置 API Key 或运行 pi /login</span>
                  ) : null}
                </div>
                <div className="sett-field">
                  <label htmlFor="sett-model">默认模型</label>
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
                    <option value="">提供商默认</option>
                    {modelOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sett-field">
                  <label htmlFor="sett-thinking">默认思考强度</label>
                  <select
                    id="sett-thinking"
                    className="sett-select"
                    value={thinking}
                    disabled={anyBusy}
                    onChange={(e) => {
                      setThinking(e.target.value as ThinkingLevel)
                    }}
                  >
                    {THINKING_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
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
                    自动压缩上下文
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
                    自动重试
                  </label>
                </div>
                <div className="sett-field">
                  <label htmlFor="sett-timeout">HTTP 空闲超时（秒）</label>
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
                    范围 {TIMEOUT_MIN_S}–{TIMEOUT_MAX_S} 秒，保存时转换为毫秒
                  </span>
                </div>
                <div className="sett-readonly" aria-label="只读设置">
                  <span>
                    压缩保留 <strong>{settings.compaction.reserveTokens !== null ? formatTokens(settings.compaction.reserveTokens) : '—'}</strong>
                  </span>
                  <span>
                    保留最近 <strong>{settings.compaction.keepRecentTokens !== null ? formatTokens(settings.compaction.keepRecentTokens) : '—'}</strong>
                  </span>
                  <span>
                    最大重试 <strong>{settings.retry.maxRetries !== null ? `${settings.retry.maxRetries} 次` : '—'}</strong>
                  </span>
                  <span>
                    重试延迟 <strong>{settings.retry.baseDelayMs !== null ? formatDuration(settings.retry.baseDelayMs) : '—'}</strong>
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={anyBusy || !dirty}
                  onClick={() => void saveDefaults()}
                >
                  {busy === 'save' ? '保存中…' : '保存默认设置'}
                </button>
              </section>

              <section
                className={`sett-section sett-approval${approvalMode === 'managed' ? ' sett-approval-managed' : ''}`}
                aria-labelledby="sett-approval-title"
                data-sett-approval
              >
                <h3 id="sett-approval-title">
                  工具审批
                  <span className={`sett-approval-pill sett-approval-pill-${approvalMode}`}>
                    {approvalMode === 'managed' ? '全托管' : '逐次确认'}
                  </span>
                </h3>
                <p className="sett-approval-note">
                  {approvalMode === 'managed'
                    ? '命令和文件修改将不再逐次确认；使用当前用户权限；不是沙箱；请仅在信任当前任务时开启。'
                    : '每次执行 bash / edit / write 前都会向你确认，命令与文件修改不会在未经确认时执行。'}
                </p>
                <label className="sett-switch-row">
                  <span className="sett-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      data-sett-approval-toggle
                      checked={approvalMode === 'managed'}
                      disabled={anyBusy}
                      aria-label="全托管模式（工具免逐次确认）"
                      onChange={() => void toggleApproval()}
                    />
                    <span className="sett-switch-track" aria-hidden="true" />
                  </span>
                  <span className="sett-switch-text">
                    <span className="sett-switch-title">全托管模式</span>
                    <span className="sett-switch-sub">
                      {approvalMode === 'managed'
                        ? '已开启：bash / edit / write 不再逐次确认'
                        : '关闭：bash / edit / write 每次执行前确认'}
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
    </div>
  )
}
