import { useMemo, useState } from 'react'
import { Folder, FolderOpen, MessageSquare, Plus, Settings, Trash2 } from 'lucide-react'
import type { AppSnapshot, SessionListItem } from '@shared/contracts'
import { formatTime, sessionGroup } from '../lib/format'
import { useI18n } from '../lib/i18n'

interface SidebarProps {
  snapshot: AppSnapshot | null
  busy: boolean
  onOpenDir: () => void
  onNewSession: () => void
  onOpenSession: (path: string) => void
  onDeleteSession: (path: string) => void
  onOpenSettings: () => void
}

interface SessionGroup {
  label: string
  items: SessionListItem[]
}

export default function Sidebar({ snapshot, busy, onOpenDir, onNewSession, onOpenSession, onDeleteSession, onOpenSettings }: SidebarProps) {
  const { t } = useI18n()
  const workspace = snapshot?.workspace ?? null
  /** Session paths awaiting the second (confirming) click; auto-resets on blur. */
  const [confirming, setConfirming] = useState<string | null>(null)

  const groups = useMemo<SessionGroup[]>(() => {
    const sessions = snapshot?.sessions ?? []
    const sorted = [...sessions].sort((a, b) => +new Date(b.modifiedAt) - +new Date(a.modifiedAt))
    const byGroup = new Map<string, SessionListItem[]>()
    for (const s of sorted) {
      const key = sessionGroup(s.modifiedAt)
      const list = byGroup.get(key)
      if (list) list.push(s)
      else byGroup.set(key, [s])
    }
    const labels: Record<string, string> = { today: t('sidebar.groupToday'), yesterday: t('sidebar.groupYesterday'), earlier: t('sidebar.groupEarlier') }
    const out: SessionGroup[] = []
    for (const key of ['today', 'yesterday', 'earlier']) {
      const items = byGroup.get(key)
      if (items && items.length > 0) out.push({ label: labels[key] ?? key, items })
    }
    return out
  }, [snapshot])

  return (
    <div className="sidebar">
      <div className="sidebar-workspace">
        <div className="sidebar-ws-row">
          <Folder size={14} className="sidebar-ws-icon" aria-hidden="true" />
          <span className="sidebar-ws-name" title={workspace?.name}>
            {workspace ? workspace.name : t('sidebar.workspaceNotOpen')}
          </span>
        </div>
        {workspace ? (
          <div className="sidebar-ws-path" title={workspace.path}>
            {workspace.path}
          </div>
        ) : null}
      </div>

      <div className="sidebar-actions">
        <button type="button" className="btn" onClick={onOpenDir} disabled={busy}>
          <FolderOpen size={14} aria-hidden="true" />
          <span>{t('sidebar.openDir')}</span>
          <kbd>⇧⌘O</kbd>
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onNewSession}
          disabled={!workspace || busy}
        >
          <Plus size={14} aria-hidden="true" />
          <span>{t('sidebar.newTask')}</span>
          <kbd>⌘N</kbd>
        </button>
      </div>

      <div className="sidebar-sessions" aria-label={t('sidebar.sessionsLabel')}>
        {groups.length === 0 ? (
          <div className="sidebar-empty">
            {workspace ? t('sidebar.noSessions') : t('sidebar.openDirHint')}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="session-group">
              <div className="session-group-label">{group.label}</div>
              {group.items.map((item) => {
                const active = item.path === snapshot?.activeSessionPath
                const confirmDelete = confirming === item.path
                return (
                  <div
                    key={item.id}
                    className={`session-item${active ? ' session-item-active' : ''}`}
                    aria-current={active ? 'true' : undefined}
                  >
                    <button
                      type="button"
                      className="session-open"
                      title={item.preview}
                      onClick={() => onOpenSession(item.path)}
                    >
                      <span className="session-title">
                        <MessageSquare size={12} className="session-icon" aria-hidden="true" />
                        <span className="session-title-text">{item.title}</span>
                        <span className="session-time">{formatTime(item.modifiedAt)}</span>
                      </span>
                      <span className="session-preview">{item.preview}</span>
                      <span className="session-meta">{t('sidebar.messages', { n: item.messageCount })}</span>
                    </button>
                    <button
                      type="button"
                      className={`session-delete${confirmDelete ? ' session-delete-confirm' : ''}`}
                      aria-label={confirmDelete ? t('sidebar.confirmDeleteTitle', { title: item.title }) : t('sidebar.deleteTitle', { title: item.title })}
                      title={confirmDelete ? t('sidebar.confirmDeleteHint') : t('sidebar.deleteSession')}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (confirmDelete) {
                          setConfirming(null)
                          onDeleteSession(item.path)
                        } else {
                          setConfirming(item.path)
                        }
                      }}
                      onBlur={() => {
                        if (confirming === item.path) setConfirming(null)
                      }}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                      {confirmDelete ? <span>{t('sidebar.confirmDelete')}</span> : null}
                    </button>
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>

      <div className="sidebar-footer">
        <button type="button" className="btn sidebar-settings-btn" onClick={onOpenSettings} aria-label={t('sidebar.settings')} title={t('sidebar.settings')}>
          <Settings size={14} aria-hidden="true" />
          <span>{t('sidebar.settings')}</span>
        </button>
      </div>
    </div>
  )
}
