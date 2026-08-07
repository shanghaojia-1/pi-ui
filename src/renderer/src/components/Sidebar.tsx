import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen, MessageSquare, Pencil, Plus, Search, Settings, Trash2, X } from 'lucide-react'
import type { AppSnapshot, SessionGroup, SessionListItem } from '@shared/contracts'
import { basename } from '../lib/path'
import { formatTime } from '../lib/format'
import { shortcut } from '../lib/shortcuts'
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

/** localStorage key for the per-group collapsed map. */
const COLLAPSED_KEY = 'pi-studio-group-collapsed'
/** Stable key for the ungrouped section. */
const UNGROUPED_KEY = '__ungrouped__'

const loadCollapsed = (): Record<string, boolean> => {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    const parsed = raw !== null ? (JSON.parse(raw) as unknown) : null
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {}
  } catch {
    return {}
  }
}

export default function Sidebar({ snapshot, busy, onOpenDir, onNewSession, onOpenSession, onDeleteSession, onOpenSettings }: SidebarProps) {
  const { t } = useI18n()
  const workspace = snapshot?.workspace ?? null
  /** Session paths awaiting the second (confirming) click; auto-resets on blur. */
  const [confirming, setConfirming] = useState<string | null>(null)
  /** Auto-reset timer for the delete confirmation (2s) so it never sticks. */
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearConfirmTimer = (): void => {
    if (confirmTimerRef.current !== null) {
      clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = null
    }
  }
  useEffect(() => () => clearConfirmTimer(), [])
  /** Session search query (matches title + preview, case-insensitive). */
  const [searchQuery, setSearchQuery] = useState('')
  /** Group sections currently collapsed (persisted). */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed)
  /** Inline group-creation form state; null = closed. */
  const [creating, setCreating] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupDirs, setGroupDirs] = useState<string[]>([])
  /** Group id currently being renamed inline. */
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  /** Drop-target highlight per group id (incl. the ungrouped drop zone). */
  const [dragOver, setDragOver] = useState<string | null>(null)
  /** Session path being dragged, for a drop ghost hint. */
  const [dragging, setDragging] = useState<string | null>(null)
  /** Group id whose "new task" click is in flight (double-click guard). */
  const [groupBusy, setGroupBusy] = useState<string | null>(null)
  /** Visible error from group create / dir pick IPC (surfaces main-side failures). */
  const [groupError, setGroupError] = useState<string | null>(null)
  /** New-task split-button dropdown open state. */
  const [newTaskMenu, setNewTaskMenu] = useState(false)
  const newTaskMenuRef = useRef<HTMLDivElement>(null)

  // Close the new-task dropdown on outside click / Escape.
  useEffect(() => {
    if (!newTaskMenu) return
    const onPointerDown = (e: PointerEvent): void => {
      if (newTaskMenuRef.current && !newTaskMenuRef.current.contains(e.target as Node)) setNewTaskMenu(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Escape') setNewTaskMenu(false) }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [newTaskMenu])

  /** New task pinned OUT of every group (ungrouped), regardless of cwd matching. */
  const newUngroupedTask = async (): Promise<void> => {
    setNewTaskMenu(false)
    const snap = await window.pi.newSession()
    if (snap.activeSessionPath !== null) {
      await window.pi.moveSessionToGroup(snap.activeSessionPath, null)
    }
  }

  const toggle = (key: string): void => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)) } catch { /* best effort */ }
      return next
    })
  }

  /** Sessions bucketed by group id; ungrouped sessions keyed by UNGROUPED_KEY. */
  const buckets = useMemo(() => {
    const byGroup = new Map<string, SessionListItem[]>()
    for (const session of snapshot?.sessions ?? []) {
      const key = session.groupId ?? UNGROUPED_KEY
      const list = byGroup.get(key)
      if (list) list.push(session)
      else byGroup.set(key, [session])
    }
    for (const list of byGroup.values()) {
      list.sort((a, b) => +new Date(b.modifiedAt) - +new Date(a.modifiedAt))
    }
    return byGroup
  }, [snapshot])

  const groups = snapshot?.groups ?? []
  const ungrouped = buckets.get(UNGROUPED_KEY) ?? []
  const countOf = (id: string): number => buckets.get(id)?.length ?? 0

  /** Flat search results across all groups, newest first; null = search off. */
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (query === '') return null
    const q = query
    return (snapshot?.sessions ?? [])
      .filter((s) => s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q))
      .sort((a, b) => +new Date(b.modifiedAt) - +new Date(a.modifiedAt))
  }, [snapshot, searchQuery])
  const searching = searchResults !== null

  const startCreate = (): void => {
    setCreating(true)
    setGroupError(null)
    setGroupName('')
    setGroupDirs(workspace ? [workspace.path] : [])
  }

  const addDir = async (): Promise<void> => {
    setGroupError(null)
    try {
      const dir = await window.pi.pickDirectory()
      if (dir !== null && !groupDirs.includes(dir)) setGroupDirs((prev) => [...prev, dir])
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : String(error))
    }
  }

  const submitCreate = async (): Promise<void> => {
    const name = groupName.trim()
    if (name === '' || groupDirs.length === 0) return
    setGroupError(null)
    try {
      await window.pi.createSessionGroup(name, groupDirs)
      setCreating(false)
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : String(error))
    }
  }

  const submitRename = async (id: string): Promise<void> => {
    const name = renameValue.trim()
    if (name !== '') await window.pi.renameSessionGroup(id, name)
    setRenaming(null)
  }

  /**
   * New task INSIDE a group: switch to the group's bound directory (first
   * match with the active workspace, else its first dir) and create a fresh
   * session there, so the new conversation lands in this group.
   */
  const newTaskInGroup = async (group: SessionGroup): Promise<void> => {
    if (groupBusy !== null) return
    setGroupBusy(group.id)
    try {
      const current = snapshot?.workspace?.path ?? null
      const lower = (p: string): string => p.toLowerCase()
      const dir = group.dirs.find((d) => current !== null && lower(d) === lower(current)) ?? group.dirs[0]
      if (dir === undefined) return // groups always have ≥1 dir (validated at creation)
      if (current === null || !group.dirs.some((d) => lower(d) === lower(current))) {
        await window.pi.openWorkspace(dir)
      }
      await window.pi.newSession()
    } finally {
      setGroupBusy(null)
    }
  }

  /** Drag helpers: session path travels in the dataTransfer payload. */
  const onDragStart = (e: React.DragEvent, path: string): void => {
    e.dataTransfer.setData('text/pi-session', path)
    e.dataTransfer.effectAllowed = 'move'
    setDragging(path)
  }
  const onDrop = async (e: React.DragEvent, groupId: string | null): Promise<void> => {
    e.preventDefault()
    setDragOver(null)
    setDragging(null)
    const path = e.dataTransfer.getData('text/pi-session')
    if (path !== '') await window.pi.moveSessionToGroup(path, groupId)
  }

  const renderSession = (item: SessionListItem): React.ReactNode => {
    const active = item.path === snapshot?.activeSessionPath
    const confirmDelete = confirming === item.path
    const requestDelete = (): void => {
      clearConfirmTimer()
      setConfirming(item.path)
      confirmTimerRef.current = setTimeout(() => setConfirming(null), 2000)
    }
    return (
      <div
        key={item.id}
        className={`session-item${active ? ' session-item-active' : ''}${dragging === item.path ? ' session-item-dragging' : ''}`}
        aria-current={active ? 'true' : undefined}
        draggable
        onDragStart={(e) => onDragStart(e, item.path)}
        onDragEnd={() => setDragging(null)}
      >
        <button
          type="button"
          className="session-open"
          title={item.preview}
          onClick={() => onOpenSession(item.path)}
        >
          <span className="session-title">
            <MessageSquare size={12} className="session-icon" aria-hidden="true" />
            <span className="session-title-text" title={item.title}>{item.title}</span>
            <span className="session-time">{formatTime(item.modifiedAt)}</span>
          </span>
          <span className="session-preview">{item.preview}</span>
          {item.workspace ? (
            <span className="session-ws" title={item.workspace.path}>
              <Folder size={10} className="session-ws-icon" aria-hidden="true" />
              <span className="session-ws-name">{item.workspace.name}</span>
            </span>
          ) : null}
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
              clearConfirmTimer()
              setConfirming(null)
              onDeleteSession(item.path)
            } else {
              requestDelete()
            }
          }}
          onBlur={() => {
            if (confirming === item.path) {
              clearConfirmTimer()
              setConfirming(null)
            }
          }}
        >
          <Trash2 size={12} aria-hidden="true" />
          {confirmDelete ? <span>{t('sidebar.confirmDelete')}</span> : null}
        </button>
      </div>
    )
  }

  const renderGroup = (group: SessionGroup): React.ReactNode => {
    const items = buckets.get(group.id) ?? []
    const open = !collapsed[group.id]
    const renamingThis = renaming === group.id
    const dirCount = group.dirs.length
    return (
      <div
        key={group.id}
        className={`session-group${dragOver === group.id ? ' session-group-dragover' : ''}`}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(group.id) }}
        onDragLeave={() => setDragOver((cur) => (cur === group.id ? null : cur))}
        onDrop={(e) => void onDrop(e, group.id)}
      >
        <div
          className={`session-group-head${open ? ' session-group-head-open' : ''}`}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={() => toggle(group.id)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(group.id) } }}
        >
          {open ? <ChevronDown size={13} className="session-group-chevron" aria-hidden="true" /> : <ChevronRight size={13} className="session-group-chevron" aria-hidden="true" />}
          <span className="session-group-icon" aria-hidden="true">
            <Folder size={15} />
          </span>
          <span className="session-group-text">
            {renamingThis ? (
              <input
                className="session-group-rename"
                value={renameValue}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitRename(group.id)
                  if (e.key === 'Escape') setRenaming(null)
                }}
                onBlur={() => void submitRename(group.id)}
              />
            ) : (
              <span className="session-group-name" title={group.dirs.map((d) => d).join('\n')}>{group.name}</span>
            )}
            <span className="session-group-sub">
              {t('sidebar.groupMeta', { sessions: items.length, dirs: dirCount })}
            </span>
          </span>
          <span className="session-group-actions">
            <button
              type="button"
              className="btn-icon session-group-btn"
              aria-label={t('sidebar.newTaskInGroup', { name: group.name })}
              title={t('sidebar.newTaskInGroupHint')}
              disabled={groupBusy === group.id || busy}
              onClick={(e) => {
                e.stopPropagation()
                void newTaskInGroup(group)
              }}
            >
              <Plus size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn-icon session-group-btn"
              aria-label={t('sidebar.renameGroup')}
              title={t('sidebar.renameGroup')}
              onClick={(e) => {
                e.stopPropagation()
                setRenaming(group.id)
                setRenameValue(group.name)
              }}
            >
              <Pencil size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn-icon session-group-btn session-group-btn-del"
              aria-label={t('sidebar.deleteGroup')}
              title={t('sidebar.deleteGroupHint')}
              onClick={(e) => {
                e.stopPropagation()
                void window.pi.deleteSessionGroup(group.id)
              }}
            >
              <Trash2 size={13} aria-hidden="true" />
            </button>
          </span>
        </div>
        {open ? <div className="session-group-items">{items.map(renderSession)}</div> : null}
      </div>
    )
  }

  return (
    <div className="sidebar">
      <div className="sidebar-workspace">
        <div className="sidebar-ws-row">
          <FolderOpen size={14} className="sidebar-ws-icon" aria-hidden="true" />
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
          <kbd>{shortcut('⇧⌘O', 'Ctrl+Shift+O')}</kbd>
        </button>
        <div className="sidebar-newtask" ref={newTaskMenuRef}>
          <button
            type="button"
            className="btn btn-primary sidebar-newtask-main"
            onClick={onNewSession}
            disabled={!workspace || busy}
          >
            <Plus size={14} aria-hidden="true" />
            <span>{t('sidebar.newTask')}</span>
            <kbd>{shortcut('⌘N', 'Ctrl+N')}</kbd>
          </button>
          <button
            type="button"
            className="sidebar-newtask-caret"
            aria-label={t('sidebar.newTaskMenu')}
            title={t('sidebar.newTaskMenu')}
            disabled={!workspace || busy}
            onClick={() => setNewTaskMenu((v) => !v)}
          >
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {newTaskMenu ? (
            <div className="newtask-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setNewTaskMenu(false)
                  onNewSession()
                }}
              >
                <Plus size={12} aria-hidden="true" />
                <span>{t('sidebar.newTask')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void newUngroupedTask()}
              >
                <Plus size={12} aria-hidden="true" />
                <span>{t('sidebar.newTaskHere')}</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="sidebar-sessions" aria-label={t('sidebar.sessionsLabel')}>
        {workspace ? (
          <div className="sidebar-search">
            <Search size={12} className="sidebar-search-icon" aria-hidden="true" />
            <input
              type="text"
              className="sidebar-search-input"
              placeholder={t('sidebar.searchPh')}
              aria-label={t('sidebar.searchAria')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery !== '' ? (
              <button
                type="button"
                className="btn-icon sidebar-search-clear"
                aria-label={t('sidebar.searchClear')}
                title={t('sidebar.searchClear')}
                onClick={() => setSearchQuery('')}
              >
                <X size={11} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}

        {searching ? (
          searchResults.length === 0 ? (
            <div className="sidebar-empty">
              <p>{t('sidebar.searchNone')}</p>
            </div>
          ) : (
            <>
              <div className="sidebar-search-meta">
                <span>{t('sidebar.searchResults', { n: searchResults.length })}</span>
                <button type="button" className="btn btn-sm" onClick={() => setSearchQuery('')}>
                  <X size={11} aria-hidden="true" />
                  {t('sidebar.searchClear')}
                </button>
              </div>
              <div className="sidebar-search-results">{searchResults.map(renderSession)}</div>
            </>
          )
        ) : (
          <>
        {creating ? (
          <div className="group-form">
            <div className="group-form-row">
              <input
                className="group-form-name"
                value={groupName}
                placeholder={t('sidebar.groupNamePh')}
                aria-label={t('sidebar.groupName')}
                autoFocus
                onChange={(e) => setGroupName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submitCreate() }}
              />
              <button type="button" className="btn-icon group-form-close" aria-label={t('common.close')} onClick={() => setCreating(false)}>
                <X size={12} aria-hidden="true" />
              </button>
            </div>
            <div className="group-form-dirs">
              {groupDirs.map((dir) => (
                <span key={dir} className="group-dir" title={dir}>
                  <Folder size={10} aria-hidden="true" />
                  <span className="group-dir-name">{basename(dir)}</span>
                  <button
                    type="button"
                    className="group-dir-remove"
                    aria-label={t('sidebar.removeDir')}
                    onClick={() => setGroupDirs((prev) => prev.filter((d) => d !== dir))}
                  >
                    <X size={9} aria-hidden="true" />
                  </button>
                </span>
              ))}
              <button type="button" className="group-dir-add" onClick={() => void addDir()}>
                <Plus size={10} aria-hidden="true" />
                <span>{t('sidebar.addDir')}</span>
              </button>
            </div>
            <div className="group-form-actions">
              {groupError !== null ? <span className="group-form-error">{groupError}</span> : null}
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void submitCreate()}
                disabled={groupName.trim() === '' || groupDirs.length === 0}
              >
                {t('sidebar.createGroup')}
              </button>
            </div>
          </div>
        ) : null}

        {groups.length === 0 && ungrouped.length === 0 && !creating ? (
          <div className="sidebar-empty">
            {workspace ? (
              <>
                <MessageSquare size={22} className="sidebar-empty-icon" aria-hidden="true" />
                <p>{t('sidebar.noSessions')}</p>
                <button type="button" className="btn btn-primary" onClick={onNewSession} disabled={busy}>
                  <Plus size={14} aria-hidden="true" />
                  <span>{t('sidebar.startFirst')}</span>
                </button>
                <span className="sidebar-empty-hint">{t('sidebar.startFirstHint', { kbd: shortcut('⌘N', 'Ctrl+N') })}</span>
              </>
            ) : (
              <p>{t('sidebar.openDirHint')}</p>
            )}
          </div>
        ) : null}

        {groups.map(renderGroup)}

        {/* Ungrouped sessions live flat OUTSIDE every group: no collapsible
            header — a plain drop zone under the groups (Codex-style). */}
        {ungrouped.length > 0 ? (
          <div
            key={UNGROUPED_KEY}
            className={`session-ungrouped${dragOver === UNGROUPED_KEY ? ' session-group-dragover' : ''}`}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(UNGROUPED_KEY) }}
            onDragLeave={() => setDragOver((cur) => (cur === UNGROUPED_KEY ? null : cur))}
            onDrop={(e) => void onDrop(e, null)}
          >
            {ungrouped.map(renderSession)}
          </div>
        ) : null}
          </>
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
