import { useEffect, useMemo, useState } from 'react'
import {
  BrainCircuit,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock3,
  GitBranch,
  LoaderCircle,
  MessageSquareText,
  Square,
  UserRound,
  UsersRound,
  Wrench,
} from 'lucide-react'
import type {
  SubagentDetails,
  SubagentEvent,
  SubagentResult,
  SubagentTaskStatus,
  SubagentUsage,
  ToolBlock,
} from '@shared/contracts'
import { formatCost, formatDuration, formatTokens } from '../lib/format'
import { useI18n } from '../lib/i18n'
import Markdown from './Markdown'
import ArtifactChips from './ArtifactChips'

/** Guard both legacy persisted details and the version 2 live protocol. */
export function isSubagentDetails(value: unknown): value is SubagentDetails {
  if (!value || typeof value !== 'object') return false
  const details = value as SubagentDetails
  return (
    (details.mode === 'single' || details.mode === 'parallel' || details.mode === 'chain') &&
    Array.isArray(details.results)
  )
}

type VisualStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled'

const taskStatusOf = (result: SubagentResult): SubagentTaskStatus => {
  if (result.status) return result.status
  if (result.exitCode === -1) return 'streaming'
  if (result.exitCode !== 0 || result.stopReason === 'error') return 'failed'
  if (result.stopReason === 'aborted') return 'cancelled'
  return 'completed'
}

const visualStatusOf = (status: SubagentTaskStatus): VisualStatus => {
  if (status === 'queued') return 'queued'
  if (status === 'completed') return 'success'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'failed') return 'error'
  return 'running'
}

const statusKey = (status: SubagentTaskStatus): string => `toolcall.subagent.status.${status}`

function StatusIcon({ status }: { status: VisualStatus }) {
  if (status === 'queued') return <Clock3 size={13} className="subagent-status-queued" aria-hidden="true" />
  if (status === 'running') return <LoaderCircle size={13} className="subagent-status-running" aria-hidden="true" />
  if (status === 'success') return <CircleCheck size={13} className="subagent-status-success" aria-hidden="true" />
  if (status === 'cancelled') return <Square size={12} className="subagent-status-cancelled" aria-hidden="true" />
  return <CircleX size={13} className="subagent-status-error" aria-hidden="true" />
}

function UsageLine({ usage, model }: { usage?: Partial<SubagentUsage> | undefined; model?: string | undefined }) {
  const { t } = useI18n()
  if (!usage && !model) return null
  const parts: string[] = []
  if (usage?.turns) parts.push(t('toolcall.subagent.turns', { n: usage.turns }))
  if (usage?.input) parts.push(`↑${formatTokens(usage.input)}`)
  if (usage?.output) parts.push(`↓${formatTokens(usage.output)}`)
  if (usage?.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`)
  if (usage?.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`)
  if (usage?.cost) parts.push(formatCost(usage.cost))
  if (usage?.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`)
  if (model) parts.push(model)
  return parts.length > 0 ? <span className="subagent-usage">{parts.join(' ')}</span> : null
}

const finalOutputOf = (result: SubagentResult): string => {
  if (result.output) return result.output
  const messages = result.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    if (typeof message.content === 'string') return message.content
    if (!Array.isArray(message.content)) continue
    const text = message.content
      .map((part) => {
        if (!part || typeof part !== 'object') return ''
        const block = part as { type?: string; text?: string }
        return block.type === 'text' ? block.text ?? '' : ''
      })
      .join('')
    if (text) return text
  }
  return ''
}

/** Legacy version 1 histories stored tool calls only inside child messages. */
const legacyToolCallsOf = (result: SubagentResult): Array<{ name: string; args: string }> => {
  const calls: Array<{ name: string; args: string }> = []
  for (const message of result.messages ?? []) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      const block = part as { type?: string; name?: string; arguments?: unknown } | null
      if (!block || block.type !== 'toolCall' || typeof block.name !== 'string') continue
      calls.push({ name: block.name, args: printable(block.arguments) })
    }
  }
  return calls
}

const printable = (value: unknown): string => {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? {})
    return text.length > 240 ? `${text.slice(0, 240)}…` : text
  } catch {
    return ''
  }
}

function EventIcon({ event }: { event: SubagentEvent }) {
  if (event.kind === 'tool') return <Wrench size={12} aria-hidden="true" />
  if (event.kind === 'thinking') return <BrainCircuit size={12} aria-hidden="true" />
  if (event.kind === 'message') return <MessageSquareText size={12} aria-hidden="true" />
  if (event.kind === 'error') return <CircleX size={12} aria-hidden="true" />
  return event.status === 'success'
    ? <CircleCheck size={12} aria-hidden="true" />
    : <LoaderCircle size={12} className={event.status === 'running' ? 'subagent-status-running' : ''} aria-hidden="true" />
}

function EventRow({ event }: { event: SubagentEvent }) {
  const [open, setOpen] = useState(event.status === 'running')
  const body = event.args || event.output || event.text
  return (
    <div className={`subagent-event subagent-event-${event.status}`}>
      <button
        type="button"
        className="subagent-event-head"
        disabled={!body}
        aria-expanded={body ? open : undefined}
        onClick={() => body && setOpen((value) => !value)}
      >
        {body ? <ChevronRight size={10} className="subagent-event-chevron" aria-hidden="true" /> : <span className="subagent-event-spacer" />}
        <EventIcon event={event} />
        <span>{event.label}</span>
        {event.toolName ? <code>{event.toolName}</code> : null}
      </button>
      {body && open ? (
        <div className="subagent-event-body">
          {event.args ? <pre><span>args</span>{event.args}</pre> : null}
          {event.output ? <pre><span>output</span>{event.output}</pre> : null}
          {event.text ? <pre><span>text</span>{event.text}</pre> : null}
        </div>
      ) : null}
    </div>
  )
}

function ResultRow({ result, live }: { result: SubagentResult; live: boolean }) {
  const { t } = useI18n()
  const status = taskStatusOf(result)
  const visual = visualStatusOf(status)
  const [open, setOpen] = useState(live && visual !== 'queued')
  useEffect(() => {
    if (live && visual !== 'queued') setOpen(true)
  }, [live, visual])
  const output = finalOutputOf(result)
  const legacyCalls = legacyToolCallsOf(result)
  const events = result.events ?? []
  const hasBody = result.task !== '' || result.liveText || output || events.length > 0 || legacyCalls.length > 0 || result.errorMessage

  return (
    <div className={`subagent-result subagent-result-${visual}`} data-status={visual}>
      <button
        type="button"
        className="subagent-result-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        disabled={!hasBody}
      >
        <ChevronRight size={11} className="subagent-result-chevron" aria-hidden="true" />
        <StatusIcon status={visual} />
        <span className="subagent-result-agent">{result.agent}</span>
        <span className="subagent-result-state">{t(statusKey(status))}</span>
        {result.durationMs !== undefined ? <span className="subagent-result-duration">{formatDuration(result.durationMs)}</span> : null}
        <UsageLine usage={result.usage} model={result.model} />
      </button>
      {open ? (
        <div className="subagent-result-body">
          {live && result.id && visual === 'running' ? (
            <button
              type="button"
              className="subagent-result-stop"
              onClick={() => void window.pi.cancelSubagent(result.id!)}
            >
              <Square size={10} fill="currentColor" aria-hidden="true" />
              {t('toolcall.subagent.stopOne')}
            </button>
          ) : null}
          {result.task ? (
            <div className="subagent-result-section">
              <span className="subagent-result-section-title">{t('toolcall.subagent.task')}</span>
              <p className="subagent-result-task">{result.task}</p>
            </div>
          ) : null}
          {events.length > 0 ? (
            <div className="subagent-result-section">
              <span className="subagent-result-section-title">{t('toolcall.subagent.timeline')}</span>
              <div className="subagent-events">{events.map((event) => <EventRow event={event} key={event.id} />)}</div>
            </div>
          ) : null}
          {legacyCalls.length > 0 ? (
            <div className="subagent-result-section">
              <span className="subagent-result-section-title">{t('toolcall.subagent.tools')}</span>
              <ul className="subagent-result-calls">
                {legacyCalls.map((call, index) => <li key={index}><code>{call.name}</code><span>{call.args}</span></li>)}
              </ul>
            </div>
          ) : null}
          {result.errorMessage ? <p className="subagent-result-error">{result.errorMessage}</p> : null}
          {live && result.liveText ? (
            <div className="subagent-result-section">
              <span className="subagent-result-section-title">{t('toolcall.subagent.liveOutput')}</span>
              <pre className="subagent-live-output">{result.liveText}</pre>
            </div>
          ) : null}
          {!live && output ? (
            <div className="subagent-result-section">
              <span className="subagent-result-section-title">{t('toolcall.subagent.output')}</span>
              <div className="subagent-result-output"><Markdown text={output} className="msg-text" /></div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function aggregateUsage(results: SubagentResult[]): Partial<SubagentUsage> {
  const total: Partial<SubagentUsage> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }
  for (const result of results) {
    if (!result.usage) continue
    total.input = (total.input ?? 0) + (result.usage.input ?? 0)
    total.output = (total.output ?? 0) + (result.usage.output ?? 0)
    total.cacheRead = (total.cacheRead ?? 0) + (result.usage.cacheRead ?? 0)
    total.cacheWrite = (total.cacheWrite ?? 0) + (result.usage.cacheWrite ?? 0)
    total.cost = (total.cost ?? 0) + (result.usage.cost ?? 0)
    total.turns = (total.turns ?? 0) + (result.usage.turns ?? 0)
  }
  return total
}

export default function SubagentCard({ tool }: { tool: ToolBlock }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(tool.status === 'running')
  useEffect(() => {
    if (tool.status === 'running') setOpen(true)
  }, [tool.status])
  const details = useMemo(() => isSubagentDetails(tool.details) ? tool.details : null, [tool.details])

  if (!details) {
    return (
      <div className="toolcall subagent-card toolcall-open" data-status="running">
        <button type="button" className="toolcall-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <ChevronRight size={12} className="toolcall-chevron" aria-hidden="true" />
          <LoaderCircle size={13} className="subagent-status-running" aria-hidden="true" />
          <span className="toolcall-name">subagent</span>
          <span className="toolcall-state">{t('toolcall.subagent.running')}</span>
        </button>
        <ArtifactChips artifacts={tool.artifacts} />
        {open ? <div className="toolcall-body subagent-body"><p className="subagent-empty">{t('toolcall.subagent.waiting')}</p></div> : null}
      </div>
    )
  }

  const total = details.total ?? details.results.length
  const completed = details.results.filter((result) => taskStatusOf(result) === 'completed').length
  const failed = details.results.filter((result) => ['failed', 'cancelled'].includes(taskStatusOf(result))).length
  const queued = details.results.filter((result) => taskStatusOf(result) === 'queued').length
  const running = Math.max(0, total - completed - failed - queued)
  const live = tool.status === 'running'
  const modeLabel = details.mode === 'parallel'
    ? t('toolcall.subagent.parallel', { n: total })
    : details.mode === 'chain'
      ? t('toolcall.subagent.chain', { n: total })
      : t('toolcall.subagent.single')
  const modeIcon = details.mode === 'parallel'
    ? <UsersRound size={12} aria-hidden="true" />
    : details.mode === 'chain'
      ? <GitBranch size={12} aria-hidden="true" />
      : <UserRound size={12} aria-hidden="true" />
  const headline = live
    ? t('toolcall.subagent.liveV2', { done: completed, total, running, queued })
    : t('toolcall.subagent.done', { done: completed, total })

  return (
    <div className={`toolcall subagent-card${open ? ' toolcall-open' : ''}`} data-status={tool.status}>
      <div className="subagent-card-head">
        <button type="button" className="toolcall-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <ChevronRight size={12} className="toolcall-chevron" aria-hidden="true" />
          <StatusIcon status={live ? 'running' : tool.status === 'error' || failed > 0 ? 'error' : 'success'} />
          <span className="toolcall-name">subagent</span>
          <span className="subagent-mode-label">{modeIcon}{modeLabel}</span>
          <span className="toolcall-state">{headline}</span>
          {details.results.length > 1 ? <UsageLine usage={aggregateUsage(details.results)} /> : null}
        </button>
        {live ? (
          <button
            type="button"
            className="subagent-stop"
            onClick={() => void window.pi.abort()}
            aria-label={t('toolcall.subagent.stop')}
            title={t('toolcall.subagent.stop')}
          >
            <Square size={11} fill="currentColor" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <ArtifactChips artifacts={tool.artifacts} />
      {open ? (
        <div className="toolcall-body subagent-body">
          {details.results.length === 0 ? <p className="subagent-empty">{t('toolcall.subagent.empty')}</p> : null}
          {details.results.map((result, index) => details.mode === 'chain' ? (
            <div className="subagent-step" key={result.id ?? `${result.agent}-${index}`}>
              <span className="subagent-step-index">{result.step ?? index + 1}</span>
              <div className="subagent-step-body"><ResultRow result={result} live={live} /></div>
            </div>
          ) : <ResultRow result={result} live={live} key={result.id ?? `${result.agent}-${index}`} />)}
        </div>
      ) : null}
    </div>
  )
}
