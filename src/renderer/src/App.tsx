import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Download, FolderOpen, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import type { AppInfo, AppSnapshot, DynamicCommand, EngineStatus, ImageAttachment, SessionStatsInfo, ThinkingLevel } from '@shared/contracts'
import { errorMessage, useMediaQuery, useSnapshot } from './hooks'
import { formatCost, formatTokens } from './lib/format'
import { shortcut } from './lib/shortcuts'
import { useI18n } from './lib/i18n'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import MessageList from './components/MessageList'
import Composer, { type ComposerHandle } from './components/Composer'
import RightPanel from './components/RightPanel'
import SettingsPanel from './components/SettingsPanel'
import TelemetryBar from './components/TelemetryBar'
import WindowBar from './components/WindowBar'
import { getThemeDefinition, useTheme } from './lib/theme'

// Host platform comes from the preload contract (never sniffed from userAgent).
const platform = window.desktop?.platform ?? 'other'
const isMac = platform === 'darwin'
const isWin = platform === 'win32'

export default function App({ initialEngineStatus }: { initialEngineStatus?: EngineStatus } = {}) {
  const { t } = useI18n()
  const { theme } = useTheme()
  const { snapshot, loadError } = useSnapshot()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [dismissedError, setDismissedError] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<'approval' | null>(null)
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(initialEngineStatus ?? null)
  const [engineVersion, setEngineVersion] = useState('')
  const [engineVersions, setEngineVersions] = useState<string[] | null>(null)
  const [engineBusy, setEngineBusy] = useState<'install' | 'activate' | 'fetch' | null>(null)
  const [engineSetupError, setEngineSetupError] = useState<string | null>(null)
  /** Extension / template / skill slash commands; refreshed on session changes. */
  const [extraCommands, setExtraCommands] = useState<DynamicCommand[]>([])
  const composerRef = useRef<ComposerHandle>(null)
  const snapRef = useRef<AppSnapshot | null>(snapshot)
  snapRef.current = snapshot
  const splashTheme = getThemeDefinition(theme)

  const refreshEngineStatus = useCallback(async () => {
    const status = await window.pi.getEngineStatus()
    setEngineStatus(status)
    return status
  }, [])

  useEffect(() => {
    refreshEngineStatus().catch((error: unknown) => setEngineSetupError(errorMessage(error)))
  }, [refreshEngineStatus])

  const fetchEngineVersions = useCallback(async () => {
    if (engineBusy !== null) return
    setEngineBusy('fetch')
    setEngineSetupError(null)
    try {
      setEngineVersions(await window.pi.getEngineVersions())
    } catch (error) {
      setEngineSetupError(errorMessage(error))
    } finally {
      setEngineBusy(null)
    }
  }, [engineBusy])

  const activateConfiguredEngine = useCallback(async (version: string) => {
    if (engineBusy !== null) return
    setEngineBusy('activate')
    setEngineSetupError(null)
    try {
      await window.pi.activateEngine(version)
      await refreshEngineStatus()
    } catch (error) {
      setEngineSetupError(errorMessage(error))
    } finally {
      setEngineBusy(null)
    }
  }, [engineBusy, refreshEngineStatus])

  const installConfiguredEngine = useCallback(async () => {
    const version = engineVersion.trim()
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      setEngineSetupError(t('settings.engine.versionInvalid'))
      return
    }
    if (engineBusy !== null) return
    setEngineBusy('install')
    setEngineSetupError(null)
    try {
      await window.pi.installEngine(version)
      await window.pi.activateEngine(version)
      await refreshEngineStatus()
    } catch (error) {
      setEngineSetupError(errorMessage(error))
    } finally {
      setEngineBusy(null)
    }
  }, [engineBusy, engineVersion, refreshEngineStatus, t])

  const narrow = useMediaQuery('(max-width: 1080px)')
  const compact = useMediaQuery('(max-width: 780px)')
  useEffect(() => {
    if (narrow) setRightOpen(false)
  }, [narrow])
  useEffect(() => {
    if (compact) setSidebarOpen(false)
  }, [compact])

  const handleOpenDir = useCallback(async () => {
    setBusy(true)
    setToast(null)
    try {
      await window.pi.chooseWorkspace()
    } catch (e) {
      setToast(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const handleNewSession = useCallback(async () => {
    if (!snapRef.current?.workspace) return
    setBusy(true)
    setToast(null)
    try {
      await window.pi.newSession()
    } catch (e) {
      setToast(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const handleOpenSession = useCallback(async (path: string) => {
    setToast(null)
    try {
      await window.pi.openSession(path)
    } catch (e) {
      setToast(errorMessage(e))
    }
  }, [])

  const handleDeleteSession = useCallback(async (path: string) => {
    setToast(null)
    try {
      await window.pi.deleteSession(path)
    } catch (e) {
      setToast(errorMessage(e))
    }
  }, [])

  // Open the settings sheet, optionally landing on the tool-approval section
  // (used by the TopBar badge so the danger partition is visible and focused).
  const openSettings = useCallback((section: 'approval' | null = null) => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])

  const handleSend = useCallback((text: string, images?: ImageAttachment[]) => {
    setToast(null)
    setPendingText(text)
    window.pi.sendPrompt(text, images).catch((e: unknown) => {
      setPendingText(null)
      setToast(errorMessage(e))
    })
  }, [])

  /** Slash-command dispatch from the composer's `/` menu. */
  const handleCommand = useCallback(
    (commandId: string, arg: string) => {
      setToast(null)
      switch (commandId) {
        case 'new':
          void handleNewSession()
          return
        case 'resume':
          setSidebarOpen(true)
          // Focus the first session item so keyboard users land in the list.
          requestAnimationFrame(() => document.querySelector<HTMLElement>('.session-item .session-open')?.focus())
          return
        case 'model':
          // Open the topbar model dropdown (first select in the topbar).
          document.querySelector<HTMLElement>('.topbar .select-trigger')?.click()
          return
        case 'settings':
        case 'login':
          openSettings()
          return
        case 'name':
          if (arg === '') {
            setToast(t('app.command.nameHint'))
            return
          }
          window.pi.renameSession(arg).catch((e: unknown) => setToast(errorMessage(e)))
          return
        case 'compact':
          window.pi.compactSession(arg !== '' ? arg : undefined).catch((e: unknown) => setToast(errorMessage(e)))
          setToast(t('app.command.compacting'))
          return
        case 'copy':
          window.pi.copyLastMessage().then(
            (ok) => setToast(ok ? t('app.command.copied') : t('app.command.nothingToCopy')),
            (e: unknown) => setToast(errorMessage(e)),
          )
          return
        case 'export':
          window.pi.exportSession().then(
            (path) => setToast(path !== null ? t('app.command.exported', { path }) : t('app.command.exportCancelled')),
            (e: unknown) => setToast(errorMessage(e)),
          )
          return
        case 'session':
          window.pi.getSessionStats().then(
            (stats) => setSessionStats(stats),
            (e: unknown) => setToast(errorMessage(e)),
          )
          return
        case 'reload':
          window.pi.reloadSession().catch((e: unknown) => setToast(errorMessage(e)))
          setToast(t('app.command.reloading'))
          return
        case 'quit':
          void window.pi.quitApp()
          return
        default:
          // Extension / prompt-template / skill command: hand the raw text to
          // the SDK, which resolves and executes it like the TUI does.
          if (arg === '') {
            setToast(t('app.command.unknown', { cmd: commandId }))
            return
          }
          handleSend(`/${commandId} ${arg}`)
      }
    },
    [handleNewSession, openSettings, handleSend, t],
  )

  const handleStop = useCallback(() => {
    void window.pi.abort()
  }, [])

  const handleSetModel = useCallback(async (provider: string, id: string) => {
    setToast(null)
    try {
      await window.pi.setModel(provider, id)
    } catch (e) {
      setToast(errorMessage(e))
    }
  }, [])

  const handleSetThinking = useCallback(async (level: ThinkingLevel) => {
    setToast(null)
    try {
      await window.pi.setThinking(level)
    } catch (e) {
      setToast(errorMessage(e))
    }
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && key === 'n') {
        e.preventDefault()
        void handleNewSession()
      } else if (mod && key === 'k') {
        e.preventDefault()
        composerRef.current?.focus()
      } else if (mod && e.shiftKey && key === 'o') {
        e.preventDefault()
        void handleOpenDir()
      } else if (e.key === 'Escape') {
        const state = snapRef.current?.runState
        if (state === 'running' || state === 'retrying' || state === 'compacting') {
          e.preventDefault()
          void window.pi.abort()
        } else if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleNewSession, handleOpenDir])

  // Clear optimistic pending message once the real user message arrives
  useEffect(() => {
    if (pendingText === null) return
    const found = snapshot?.messages.some(
      (m) =>
        m.role === 'user' &&
        m.blocks.some((b) => b.type === 'text' && b.text.trim() === pendingText.trim()),
    )
    if (found) setPendingText(null)
  }, [snapshot, pendingText])

  useEffect(() => {
    setDismissedError(false)
  }, [snapshot?.error])

  // Load app identity once for the status-bar version + about dialog.
  useEffect(() => {
    window.pi.getAppInfo().then(setAppInfo, () => undefined)
  }, [])

  // Refresh dynamic slash commands whenever the active session changes.
  useEffect(() => {
    window.pi.getDynamicCommands().then(setExtraCommands, () => setExtraCommands([]))
  }, [snapshot?.activeSessionPath, snapshot?.workspace?.path])

  if (engineStatus === null || snapshot === null) {
    return (
      <div className={`splash-shell${isWin ? ' platform-win' : ''}${isMac ? ' platform-darwin' : ''}`} data-platform={platform}>
        {isWin ? <WindowBar title="Pi Studio" /> : null}
        <div className={`splash${isMac ? ' platform-darwin' : ''}`} data-platform={platform}>
        <div className="splash-glow splash-glow-one" aria-hidden="true" />
        <div className="splash-glow splash-glow-two" aria-hidden="true" />
        <div className="splash-panel">
          <div className="splash-mark" aria-hidden="true">
            <span>π</span>
          </div>
          <div className="splash-eyebrow">PI AGENT</div>
          <h1>{t('app.splash.title')}</h1>
          <p className="splash-subtitle">{t('app.splash.subtitle')}</p>
          {loadError === null ? (
            <div className="splash-status" role="status" aria-live="polite">
              <LoaderCircle size={17} className="splash-spin" aria-hidden="true" />
              <span>{t('app.splash.connecting')}</span>
              <span className="splash-dots" aria-hidden="true">•••</span>
            </div>
          ) : (
            <div className="splash-error" role="alert">
              <TriangleAlert size={17} aria-hidden="true" />
              <p>{t('app.splash.failed')}{loadError}</p>
              <button type="button" className="btn" onClick={() => window.location.reload()}>
                {t('common.retry')}
              </button>
            </div>
          )}
        </div>
        <div className="splash-footer">{splashTheme.quote ?? t('app.splash.footer')}</div>
        </div>
      </div>
    )
  }

  if (engineStatus.active === null) {
    return (
      <div className={`splash engine-setup${isMac ? ' platform-darwin' : ''}`} data-platform={platform}>
        <div className="splash-glow splash-glow-one" aria-hidden="true" />
        <div className="splash-glow splash-glow-two" aria-hidden="true" />
        <div className="splash-panel engine-setup-panel">
          <div className="splash-mark" aria-hidden="true"><span>π</span></div>
          <div className="splash-eyebrow">PI ENGINE</div>
          <h1>{t('engineSetup.title')}</h1>
          <p className="splash-subtitle">{t('engineSetup.subtitle')}</p>
          <p className="engine-setup-range">{t('settings.engine.supportedRange', { range: engineStatus.supportedRange })}</p>

          {engineStatus.error !== null || engineSetupError !== null ? (
            <div className="splash-error engine-setup-error" role="alert">
              <TriangleAlert size={17} aria-hidden="true" />
              <p>{engineSetupError ?? engineStatus.error}</p>
            </div>
          ) : null}

          {engineStatus.installed.length > 0 ? (
            <div className="engine-setup-installed">
              <span>{t('engineSetup.installed')}</span>
              {engineStatus.installed.map((version) => (
                <button
                  type="button"
                  className="btn"
                  key={version}
                  disabled={engineBusy !== null}
                  onClick={() => void activateConfiguredEngine(version)}
                >
                  {engineBusy === 'activate' ? t('engineSetup.activating') : t('engineSetup.useVersion', { version })}
                </button>
              ))}
            </div>
          ) : null}

          <div className="engine-setup-form">
            <input
              type="text"
              className="input"
              value={engineVersion}
              onChange={(event) => setEngineVersion(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void installConfiguredEngine() }}
              placeholder={t('settings.engine.versionPh')}
              aria-label={t('settings.engine.versionPh')}
              autoFocus
            />
            <button type="button" className="btn btn-primary" disabled={engineBusy !== null} onClick={() => void installConfiguredEngine()}>
              {engineBusy === 'install' ? <LoaderCircle size={15} className="splash-spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
              {engineBusy === 'install' ? t('settings.engine.installing') : t('engineSetup.installAndUse')}
            </button>
          </div>
          <button type="button" className="btn" disabled={engineBusy !== null} onClick={() => void fetchEngineVersions()}>
            {engineBusy === 'fetch' ? t('settings.engine.fetchingVersions') : t('settings.engine.fetchVersions')}
          </button>
          {engineVersions !== null && engineVersions.length > 0 ? (
            <div className="engine-setup-versions">
              {engineVersions.slice(0, 10).map((version) => (
                <button type="button" className="btn" key={version} onClick={() => setEngineVersion(version)}>{version}</button>
              ))}
            </div>
          ) : null}
          {!engineStatus.npm.available ? (
            <div className="engine-setup-manual">
              <p>{t('settings.engine.manualInstall')}</p>
              <code>npm install --prefix &quot;{engineStatus.installDir}/&lt;版本&gt;&quot; --no-audit --no-fund @earendil-works/pi-coding-agent@&lt;版本&gt;</code>
              <button type="button" className="btn" onClick={() => void refreshEngineStatus()}>{t('common.retry')}</button>
            </div>
          ) : null}
        </div>
        <div className="splash-footer">{t('engineSetup.footer')}</div>
      </div>
    )
  }

  const workspace = snapshot.workspace
  const running =
    snapshot.runState === 'running' || snapshot.runState === 'retrying' || snapshot.runState === 'compacting'
  const noModels = workspace !== null && snapshot.models.length === 0
  const composerDisabled = workspace === null || noModels
  const composerPlaceholder =
    workspace === null
      ? t('composer.placeholder.workspace')
      : noModels
        ? t('composer.placeholder.noModels')
        : running
          ? t('composer.placeholder.followUp')
          : t('composer.placeholder.idle')

  const error = snapshot.error !== null && !dismissedError ? snapshot.error : null
  const totalTokens = snapshot.usage.input + snapshot.usage.output + snapshot.usage.cacheRead

  // The runtime sends a raw English statusText; map the standard states to the
  // (theme-aware) dictionary and keep backend details (e.g. "Skipped
  // unopenable session") untouched.
  const statusText =
    snapshot.runState === 'running'
      ? t('app.status.working')
      : snapshot.runState === 'compacting'
        ? t('app.status.compacting')
        : snapshot.runState === 'retrying'
          ? t('app.status.retrying')
          : snapshot.runState === 'idle' && snapshot.statusText === 'Ready'
            ? t('app.status.ready')
            : snapshot.statusText

  const appStyle = {
    '--sidebar-w': sidebarOpen ? '248px' : '0px',
    '--right-w': rightOpen ? '344px' : '0px',
  } as CSSProperties

  return (
    <div className={`app-shell${isWin ? ' platform-win' : ''}${isMac ? ' platform-darwin' : ''}`} data-platform={platform}>
      {isWin ? <WindowBar title={workspace ? workspace.name : 'Pi Studio'} /> : null}
      <div className={`app${isMac ? ' platform-darwin' : ''}`} data-platform={platform} style={appStyle}>
      <div className="app-col app-col-left">
        {isMac ? <div className="drag-strip" aria-hidden="true" /> : null}
        <Sidebar
          snapshot={snapshot}
          busy={busy}
          onOpenDir={() => void handleOpenDir()}
          onNewSession={() => void handleNewSession()}
          onOpenSession={(path) => void handleOpenSession(path)}
          onDeleteSession={(path) => void handleDeleteSession(path)}
          onOpenSettings={() => openSettings()}
        />
      </div>
      <main className="app-col app-col-center">
        {isMac ? <div className="drag-strip" aria-hidden="true" /> : null}
        <div className="main">
        <TopBar
          snapshot={snapshot}
          sidebarOpen={sidebarOpen}
          rightOpen={rightOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onToggleRight={() => setRightOpen((v) => !v)}
          onSetModel={(p, id) => void handleSetModel(p, id)}
          onSetThinking={(level) => void handleSetThinking(level)}
          onOpenApproval={() => openSettings('approval')}
        />
        <div className="conversation">
          {error !== null || noModels ? (
            <div className="banner-zone" aria-live="polite">
              {error !== null ? (
                <div className="banner banner-error" role="alert">
                  <TriangleAlert size={14} className="banner-icon" aria-hidden="true" />
                  <div className="banner-content">
                    <div className="banner-title">{error.message}</div>
                    {error.detail !== undefined ? <div className="banner-detail">{error.detail}</div> : null}
                    {error.recoverable ? <div className="banner-recover">{t('app.banner.recoverable')}</div> : null}
                  </div>
                  <button
                    type="button"
                    className="banner-dismiss"
                    onClick={() => setDismissedError(true)}
                    aria-label={t('common.close')}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              {noModels ? (
                <div className="banner banner-warn">
                  <TriangleAlert size={14} className="banner-icon" aria-hidden="true" />
                  <div className="banner-content">
                    <div className="banner-title">{t('app.noModels.title')}</div>
                    <div className="banner-detail">{t('app.noModels.detail')}</div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {workspace === null ? (
            <div className="empty-workspace">
              <FolderOpen size={38} strokeWidth={1.2} aria-hidden="true" />
              <h2>{t('app.emptyWorkspace.title')}</h2>
              <p>{t('app.emptyWorkspace.desc')}</p>
              <button type="button" className="btn btn-primary btn-lg" onClick={() => void handleOpenDir()} disabled={busy}>
                <FolderOpen size={15} aria-hidden="true" />
                {t('app.emptyWorkspace.open')}
              </button>
              <p className="shortcut-hint">{t('app.shortcut.openDir', { kbd: shortcut('⇧⌘O', 'Ctrl+Shift+O') })}</p>
            </div>
          ) : (
            <>
              <MessageList
                messages={snapshot.messages}
                pendingText={pendingText}
                workspaceName={workspace.name}
                onSuggest={handleSend}
              />
              <Composer
                ref={composerRef}
                disabled={composerDisabled}
                placeholder={composerPlaceholder}
                running={running}
                onSend={handleSend}
                onStop={handleStop}
                onCommand={handleCommand}
                extraCommands={extraCommands}
              />
            </>
          )}
        </div>
        <TelemetryBar telemetry={snapshot.telemetry} usage={snapshot.usage} />
        <footer className="statusbar">
          <span className={`status-dot${running ? ' running' : snapshot.runState === 'error' ? ' error' : ''}`} aria-hidden="true" />
          <span className="status-text" role="status">
            {statusText}
          </span>
          <span className="statusbar-right">
            {snapshot.queueCount > 0 ? <span className="status-queue">{t('app.status.queue', { n: snapshot.queueCount })}</span> : null}
            {totalTokens > 0 ? (
              <span className="status-usage">
                {formatTokens(snapshot.usage.input)} in · {formatTokens(snapshot.usage.output)} out ·{' '}
                {formatCost(snapshot.usage.cost)}
              </span>
            ) : null}
            {appInfo !== null ? (
              <button type="button" className="status-version" onClick={() => setAboutOpen(true)} title={`${t('app.about.title', { name: appInfo.name })}`}>
                v{appInfo.version}
              </button>
            ) : null}
          </span>
        </footer>
        </div>
      </main>
      <div className="app-col app-col-right">
        {isMac ? <div className="drag-strip" aria-hidden="true" /> : null}
        <RightPanel snapshot={snapshot} />
      </div>

      {aboutOpen && appInfo !== null ? (
        <div
          className="stats-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t('app.about.title', { name: appInfo.name })}
          onClick={() => setAboutOpen(false)}
        >
          <div className="stats-box" onClick={(e) => e.stopPropagation()}>
            <div className="stats-head">
              <h3>{t('app.about.title', { name: appInfo.name })}</h3>
              <button type="button" className="btn-icon" onClick={() => setAboutOpen(false)} aria-label={t('common.close')}>
                <X size={15} aria-hidden="true" />
              </button>
            </div>
            <div className="stats-grid">
              <span>{t('app.about.version')}</span>
              <span>v{appInfo.version}</span>
              <span>{t('app.about.electron')}</span>
              <span>{appInfo.electron}</span>
              <span>{t('app.about.platform')}</span>
              <span>{appInfo.platform}</span>
              <span>{t('app.about.agentDir')}</span>
              <code className="stats-mono">{appInfo.agentDir}</code>
              <span>{t('app.about.workspace')}</span>
              <code className="stats-mono">{workspace?.path ?? t('app.about.notOpen')}</code>
            </div>
          </div>
        </div>
      ) : null}

      {sessionStats !== null ? (
        <div
          className="stats-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t('app.sessionStats.title')}
          onClick={() => setSessionStats(null)}
        >
          <div className="stats-box" onClick={(e) => e.stopPropagation()}>
            <div className="stats-head">
              <h3>{t('app.sessionStats.title')}</h3>
              <button
                type="button"
                className="btn-icon"
                onClick={() => setSessionStats(null)}
                aria-label={t('common.close')}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>
            <div className="stats-grid">
              <span>{t('app.sessionStats.id')}</span>
              <code className="stats-mono">{sessionStats.sessionId}</code>
              {sessionStats.sessionName !== null ? (
                <>
                  <span>{t('app.sessionStats.name')}</span>
                  <span>{sessionStats.sessionName}</span>
                </>
              ) : null}
              <span>{t('app.sessionStats.file')}</span>
              <code className="stats-mono">{sessionStats.sessionFile ?? t('app.sessionStats.notFlushed')}</code>
              <span>{t('app.sessionStats.userMsgs')}</span>
              <span>{sessionStats.userMessages}</span>
              <span>{t('app.sessionStats.assistantMsgs')}</span>
              <span>{sessionStats.assistantMessages}</span>
              <span>{t('app.sessionStats.toolCalls')}</span>
              <span>{sessionStats.toolCalls}</span>
              <span>{t('app.sessionStats.totalMsgs')}</span>
              <span>{sessionStats.totalMessages}</span>
              <span>{t('app.sessionStats.inputTokens')}</span>
              <span>{formatTokens(sessionStats.inputTokens)}</span>
              <span>{t('app.sessionStats.outputTokens')}</span>
              <span>{formatTokens(sessionStats.outputTokens)}</span>
              <span>{t('app.sessionStats.cacheRead')}</span>
              <span>{formatTokens(sessionStats.cacheReadTokens)}</span>
              <span>{t('app.sessionStats.cost')}</span>
              <span>{formatCost(sessionStats.cost)}</span>
            </div>
          </div>
        </div>
      ) : null}

      {settingsOpen ? (
        <SettingsPanel
          snapshot={snapshot}
          onClose={() => setSettingsOpen(false)}
          initialSection={settingsSection}
        />
      ) : null}
      </div>
    </div>
  )
}
