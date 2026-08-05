import { useEffect, useState } from 'react'
import type { AppSnapshot } from '@shared/contracts'

export interface SnapshotState {
  snapshot: AppSnapshot | null
  loadError: string | null
}

export function useSnapshot(): SnapshotState {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.pi
      .getSnapshot()
      .then((s) => {
        if (alive) {
          setSnapshot(s)
          setLoadError(null)
        }
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e))
      })
    const unsubscribe = window.pi.onSnapshot((s) => setSnapshot(s))
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  return { snapshot, loadError }
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent): void => setMatches(e.matches)
    setMatches(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])

  return matches
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return '未知错误'
}
