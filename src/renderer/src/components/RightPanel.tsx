import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  FileCode,
  Layers,
  LoaderCircle,
  Terminal,
} from 'lucide-react'
import type { AppSnapshot, ArtifactFile, ArtifactKind, ArtifactPreview, ToolBlock } from '@shared/contracts'
import { formatCost, formatTokens, parsePatch, type DiffFile } from '../lib/format'
import ToolCall from './ToolCall'
import { useI18n } from '../lib/i18n'
import { onArtifactPreview } from '../lib/artifacts'
import { ArtifactIcon } from './ArtifactChips'

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

const KIND_LABEL_KEY: Record<ArtifactKind, string> = {
  text: 'artifact.kind.text',
  pdf: 'artifact.kind.pdf',
  video: 'artifact.kind.video',
  binary: 'artifact.kind.binary',
}

interface RightPanelProps {
  snapshot: AppSnapshot | null
}

export default function RightPanel({ snapshot }: RightPanelProps) {
  const { t } = useI18n()
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

  /** All artifacts produced in this session, deduplicated by canonical path. */
  const artifacts = useMemo(() => {
    if (!snapshot) return []
    const seen = new Set<string>()
    const list: ArtifactFile[] = []
    for (const m of snapshot.messages) {
      for (const b of m.blocks) {
        if (b.type !== 'tool' || !b.artifacts) continue
        for (const artifact of b.artifacts) {
          if (!seen.has(artifact.path)) {
            seen.add(artifact.path)
            list.push(artifact)
          }
        }
      }
    }
    return list
  }, [snapshot])

  // Sidebar preview state. Loading is sequenced so a slow response can never
  // overwrite the preview of a newer click.
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [preview, setPreview] = useState<ArtifactPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const previewSeq = useRef(0)

  const openPreview = useCallback(
    (path: string) => {
      setPreviewPath(path)
      setPreview(null)
      setPreviewError(null)
      const seq = ++previewSeq.current
      setPreviewLoading(true)
      window.pi.previewArtifact(path).then(
        (result) => {
          if (seq !== previewSeq.current) return
          setPreviewLoading(false)
          setPreview(result)
          setPreviewError(result === null ? t('artifact.notFound') : null)
        },
        () => {
          if (seq !== previewSeq.current) return
          setPreviewLoading(false)
          setPreviewError(t('artifact.loadFailed'))
        },
      )
    },
    [t],
  )

  const closePreview = useCallback(() => {
    previewSeq.current += 1
    setPreviewPath(null)
    setPreview(null)
    setPreviewError(null)
    setPreviewLoading(false)
  }, [])

  // Artifact chips in the conversation (tool calls, markdown links) open the
  // preview here; the App shell also opens the right panel on demand.
  useEffect(() => onArtifactPreview((path) => openPreview(path)), [openPreview])
  // A switched session may not even share the same workspace: drop the preview.
  useEffect(() => closePreview(), [closePreview, snapshot?.activeSessionPath])
  useEffect(() => {
    if (previewPath === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePreview()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [previewPath, closePreview])

  const previewing = previewPath !== null
  const previewName = previewPath !== null ? previewPath.split(/[\\/]/).pop() ?? previewPath : ''
  const previewKind: ArtifactKind | null = preview?.kind ?? null
  const previewUrl = preview?.url

  const openExternal = useCallback(async () => {
    if (previewPath === null) return
    try {
      await window.pi.openArtifactExternal(previewPath)
    } catch {
      /* best-effort */
    }
  }, [previewPath])

  const usage = snapshot?.usage
  // Total processing counts everything the provider reported — cache writes included.
  const usageTotal =
    (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0)
  const cost = usage?.cost ?? 0
  const costTooltip = cost === 0 ? t('rightPanel.costZero') : t('rightPanel.costFormula')
  const empty = patches.length === 0 && tools.length === 0 && usageTotal === 0 && artifacts.length === 0

  return (
    <div className="right-panel">
      {previewing ? (
        <>
          <div className="rp-header rp-preview-head">
            <button
              type="button"
              className="btn-icon rp-preview-back"
              onClick={closePreview}
              aria-label={t('artifact.back')}
              title={t('artifact.back')}
            >
              <ArrowLeft size={15} aria-hidden="true" />
            </button>
            <span className="rp-preview-title" title={previewName}>{previewName}</span>
            {previewKind !== null ? <span className={`artifact-kind-badge artifact-kind-${previewKind}`}>{t(KIND_LABEL_KEY[previewKind])}</span> : null}
          </div>
          <div className="rp-preview-actions">
            <button type="button" className="btn btn-sm" onClick={() => void openExternal()}>
              <ExternalLink size={12} aria-hidden="true" />
              {t('artifact.openExternal')}
            </button>
          </div>
          <div className="rp-preview-body" role="region" aria-label={t('artifact.previewAria', { name: previewName })}>
            {previewLoading ? (
              <div className="rp-preview-status">
                <LoaderCircle size={18} className="splash-spin" aria-hidden="true" />
                <span>{t('common.loading')}</span>
              </div>
            ) : previewError !== null ? (
              <div className="rp-preview-status rp-preview-error" role="alert">
                <span>{previewError}</span>
              </div>
            ) : preview === null ? null : previewKind === 'video' && previewUrl !== undefined ? (
              <video className="preview-video" controls preload="metadata" src={previewUrl} />
            ) : previewKind === 'pdf' && previewUrl !== undefined ? (
              <iframe className="preview-pdf" src={previewUrl} title={previewName} />
            ) : previewKind === 'text' ? (
              <>
                {preview.truncated === true ? (
                  <p className="preview-truncated">{t('artifact.truncated', { n: preview.content?.length ?? 0 })}</p>
                ) : null}
                <pre className="preview-text">{preview.content ?? ''}</pre>
              </>
            ) : (
              <div className="rp-preview-status">
                <ArtifactIcon kind={preview.kind} />
                <span>{t('artifact.binaryHint')}</span>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="rp-header">
            <Layers size={14} aria-hidden="true" />
            <span>{t('rightPanel.activity')}</span>
          </div>
          <div className="rp-scroll">
            {empty ? (
              <div className="rp-empty">
                <Layers size={22} strokeWidth={1.4} aria-hidden="true" />
                <p>{t('rightPanel.noActivity')}</p>
                <p className="rp-empty-sub">{t('rightPanel.noActivitySub')}</p>
              </div>
            ) : (
              <>
                {artifacts.length > 0 ? (
                  <Section
                    title={t('rightPanel.artifacts')}
                    icon={<FileCode size={13} aria-hidden="true" />}
                    count={artifacts.length}
                    defaultOpen
                  >
                    <div className="artifact-list">
                      {artifacts.map((artifact) => (
                        <button
                          key={artifact.path}
                          type="button"
                          className="artifact-item"
                          onClick={() => openPreview(artifact.path)}
                          title={artifact.path}
                        >
                          <ArtifactIcon kind={artifact.kind} />
                          <span className="artifact-item-name">{artifact.name}</span>
                          <span className="artifact-item-kind">{t(KIND_LABEL_KEY[artifact.kind])}</span>
                        </button>
                      ))}
                    </div>
                  </Section>
                ) : null}
                {patches.length > 0 ? (
                  <Section title={t('rightPanel.patches')} icon={<FileCode size={13} aria-hidden="true" />} count={patches.length} defaultOpen>
                    {patches.map((p) => (
                      <PatchCard key={p.id} file={p.file} />
                    ))}
                  </Section>
                ) : null}
                {tools.length > 0 ? (
                  <Section title={t('rightPanel.tools')} icon={<Terminal size={13} aria-hidden="true" />} count={activeTools} defaultOpen>
                    {tools.map((tool) => (
                      <ToolCall key={tool.id} tool={tool} />
                    ))}
                  </Section>
                ) : null}
                {usageTotal > 0 ? (
                  <Section title={t('rightPanel.usage')} icon={<Layers size={13} aria-hidden="true" />} count={0} defaultOpen>
                    <div className="usage-grid">
                      <span className="usage-label">{t('rightPanel.inputTokens')}</span>
                      <span className="usage-value">{formatTokens(usage?.input ?? 0)}</span>
                      <span className="usage-label">{t('rightPanel.outputTokens')}</span>
                      <span className="usage-value">{formatTokens(usage?.output ?? 0)}</span>
                      <span className="usage-label">{t('rightPanel.cacheRead')}</span>
                      <span className="usage-value">{formatTokens(usage?.cacheRead ?? 0)}</span>
                      <span className="usage-label">{t('rightPanel.cacheWrite')}</span>
                      <span className="usage-value">{formatTokens(usage?.cacheWrite ?? 0)}</span>
                      <span className="usage-label" title={costTooltip}>
                        {t('rightPanel.cost')}
                      </span>
                      <span className="usage-value" title={costTooltip}>
                        {formatCost(cost)}
                      </span>
                      <span className="usage-label usage-total" title={t('rightPanel.totalTitle')}>
                        {t('rightPanel.total')}
                      </span>
                      <span className="usage-value usage-total">{formatTokens(usageTotal)} tokens</span>
                    </div>
                  </Section>
                ) : null}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}