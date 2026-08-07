/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AppSnapshot } from '../../src/shared/contracts'
import TopBar from '../../src/renderer/src/components/TopBar'
import { I18nProvider } from '../../src/renderer/src/lib/i18n'
import { type ReactElement } from 'react'

function renderI18n(ui: ReactElement) {
  return render(<I18nProvider initialLang="zh">{ui}</I18nProvider>)
}

const base: AppSnapshot = {
  workspace: { path: '/tmp/ws', name: 'ws' },
  activeSessionPath: null,
  sessions: [],
  groups: [],
  models: [
    { provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet', contextWindow: 200_000 },
  ],
  activeModel: 'anthropic:claude-sonnet',
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

const onOpenApproval = vi.fn()

function renderTopBar(snapshot: AppSnapshot | null): void {
  render(
    <I18nProvider initialLang="zh">
      <TopBar
        snapshot={snapshot}
        sidebarOpen
        rightOpen
        onToggleSidebar={() => {}}
        onToggleRight={() => {}}
        onSetModel={() => {}}
        onSetThinking={() => {}}
        onOpenApproval={onOpenApproval}
      />
    </I18nProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TopBar tool-approval badge', () => {
  it('ask mode: neutral shield badge labeled 逐次确认 with click-through aria', () => {
    renderTopBar({ ...base, toolApprovalMode: 'ask' })
    const badge = screen.getByRole('button', { name: /工具审批/ })
    expect(badge.className).toContain('approval-badge-ask')
    expect(badge.className).not.toContain('approval-badge-managed')
    expect(badge.textContent).toContain('逐次确认')
    expect(badge.getAttribute('aria-label')).toContain('逐次确认')
    expect(badge.getAttribute('title')).toContain('逐次确认')
    expect(badge.querySelector('.approval-icon')).toBeTruthy()
    // neutral shield, not the alert variant
    expect(badge.querySelector('.approval-icon')?.getAttribute('class')).toContain('lucide-shield')
  })

  it('managed mode: high-contrast badge labeled 全托管 · 非沙箱 with alert shield icon', () => {
    renderTopBar({ ...base, toolApprovalMode: 'managed' })
    const badge = screen.getByRole('button', { name: /工具审批/ })
    expect(badge.className).toContain('approval-badge-managed')
    expect(badge.textContent).toContain('全托管 · 非沙箱')
    expect(badge.getAttribute('aria-label')).toContain('全托管')
    expect(badge.getAttribute('aria-label')).toContain('非沙箱')
    expect(badge.querySelector('.approval-icon')?.getAttribute('class')).toContain('lucide-shield-alert')
    expect(badge.textContent).not.toContain('逐次确认')
  })

  it('is a real button: click opens the settings sheet on the approval section', () => {
    renderTopBar(base)
    fireEvent.click(screen.getByRole('button', { name: /工具审批/ }))
    expect(onOpenApproval).toHaveBeenCalledTimes(1)
  })

  it('falls back to ask when the snapshot is null (loading)', () => {
    renderTopBar(null)
    const badge = screen.getByRole('button', { name: /工具审批/ })
    expect(badge.className).toContain('approval-badge-ask')
    expect(badge.textContent).toContain('逐次确认')
  })

  it('badge state follows the snapshot immediately (ask → managed → ask)', () => {
    const { rerender } = render(
      <I18nProvider initialLang="zh">
      <TopBar
        snapshot={{ ...base, toolApprovalMode: 'ask' }}
        sidebarOpen
        rightOpen
        onToggleSidebar={() => {}}
        onToggleRight={() => {}}
        onSetModel={() => {}}
        onSetThinking={() => {}}
        onOpenApproval={onOpenApproval}
      />
      </I18nProvider>,
    )
    expect(screen.getByRole('button', { name: /工具审批/ }).className).toContain('approval-badge-ask')
    rerender(
      <I18nProvider initialLang="zh">
        <TopBar
          snapshot={{ ...base, toolApprovalMode: 'managed' }}
          sidebarOpen
          rightOpen
          onToggleSidebar={() => {}}
          onToggleRight={() => {}}
          onSetModel={() => {}}
          onSetThinking={() => {}}
          onOpenApproval={onOpenApproval}
        />
      </I18nProvider>,
    )
    expect(screen.getByRole('button', { name: /工具审批/ }).className).toContain('approval-badge-managed')
    rerender(
      <I18nProvider initialLang="zh">
        <TopBar
          snapshot={{ ...base, toolApprovalMode: 'ask' }}
          sidebarOpen
          rightOpen
          onToggleSidebar={() => {}}
          onToggleRight={() => {}}
          onSetModel={() => {}}
          onSetThinking={() => {}}
          onOpenApproval={onOpenApproval}
        />
      </I18nProvider>,
    )
    expect(screen.getByRole('button', { name: /工具审批/ }).className).toContain('approval-badge-ask')
  })

  it('reduced-motion guard: the pulse animation targets only the icon and is disabled for reduced motion', () => {
    const css = readFileSync(join(import.meta.dirname, '../../src/renderer/src/styles.css'), 'utf8')
    // pulse is scoped to the managed icon, never the whole badge
    expect(css).toMatch(/\.approval-badge-managed \.approval-icon\s*{[\s\S]*?animation: pulse/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.approval-badge-managed \.approval-icon\s*{[\s\S]*?animation: none/)
    // the ask badge block never carries an animation itself
    expect(css).not.toMatch(/\.approval-badge-ask \[^}]*animation:/)
  })

  it('narrow screens keep the icon and the accessible label, hiding only the text', () => {
    const css = readFileSync(join(import.meta.dirname, '../../src/renderer/src/styles.css'), 'utf8')
    expect(css).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.approval-label\s*{[\s\S]*?display: none/)
    renderTopBar({ ...base, toolApprovalMode: 'managed' })
    // the text label is inside its own span so CSS can hide it without
    // touching the icon or the button's aria-label
    expect(screen.getByRole('button', { name: /工具审批/ }).querySelector('.approval-label')).toBeTruthy()
  })
})
