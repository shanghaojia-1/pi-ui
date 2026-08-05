import { useEffect, useState } from 'react'
import { ChevronRight, CircleCheck, CircleSlash, CircleX, Clock, LoaderCircle } from 'lucide-react'
import type { ToolBlock } from '@shared/contracts'
import { formatDuration } from '../lib/format'

const STATUS_META: Record<ToolBlock['status'], { label: string }> = {
  pending: { label: '排队中' },
  running: { label: '运行中' },
  success: { label: '成功' },
  error: { label: '失败' },
  interrupted: { label: '已中断' },
}

function StatusIcon({ status }: { status: ToolBlock['status'] }) {
  if (status === 'pending') return <Clock size={13} className={`tool-status-${status}`} aria-hidden="true" />
  if (status === 'running') return <LoaderCircle size={13} className={`tool-status-${status}`} aria-hidden="true" />
  if (status === 'success') return <CircleCheck size={13} className={`tool-status-${status}`} aria-hidden="true" />
  if (status === 'interrupted') return <CircleSlash size={13} className={`tool-status-${status}`} aria-hidden="true" />
  return <CircleX size={13} className={`tool-status-${status}`} aria-hidden="true" />
}

export default function ToolCall({ tool }: { tool: ToolBlock }) {
  const [open, setOpen] = useState(tool.status === 'running')
  useEffect(() => {
    if (tool.status === 'running') setOpen(true)
  }, [tool.status])

  const hasOutput = tool.output !== undefined && tool.output !== ''
  const hasPatch = tool.patch !== undefined && tool.patch !== ''
  const hasInput = tool.input !== ''
  const meta = STATUS_META[tool.status]

  return (
    <div className={`toolcall${open ? ' toolcall-open' : ''}`} data-status={tool.status}>
      <button
        type="button"
        className="toolcall-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`工具 ${tool.name}（${meta.label}）`}
      >
        <ChevronRight size={12} className="toolcall-chevron" aria-hidden="true" />
        <StatusIcon status={tool.status} />
        <span className="toolcall-name">{tool.name}</span>
        <span className="toolcall-state">{meta.label}</span>
        {tool.durationMs !== undefined ? (
          <span className="toolcall-duration">{formatDuration(tool.durationMs)}</span>
        ) : null}
        {hasPatch ? <span className="toolcall-patch-badge">patch</span> : null}
      </button>
      {open && (
        <div className="toolcall-body">
          {hasInput && (
            <details className="toolcall-section" open>
              <summary>参数</summary>
              <pre className="toolcall-pre">{tool.input}</pre>
            </details>
          )}
          {hasOutput && (
            <details className="toolcall-section" open={tool.status === 'error'}>
              <summary>输出</summary>
              <pre className="toolcall-pre">{tool.output}</pre>
            </details>
          )}
          {hasPatch && (
            <details className="toolcall-section">
              <summary>变更</summary>
              <pre className="toolcall-pre toolcall-patch">{tool.patch}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
