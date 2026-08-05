import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { FolderOpen, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import type { AppSnapshot, ThinkingLevel } from '@shared/contracts'
import { errorMessage, useMediaQuery, useSnapshot } from './hooks'
import { formatCost, formatTokens } from './lib/format'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import MessageList from './components/MessageList'
import Composer, { type ComposerHandle } from './components/Composer'
import RightPanel from './components/RightPanel'
import SettingsPanel from './components/SettingsPanel'
import TelemetryBar from './components/TelemetryBar'

// Host platform comes from the preload contract (never sniffed from userAgent).
const platform = window.desktop?.platform ?? 'other'
const isMac = platform === 'darwin'

export default function App() {
  const { snapshot, loadError } = useSnapshot()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [dismissedError, setDismissedError] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<'approval' | null>(null)
  const composerRef = useRef<ComposerHandle>(null)
  const snapRef = useRef<AppSnapshot | null>(snapshot)
  snapRef.current = snapshot

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

  const handleSend = useCallback((text: string) => {
    setToast(null)
    setPendingText(text)
    window.pi.sendPrompt(text).catch((e: unknown) => {
      setPendingText(null)
      setToast(errorMessage(e))
    })
  }, [])

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

  // Open the settings sheet, optionally landing on the tool-approval section
  // (used by the TopBar badge so the danger partition is visible and focused).
  const openSettings = useCallback((section: 'approval' | null = null) => {
    setSettingsSection(section)
    setSettingsOpen(true)
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

  if (snapshot === null) {
    return (
      <div className={`splash${isMac ? ' platform-darwin' : ''}`} data-platform={platform}>
        {loadError === null ? (
          <>
            <LoaderCircle size={26} className="splash-spin" aria-hidden="true" />
            <p>正在连接…</p>
          </>
        ) : (
          <>
            <TriangleAlert size={26} aria-hidden="true" />
            <p>无法连接渲染进程：{loadError}</p>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              重试
            </button>
          </>
        )}
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
      ? '请先打开工作区'
      : noModels
        ? '未找到可用模型，请检查 API 鉴权'
        : running
          ? '继续输入，发送后作为 follow-up 排队…'
          : '描述任务，Pi 将在当前工作区执行…'

  const error = snapshot.error !== null && !dismissedError ? snapshot.error : null
  const totalTokens = snapshot.usage.input + snapshot.usage.output + snapshot.usage.cacheRead

  const appStyle = {
    '--sidebar-w': sidebarOpen ? '248px' : '0px',
    '--right-w': rightOpen ? '344px' : '0px',
  } as CSSProperties

  return (
    <div className={`app${isMac ? ' platform-darwin' : ''}`} data-platform={platform} style={appStyle}>
      <div className="app-col app-col-left">
        {isMac ? <div className="drag-strip" aria-hidden="true" /> : null}
        <Sidebar
          snapshot={snapshot}
          busy={busy}
          onOpenDir={() => void handleOpenDir()}
          onNewSession={() => void handleNewSession()}
          onOpenSession={(path) => void handleOpenSession(path)}
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
                    {error.recoverable ? <div className="banner-recover">可重试 — 发送新消息后继续</div> : null}
                  </div>
                  <button
                    type="button"
                    className="banner-dismiss"
                    onClick={() => setDismissedError(true)}
                    aria-label="关闭错误提示"
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              {noModels ? (
                <div className="banner banner-warn">
                  <TriangleAlert size={14} className="banner-icon" aria-hidden="true" />
                  <div className="banner-content">
                    <div className="banner-title">未找到可用模型</div>
                    <div className="banner-detail">请检查模型 API 配置与登录状态，然后重新打开工作区。</div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {workspace === null ? (
            <div className="empty-workspace">
              <FolderOpen size={38} strokeWidth={1.2} aria-hidden="true" />
              <h2>打开一个工作区</h2>
              <p>选择项目目录后，即可开始新任务、管理会话，并让 Pi 在真实代码上工作。</p>
              <button type="button" className="btn btn-primary btn-lg" onClick={() => void handleOpenDir()} disabled={busy}>
                <FolderOpen size={15} aria-hidden="true" />
                打开目录
              </button>
              <p className="shortcut-hint">快捷键 ⇧⌘O</p>
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
              />
            </>
          )}
        </div>
        <TelemetryBar telemetry={snapshot.telemetry} usage={snapshot.usage} />
        <footer className="statusbar">
          <span className={`status-dot${running ? ' running' : snapshot.runState === 'error' ? ' error' : ''}`} aria-hidden="true" />
          <span className="status-text" role="status">
            {snapshot.statusText}
          </span>
          <span className="statusbar-right">
            {snapshot.queueCount > 0 ? <span className="status-queue">队列 +{snapshot.queueCount}</span> : null}
            {totalTokens > 0 ? (
              <span className="status-usage">
                {formatTokens(snapshot.usage.input)} in · {formatTokens(snapshot.usage.output)} out ·{' '}
                {formatCost(snapshot.usage.cost)}
              </span>
            ) : null}
          </span>
        </footer>
        </div>
      </main>
      <div className="app-col app-col-right">
        {isMac ? <div className="drag-strip" aria-hidden="true" /> : null}
        <RightPanel snapshot={snapshot} />
      </div>

      {settingsOpen ? (
        <SettingsPanel
          snapshot={snapshot}
          onClose={() => setSettingsOpen(false)}
          initialSection={settingsSection}
        />
      ) : null}
    </div>
  )
}
