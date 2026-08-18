import { FileText, FileVideo, FileType2, File } from 'lucide-react'
import type { ArtifactFile, ArtifactKind } from '@shared/contracts'
import { useI18n } from '../lib/i18n'
import { openArtifactPreview } from '../lib/artifacts'

/**
 * Clickable blue artifact links for one tool result: the files the agent
 * produced (documents / videos). Clicking opens the sidebar preview.
 */
export default function ArtifactChips({ artifacts }: { artifacts: ArtifactFile[] | undefined }) {
  const { t } = useI18n()
  if (!artifacts || artifacts.length === 0) return null
  return (
    <div className="artifact-chips" role="group" aria-label={t('artifact.groupAria')}>
      {artifacts.map((artifact) => (
        <button
          key={artifact.path}
          type="button"
          className="artifact-chip"
          onClick={() => openArtifactPreview(artifact.path)}
          aria-label={t('artifact.previewAria', { name: artifact.name })}
          title={artifact.path}
        >
          <ArtifactIcon kind={artifact.kind} />
          <span>{artifact.name}</span>
        </button>
      ))}
    </div>
  )
}

function ArtifactIcon({ kind }: { kind: ArtifactKind }) {
  if (kind === 'video') return <FileVideo size={12} className="artifact-chip-icon" aria-hidden="true" />
  if (kind === 'pdf') return <FileType2 size={12} className="artifact-chip-icon" aria-hidden="true" />
  if (kind === 'binary') return <File size={12} className="artifact-chip-icon" aria-hidden="true" />
  return <FileText size={12} className="artifact-chip-icon" aria-hidden="true" />
}

export { ArtifactIcon }