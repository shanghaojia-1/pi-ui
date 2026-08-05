import { useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, FileCode, Layers, Terminal } from 'lucide-react'
import type { AppSnapshot, ToolBlock } from '@shared/contracts'
import { formatCost, formatTokens, parsePatch, type DiffFile } from '../lib/format'
import ToolCall from './ToolCall'

function Section({
  title,
  icon,
  count,
  defaultOpen,
  children,
}: {
  title: string
  icon: ReactNode
  count: number
  defaultOpen: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="rp-section">
      <button
        type="button"
        className={`rp-section-head${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronRight size={12} className="rp-chevron" aria-hidden="true" />
        {icon}
        <span>{title}</span>
        {count > 0 ? <span className="rp-count">{count}</span> : null}
      </button>
      {open ? <div className="rp-section-body">{children}</div> : null}
    </section>
  )
}

function PatchCard({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="patch">
      <button
        type="button"
        className="patch-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={file.name}
      >
        <FileCode size={13} className="patch-icon" aria-hidden="true" />
        <span className="patch-name">{file.name}</span>
        <span className="patch-adds">+{file.adds}</span>
        <span className="patch-dels">−{file.dels}</span>
        <ChevronRight size={12} className={`patch-chevron${open ? ' open' : ''}`} aria-hidden="true" />
      </button>
      {open ? (
        <pre className="patch-body">
          {file.lines.map((line, i) => (
            <span key={i} className={`diff-${line.kind}`}>
              {line.text}
              {'\n'}
            </span>
          ))}
        </pre>
      ) : null}
    </div>
  )
}

interface RightPanelProps {
  snapshot: AppSnapshot | null
}

export default function RightPanel({ snapshot }: RightPanelProps) {
  const patches = useMemo(() => {
    if (!snapshot) return []
    const seen = new Set<string>()
    const files: { id: string; file: DiffFile }[] = []
    for (const m of snapshot.messages) {
      for (const b of m.blocks) {
        if (b.type !== 'tool' || b.patch === undefined || b.patch === '' || seen.has(b.id)) continue
        seen.add(b.id)
        for (const f of parsePatch(b.patch)) files.push({ id: `${b.id}::${f.name}`, file: f })
      }
    }
    return files
  }, [snapshot])

  const tools = useMemo(() => {
    if (!snapshot) return []
    const seen = new Set<string>()
    const list: ToolBlock[] = []
    for (const m of snapshot.messages) {
      for (const b of m.blocks) {
        if (b.type === 'tool' && !seen.has(b.id)) {
          seen.add(b.id)
          list.push(b)
        }
      }
    }
    return list.slice(-60).reverse()
  }, [snapshot])

  // The badge counts only tools that are actually in flight (pending/running);
  // settled and interrupted history keeps its own per-card semantics and is
  // never presented as part of the running count.
  const activeTools = useMemo(
    () => tools.filter((tool) => tool.status === 'pending' || tool.status === 'running').length,
    [tools],
  )

  const usage = snapshot?.usage
  // 总处理 counts everything the provider reported — cache writes included.
  const usageTotal =
    (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0)
  const cost = usage?.cost ?? 0
  const costTooltip =
    cost === 0
      ? '成本为 0：provider 未报告价格时可能显示为 0，不代表免费'
      : '成本按 provider 报告的价格计算'
  const empty = patches.length === 0 && tools.length === 0 && usageTotal === 0

  return (
    <div className="right-panel">
      <div className="rp-header">
        <Layers size={14} aria-hidden="true" />
        <span>活动</span>
      </div>
      <div className="rp-scroll">
        {empty ? (
          <div className="rp-empty">
            <Layers size={22} strokeWidth={1.4} aria-hidden="true" />
            <p>暂无活动</p>
            <p className="rp-empty-sub">开始对话后，文件变更、工具运行与用量会显示在这里</p>
          </div>
        ) : (
          <>
            {patches.length > 0 ? (
              <Section title="变更" icon={<FileCode size={13} aria-hidden="true" />} count={patches.length} defaultOpen>
                {patches.map((p) => (
                  <PatchCard key={p.id} file={p.file} />
                ))}
              </Section>
            ) : null}
            {tools.length > 0 ? (
              <Section title="工具运行" icon={<Terminal size={13} aria-hidden="true" />} count={activeTools} defaultOpen>
                {tools.map((tool) => (
                  <ToolCall key={tool.id} tool={tool} />
                ))}
              </Section>
            ) : null}
            {usageTotal > 0 ? (
              <Section title="用量" icon={<Layers size={13} aria-hidden="true" />} count={0} defaultOpen>
                <div className="usage-grid">
                  <span className="usage-label">输入 tokens</span>
                  <span className="usage-value">{formatTokens(usage?.input ?? 0)}</span>
                  <span className="usage-label">输出 tokens</span>
                  <span className="usage-value">{formatTokens(usage?.output ?? 0)}</span>
                  <span className="usage-label">缓存读取</span>
                  <span className="usage-value">{formatTokens(usage?.cacheRead ?? 0)}</span>
                  <span className="usage-label">缓存写入</span>
                  <span className="usage-value">{formatTokens(usage?.cacheWrite ?? 0)}</span>
                  <span className="usage-label" title={costTooltip}>
                    成本
                  </span>
                  <span className="usage-value" title={costTooltip}>
                    {formatCost(cost)}
                  </span>
                  <span className="usage-label usage-total" title="总处理 = 输入 + 输出 + 缓存读取 + 缓存写入">
                    总处理
                  </span>
                  <span className="usage-value usage-total">{formatTokens(usageTotal)} tokens</span>
                </div>
              </Section>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
