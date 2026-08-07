import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import type { AppSnapshot } from '../../src/shared/contracts'

/**
 * Component-level conditional-rendering tests: the three drag strips and the
 * platform root marker are driven by the preload contract
 * (window.desktop.platform), so they can be exercised headlessly with
 * react-dom/server — no Electron, no browser needed.
 */

const FAKE_SNAPSHOT: AppSnapshot = {
  workspace: { path: '/tmp/workspace', name: 'workspace' },
  activeSessionPath: '/tmp/workspace/session.jsonl',
  sessions: [],
  groups: [],
  models: [],
  activeModel: null,
  thinkingLevel: 'off',
  toolApprovalMode: 'ask',
  messages: [],
  runState: 'idle',
  statusText: 'Ready',
  queueCount: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  telemetry: {
    tokenRate: null, tokenRateKind: 'unavailable', ttftMs: null, cacheHitRate: null,
    input: 0, cacheRead: 0, cacheWrite: 0,
    contextTokens: null, contextWindow: null, contextPercent: null,
    contextEstimated: false, latestOutputTokens: null,
  },
  error: null,
}

vi.mock('../../src/renderer/src/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/hooks')>()
  return {
    ...actual,
    // Deterministic shell state: workspace present, no models, no messages.
    useSnapshot: () => ({ snapshot: FAKE_SNAPSHOT, loadError: null }),
    useMediaQuery: () => false,
  }
})

function stubWindow(platform: string): void {
  vi.stubGlobal('window', {
    desktop: { platform },
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    removeEventListener: () => {},
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('window shell conditional rendering', () => {
  it.each([
    { platform: 'darwin', strips: 3, darwinClass: true },
    { platform: 'win32', strips: 0, darwinClass: false },
    { platform: 'linux', strips: 0, darwinClass: false },
    { platform: 'other', strips: 0, darwinClass: false },
  ])(
    '$platform renders $strips drag strip(s) and the $platform root marker',
    async ({ platform, strips, darwinClass }) => {
      stubWindow(platform)
      vi.resetModules()
      const { default: App } = await import('../../src/renderer/src/App')
      const html = renderToString(<App />)

      const stripCount = (html.match(/class="drag-strip"/g) ?? []).length
      expect(stripCount).toBe(strips)

      expect(html).toContain(`data-platform="${platform}"`)
      expect(html.includes('platform-darwin')).toBe(darwinClass)

      // The rest of the shell (sidebar / topbar / composer) still renders.
      expect(html).toContain('sidebar')
      expect(html).toContain('topbar')
      expect(html).toContain('composer')
    },
  )

  it('falls back to "other" when the preload contract is absent', async () => {
    stubWindow(undefined as unknown as string)
    vi.resetModules()
    const { default: App } = await import('../../src/renderer/src/App')
    const html = renderToString(<App />)
    expect(html).toContain('data-platform="other"')
    expect(html).not.toContain('drag-strip')
    expect(html).not.toContain('platform-darwin')
  })
})
