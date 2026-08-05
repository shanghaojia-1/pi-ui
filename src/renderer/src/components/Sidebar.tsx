import { useMemo } from 'react'
import { Folder, FolderOpen, MessageSquare, Plus, Settings } from 'lucide-react'
import type { AppSnapshot, SessionListItem } from '@shared/contracts'
import { formatTime, sessionGroup } from '../lib/format'

interface SidebarProps {
  snapshot: AppSnapshot | null
  busy: boolean
  onOpenDir: () => void
  onNewSession: () => void
  onOpenSession: (path: string) => void
  onOpenSettings: () => void
}

interface SessionGroup {
  label: string
  items: SessionListItem[]
}

export default function Sidebar({ snapshot, busy, onOpenDir, onNewSession, onOpenSession, onOpenSettings }: SidebarProps) {
  const workspace = snapshot?.workspace ?? null

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
    const labels: Record<string, string> = { today: '今天', yesterday: '昨天', earlier: '更早' }
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
            {workspace ? workspace.name : '未打开工作区'}
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
          <span>打开目录</span>
          <kbd>⇧⌘O</kbd>
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onNewSession}
          disabled={!workspace || busy}
        >
          <Plus size={14} aria-hidden="true" />
          <span>新任务</span>
          <kbd>⌘N</kbd>
        </button>
      </div>

      <div className="sidebar-sessions" aria-label="会话列表">
        {groups.length === 0 ? (
          <div className="sidebar-empty">
            {workspace ? '暂无会话' : '打开目录后显示会话'}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="session-group">
              <div className="session-group-label">{group.label}</div>
              {group.items.map((item) => {
                const active = item.path === snapshot?.activeSessionPath
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`session-item${active ? ' session-item-active' : ''}`}
                    aria-current={active ? 'true' : undefined}
                    title={item.preview}
                    onClick={() => onOpenSession(item.path)}
                  >
                    <span className="session-title">
                      <MessageSquare size={12} className="session-icon" aria-hidden="true" />
                      <span className="session-title-text">{item.title}</span>
                      <span className="session-time">{formatTime(item.modifiedAt)}</span>
                    </span>
                    <span className="session-preview">{item.preview}</span>
                    <span className="session-meta">{item.messageCount} 条消息</span>
                  </button>
                )
              })}
            </div>
          ))
        )}
      </div>

      <div className="sidebar-footer">
        <button type="button" className="btn sidebar-settings-btn" onClick={onOpenSettings} aria-label="设置" title="设置">
          <Settings size={14} aria-hidden="true" />
          <span>设置</span>
        </button>
      </div>
    </div>
  )
}
