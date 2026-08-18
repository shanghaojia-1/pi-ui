import { useEffect } from 'react'

/**
 * Renderer-side bridge for the artifact preview feature. Tool-call chips and
 * markdown artifact links are rendered deep inside memoized message cards, so
 * opening a preview must not require prop drilling through every memoized
 * component. The RightPanel subscribes to preview requests; the App shell
 * subscribes to panel-open requests so clicking an artifact while the right
 * panel is collapsed still shows the preview.
 */

type PreviewListener = (path: string) => void
type OpenListener = () => void

const previewListeners = new Set<PreviewListener>()
const openListeners = new Set<OpenListener>()

/** Opens the preview for an artifact path and makes sure the right panel is visible. */
export function openArtifactPreview(path: string): void {
  openListeners.forEach((listener) => listener())
  previewListeners.forEach((listener) => listener(path))
}

/** Subscribes to artifact-preview requests; returns the unsubscribe function. */
export function onArtifactPreview(listener: PreviewListener): () => void {
  previewListeners.add(listener)
  return () => previewListeners.delete(listener)
}

/** Subscribes to "make the right panel visible" requests; returns the unsubscribe function. */
export function onRightPanelRequest(listener: OpenListener): () => void {
  openListeners.add(listener)
  return () => openListeners.delete(listener)
}

/** React hook: run `onPreview` for every preview request while mounted. */
export function useArtifactPreview(onPreview: (path: string) => void): void {
  useEffect(() => onArtifactPreview(onPreview), [onPreview])
}