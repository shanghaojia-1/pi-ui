import { useMemo } from 'react'
import type { AppSnapshot, RunState, ThinkingLevel } from '@shared/contracts'
import { LoaderCircle, PanelLeft, PanelRight, Shield, ShieldAlert, TriangleAlert } from 'lucide-react'
import Select, { type SelectGroup, type SelectOption } from './Select'
import { formatTokens } from '../lib/format'
import { useI18n } from '../lib/i18n'

const RUN_META: Record<RunState, { labelKey: string }> = {
  idle: { labelKey: 'app.status.ready' },
  running: { labelKey: 'app.status.working' },
  retrying: { labelKey: 'app.status.retrying' },
  compacting: { labelKey: 'app.status.compacting' },
  error: { labelKey: 'topbar.error' },
}

const THINKING_KEYS: Record<string, string> = {
  off: 'topbar.thinking.off',
  minimal: 'topbar.thinking.minimal',
  low: 'topbar.thinking.low',
  medium: 'topbar.thinking.medium',
  high: 'topbar.thinking.high',
  xhigh: 'topbar.thinking.xhigh',
  max: 'topbar.thinking.max',
}

interface TopBarProps {
  snapshot: AppSnapshot | null
  sidebarOpen: boolean
  rightOpen: boolean
  onToggleSidebar: () => void
  onToggleRight: () => void
  onSetModel: (provider: string, id: string) => void
  onSetThinking: (level: ThinkingLevel) => void
  onOpenApproval: () => void
}

export default function TopBar({
  snapshot,
  sidebarOpen,
  rightOpen,
  onToggleSidebar,
  onToggleRight,
  onSetModel,
  onSetThinking,
  onOpenApproval,
}: TopBarProps) {
  const { t } = useI18n()
  const runState = snapshot?.runState ?? 'idle'
  const runMeta = RUN_META[runState]
  const runMetaLabel = t(runMeta.labelKey)
  const runCls = runState === 'idle' ? 'run-idle' : runState === 'error' ? 'run-error' : 'run-running'
  const workspace = snapshot?.workspace ?? null
  const models = snapshot?.models ?? []
  const activeModel = snapshot?.activeModel ?? null
  const thinkingOptions: SelectOption[] = Object.entries(THINKING_KEYS).map(([value, key]) => ({ value, label: t(key) }))
  // Model picker grouped by provider (hint = context window only; the provider
  // is the group header, mirroring the settings provider cards).
  const modelGroups: SelectGroup[] = useMemo(() => {
    const byProvider = new Map<string, { id: string; name: string; contextWindow?: number }[]>()
    for (const m of models) {
      const list = byProvider.get(m.provider) ?? []
      list.push({ id: m.id, name: m.name || m.id, ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}) })
      byProvider.set(m.provider, list)
    }
    return [...byProvider.entries()].map(([provider, list]) => ({
      label: provider,
      options: list.map((m) => ({
        value: `${provider}:${m.id}`,
        label: m.name,
        ...(m.contextWindow !== undefined ? { hint: formatTokens(m.contextWindow) } : {}),
      })),
    }))
  }, [models])

  const hasModelSelection = activeModel !== null && modelGroups.some((g) => g.options.some((o) => o.value === activeModel))
  // Source of truth is the AppSnapshot pushed by main: the badge flips the
  // moment the persisted mode changes, even while the settings sheet is busy.
  const approvalMode = snapshot?.toolApprovalMode ?? 'ask'

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          type="button"
          className="btn-icon"
          onClick={onToggleSidebar}
          aria-label={sidebarOpen ? t('topbar.collapseSidebar') : t('topbar.expandSidebar')}
          aria-pressed={sidebarOpen}
        >
          <PanelLeft size={15} aria-hidden="true" />
        </button>
        <div className={`run-pill ${runCls}`} role="status">
          <span className="run-dot" aria-hidden="true" />
          <span>{runMetaLabel}</span>
          {snapshot !== null && snapshot.queueCount > 0 ? (
            <span className="queue-badge">+{snapshot.queueCount} {t('topbar.queueBadge')}</span>
          ) : null}
          {runState === 'running' ? <LoaderCircle size={12} className="run-spin" aria-hidden="true" /> : null}
        </div>
      </div>

      <div className="topbar-right">
        <button
          type="button"
          className="btn-icon"
          onClick={onToggleRight}
          aria-label={rightOpen ? t('topbar.collapsePanel') : t('topbar.expandPanel')}
          aria-pressed={rightOpen}
        >
          <PanelRight size={15} aria-hidden="true" />
        </button>
        <Select
          label={t('topbar.thinkingLabel')}
          value={snapshot?.thinkingLevel ?? 'medium'}
          options={thinkingOptions}
          onChange={(v) => onSetThinking(v as ThinkingLevel)}
          disabled={!workspace}
          minWidth={104}
          maxWidth={190}
        />
        <Select
          label={t('topbar.modelLabel')}
          value={hasModelSelection ? activeModel : null}
          groups={modelGroups}
          onChange={(v) => {
            const i = v.indexOf(':')
            if (i > 0) onSetModel(v.slice(0, i), v.slice(i + 1))
          }}
          disabled={!workspace || models.length === 0}
          width={210}
          placeholder={models.length === 0 ? t('topbar.noModel') : t('topbar.selectModel')}
        />
        {models.length === 0 && workspace ? (
          <TriangleAlert size={14} className="topbar-warn" aria-label={t('app.noModels.title')} />
        ) : null}
        <button
          type="button"
          className={`approval-badge${approvalMode === 'managed' ? ' approval-badge-managed' : ' approval-badge-ask'}`}
          onClick={onOpenApproval}
          aria-label={
            approvalMode === 'managed'
              ? `${t('topbar.approval')}：${t('topbar.approval.managed')}`
              : `${t('topbar.approval')}：${t('topbar.approval.ask')}`
          }
          title={approvalMode === 'managed' ? `${t('topbar.approval.managed')} — ${t('topbar.approval')}` : `${t('topbar.approval.ask')} — ${t('topbar.approval')}`}
        >
          {approvalMode === 'managed' ? (
            <ShieldAlert size={13} className="approval-icon" aria-hidden="true" />
          ) : (
            <Shield size={13} className="approval-icon" aria-hidden="true" />
          )}
          <span className="approval-label">{approvalMode === 'managed' ? t('topbar.approval.managed') : t('topbar.approval.ask')}</span>
        </button>
      </div>
    </header>
  )
}
