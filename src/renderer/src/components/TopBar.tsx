import type { AppSnapshot, RunState, ThinkingLevel } from '@shared/contracts'
import { LoaderCircle, PanelLeft, PanelRight, Shield, ShieldAlert, TriangleAlert } from 'lucide-react'
import Select, { type SelectOption } from './Select'
import { formatTokens } from '../lib/format'

const RUN_META: Record<RunState, { label: string }> = {
  idle: { label: '就绪' },
  running: { label: '运行中' },
  retrying: { label: '重试中' },
  compacting: { label: '压缩中' },
  error: { label: '出错' },
}

const THINKING_OPTIONS: SelectOption[] = [
  { value: 'off', label: '关闭' },
  { value: 'minimal', label: '最低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '很高' },
  { value: 'max', label: '最高' },
]

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
  const runState = snapshot?.runState ?? 'idle'
  const runMeta = RUN_META[runState]
  const runCls = runState === 'idle' ? 'run-idle' : runState === 'error' ? 'run-error' : 'run-running'
  const workspace = snapshot?.workspace ?? null
  const models = snapshot?.models ?? []
  const activeModel = snapshot?.activeModel ?? null
  const modelOptions: SelectOption[] = models.map((m) => ({
    value: `${m.provider}:${m.id}`,
    label: m.name,
    hint: m.contextWindow !== undefined ? `${m.provider} · ${formatTokens(m.contextWindow)}` : m.provider,
  }))

  const hasModelSelection = activeModel !== null && modelOptions.some((o) => o.value === activeModel)
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
          aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
          aria-pressed={sidebarOpen}
        >
          <PanelLeft size={15} aria-hidden="true" />
        </button>
        <div className={`run-pill ${runCls}`} role="status">
          <span className="run-dot" aria-hidden="true" />
          <span>{runMeta.label}</span>
          {snapshot !== null && snapshot.queueCount > 0 ? (
            <span className="queue-badge">+{snapshot.queueCount} 排队</span>
          ) : null}
          {runState === 'running' ? <LoaderCircle size={12} className="run-spin" aria-hidden="true" /> : null}
        </div>
      </div>

      <div className="topbar-right">
        <button
          type="button"
          className="btn-icon"
          onClick={onToggleRight}
          aria-label={rightOpen ? '收起活动面板' : '展开活动面板'}
          aria-pressed={rightOpen}
        >
          <PanelRight size={15} aria-hidden="true" />
        </button>
        <Select
          label="思考"
          value={snapshot?.thinkingLevel ?? 'medium'}
          options={THINKING_OPTIONS}
          onChange={(v) => onSetThinking(v as ThinkingLevel)}
          disabled={!workspace}
          width={104}
        />
        <Select
          label="模型"
          value={hasModelSelection ? activeModel : null}
          options={modelOptions}
          onChange={(v) => {
            const i = v.indexOf(':')
            if (i > 0) onSetModel(v.slice(0, i), v.slice(i + 1))
          }}
          disabled={!workspace || models.length === 0}
          width={210}
          placeholder={models.length === 0 ? '无可用模型' : '选择模型'}
        />
        {models.length === 0 && workspace ? (
          <TriangleAlert size={14} className="topbar-warn" aria-label="未找到可用模型" />
        ) : null}
        <button
          type="button"
          className={`approval-badge${approvalMode === 'managed' ? ' approval-badge-managed' : ' approval-badge-ask'}`}
          onClick={onOpenApproval}
          aria-label={
            approvalMode === 'managed'
              ? '工具审批：全托管 · 非沙箱，点击打开设置'
              : '工具审批：逐次确认，点击打开设置'
          }
          title={approvalMode === 'managed' ? '全托管 · 非沙箱 — 点击打开设置' : '逐次确认 — 点击打开设置'}
        >
          {approvalMode === 'managed' ? (
            <ShieldAlert size={13} className="approval-icon" aria-hidden="true" />
          ) : (
            <Shield size={13} className="approval-icon" aria-hidden="true" />
          )}
          <span className="approval-label">{approvalMode === 'managed' ? '全托管 · 非沙箱' : '逐次确认'}</span>
        </button>
      </div>
    </header>
  )
}
