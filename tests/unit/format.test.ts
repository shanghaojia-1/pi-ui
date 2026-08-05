import { describe, expect, it } from 'vitest'
import {
  formatCost,
  formatDuration,
  formatTime,
  formatTokens,
  parsePatch,
  sessionGroup,
  type DiffLine,
} from '../../src/renderer/src/lib/format'

describe('formatDuration', () => {
  it('returns empty string for missing values', () => {
    expect(formatDuration(undefined)).toBe('')
    expect(formatDuration(null as never)).toBe('')
  })

  it('formats sub-second durations in ms', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(1)).toBe('1ms')
    expect(formatDuration(999)).toBe('999ms')
  })

  it('formats seconds with one decimal', () => {
    expect(formatDuration(1000)).toBe('1.0s')
    expect(formatDuration(1234)).toBe('1.2s')
    expect(formatDuration(59_000)).toBe('59.0s')
  })

  it('formats minutes and seconds', () => {
    expect(formatDuration(60_000)).toBe('1m 0s')
    expect(formatDuration(61_000)).toBe('1m 1s')
    expect(formatDuration(90_061)).toBe('1m 30s')
    expect(formatDuration(3_600_000)).toBe('60m 0s')
  })
})

describe('formatTokens', () => {
  it('formats small counts verbatim', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('rounds thousands to one decimal k', () => {
    expect(formatTokens(1000)).toBe('1.0k')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(12_300)).toBe('12.3k')
    expect(formatTokens(999_999)).toBe('1000.0k')
  })

  it('rounds millions to one decimal M', () => {
    expect(formatTokens(1_000_000)).toBe('1.0M')
    expect(formatTokens(2_500_000)).toBe('2.5M')
  })
})

describe('formatCost', () => {
  it('formats zero explicitly', () => {
    expect(formatCost(0)).toBe('$0.0000')
  })

  it('uses four decimals below $1', () => {
    expect(formatCost(0.0001)).toBe('$0.0001')
    expect(formatCost(0.9999)).toBe('$0.9999')
    // sub-0.00005 rounds to four-zero display
    expect(formatCost(0.00001)).toBe('$0.0000')
  })

  it('uses two decimals at and above $1', () => {
    expect(formatCost(1)).toBe('$1.00')
    expect(formatCost(1.006)).toBe('$1.01')
    expect(formatCost(12.345)).toBe('$12.35')
  })
})

describe('formatTime', () => {
  it('returns empty string for invalid input', () => {
    expect(formatTime('not-a-date')).toBe('')
    expect(formatTime('')).toBe('')
  })

  it('formats today as HH:MM', () => {
    expect(formatTime(new Date().toISOString())).toMatch(/^\d{2}:\d{2}$/)
  })

  it('labels yesterday', () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    expect(formatTime(yesterday.toISOString())).toBe('昨天')
  })

  it('formats older dates as M/D', () => {
    const old = new Date()
    old.setDate(old.getDate() - 10)
    expect(formatTime(old.toISOString())).toMatch(/^\d{1,2}\/\d{1,2}$/)
  })
})

describe('sessionGroup', () => {
  it('groups by today / yesterday / earlier', () => {
    expect(sessionGroup(new Date().toISOString())).toBe('today')
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    expect(sessionGroup(yesterday.toISOString())).toBe('yesterday')
    const old = new Date()
    old.setDate(old.getDate() - 10)
    expect(sessionGroup(old.toISOString())).toBe('earlier')
  })

  it('treats invalid dates as earlier', () => {
    expect(sessionGroup('garbage')).toBe('earlier')
    expect(sessionGroup('')).toBe('earlier')
  })
})

describe('parsePatch', () => {
  it('parses a standard multi-file diff', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 123..456 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      '-old line',
      '+new line',
      ' unchanged',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -5 +5 @@',
      '-x',
      '+y',
    ].join('\n')
    const files = parsePatch(patch)
    expect(files).toHaveLength(2)

    const [a, b] = files
    expect(a?.name).toBe('src/a.ts')
    expect(a?.adds).toBe(1)
    expect(a?.dels).toBe(1)
    expect(a?.lines.map((l: DiffLine) => `${l.kind}:${l.text}`)).toEqual([
      'ctx:index 123..456 100644',
      'ctx:@@ -1,3 +1,4 @@',
      'del:-old line',
      'add:+new line',
      'ctx: unchanged',
    ])

    expect(b?.name).toBe('src/b.ts')
    expect(b?.adds).toBe(1)
    expect(b?.dels).toBe(1)
    expect(b?.lines.map((l: DiffLine) => l.kind)).toEqual(['ctx', 'del', 'add'])
  })

  it('falls back to a single diff file for header-less patches', () => {
    const files = parsePatch('some context\n+added\n-removed')
    expect(files).toHaveLength(1)
    const file = files[0]
    expect(file?.name).toBe('diff')
    expect(file?.adds).toBe(1)
    expect(file?.dels).toBe(1)
    expect(file?.lines.map((l: DiffLine) => l.kind)).toEqual(['ctx', 'add', 'del'])
  })

  it('returns an empty list for an empty patch', () => {
    expect(parsePatch('')).toEqual([])
    expect(parsePatch('\n\n')).toEqual([])
  })

  it('strips CRLF line endings', () => {
    const files = parsePatch('diff --git a/f.ts b/f.ts\r\n--- a/f.ts\r\n+++ b/f.ts\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n')
    expect(files).toHaveLength(1)
    expect(files[0]?.name).toBe('f.ts')
    expect(files[0]?.lines[1]?.text).toBe('-old')
  })
})
