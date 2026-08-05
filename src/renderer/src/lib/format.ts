export function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function formatCost(cost: number): string {
  if (cost === 0) return '$0.0000'
  if (cost >= 1) return `$${cost.toFixed(2)}`
  return `$${cost.toFixed(4)}`
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return hm
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export type SessionGroup = 'today' | 'yesterday' | 'earlier'

export function sessionGroup(iso: string): SessionGroup {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'earlier'
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return 'today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'yesterday'
  return 'earlier'
}

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
}

export interface DiffFile {
  name: string
  adds: number
  dels: number
  lines: DiffLine[]
}

export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  for (const raw of patch.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('diff --git')) {
      const nameMatch = line.match(/^diff --git a\/(.+?) b\/(.*)$/)
      const g1 = nameMatch?.[1]
      const g2 = nameMatch?.[2]
      current = {
        name: g2 !== undefined && g2 !== '' ? g2 : (g1 ?? 'diff'),
        adds: 0,
        dels: 0,
        lines: [],
      }
      files.push(current)
      continue
    }
    if (!current) {
      if (line.trim() === '') continue
      current = { name: 'diff', adds: 0, dels: 0, lines: [] }
      files.push(current)
    }
    if (current === null) continue
    if (line.startsWith('+++ b/')) {
      current.name = line.slice(6)
      continue
    }
    if (line.startsWith('--- ')) continue
    if (line.startsWith('@@')) {
      current.lines.push({ kind: 'ctx', text: line })
      continue
    }
    if (line.startsWith('+')) {
      current.adds += 1
      current.lines.push({ kind: 'add', text: line })
      continue
    }
    if (line.startsWith('-')) {
      current.dels += 1
      current.lines.push({ kind: 'del', text: line })
      continue
    }
    current.lines.push({ kind: 'ctx', text: line })
  }
  return files
}
