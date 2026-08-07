import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import type { AppSnapshot } from '../../src/shared/contracts'
import RightPanel from '../../src/renderer/src/components/RightPanel'
import { I18nProvider } from '../../src/renderer/src/lib/i18n'

const base: AppSnapshot = {
  workspace: { path: '/tmp/ws', name: 'ws' },
  activeSessionPath: null,
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

/**
 * RightPanel dedupes by the unique UI instance id emitted by the runtime
 * (first occurrence = raw id, later reuses = rawId::ordinal-contentIndex), so
 * every occurrence of a reused raw toolCallId must render its own card, while
 * the same instance id serialized twice still collapses to one card.
 */
describe('RightPanel tool dedupe by unique instance id', () => {
  it('shows every occurrence of a reused raw toolCallId and counts only pending/running as active', () => {
    const snapshot: AppSnapshot = {
      ...base,
      messages: [
        { id: 'assistant-0-1', role: 'assistant', blocks: [{ type: 'tool', id: 'call-1', name: 'edit', status: 'error', input: 'x', output: 'boom' }] },
        {
          id: 'assistant-1-2', role: 'assistant',
          blocks: [
            { type: 'tool', id: 'call-1::1-0', name: 'edit', status: 'success', input: 'x', output: 'fixed' },
            { type: 'tool', id: 'call-2', name: 'bash', status: 'running', input: 'ls' },
          ],
        },
        { id: 'assistant-2-3', role: 'assistant', blocks: [{ type: 'tool', id: 'call-2::2-0', name: 'bash', status: 'interrupted', input: 'ls' }] },
      ],
    }
    const html = renderToString(<I18nProvider initialLang="zh"><RightPanel snapshot={snapshot} /></I18nProvider>)
    // Four distinct occurrences of three tool names: none swallowed.
    expect(html.match(/toolcall-head/g)).toHaveLength(4)
    expect(html).toContain('aria-label="edit — 失败"')
    expect(html).toContain('aria-label="edit — 成功"')
    expect(html).toContain('aria-label="bash — 运行中"')
    expect(html).toContain('aria-label="bash — 已中断"')
    // The section badge counts only in-flight tools (call-2 running → 1).
    expect(html).toContain('<span class="rp-count">1</span>')
  })

  it('shows two same-rawId live occurrences as two cards and counts both as active', () => {
    const snapshot: AppSnapshot = {
      ...base,
      messages: [
        {
          id: 'assistant-0-1', role: 'assistant',
          blocks: [
            { type: 'tool', id: 'call-1', name: 'edit', status: 'running', input: 'a.txt' },
            { type: 'tool', id: 'call-1::0-1', name: 'edit', status: 'running', input: 'b.txt' },
          ],
        },
      ],
    }
    const html = renderToString(<I18nProvider initialLang="zh"><RightPanel snapshot={snapshot} /></I18nProvider>)
    // Two distinct occurrences of the reused raw id: each renders its own card.
    expect(html.match(/toolcall-head/g)).toHaveLength(2)
    expect(html.match(/aria-label="edit — 运行中"/g)).toHaveLength(2)
    // The badge counts both in-flight cards, not the raw id.
    expect(html).toContain('<span class="rp-count">2</span>')
  })

  it('still collapses the same instance id serialized twice (assistant card + orphan card)', () => {
    const snapshot: AppSnapshot = {
      ...base,
      messages: [
        { id: 'assistant-0-1', role: 'assistant', blocks: [{ type: 'tool', id: 'call-1', name: 'edit', status: 'success', input: 'x', output: 'ok' }] },
        { id: 'tool-call-1', role: 'tool', blocks: [{ type: 'tool', id: 'call-1', name: 'edit', status: 'success', input: 'x', output: 'ok' }] },
      ],
    }
    const html = renderToString(<I18nProvider initialLang="zh"><RightPanel snapshot={snapshot} /></I18nProvider>)
    expect(html.match(/toolcall-head/g)).toHaveLength(1)
  })

  it('usage section lists cache write and totals input+output+cacheRead+cacheWrite as 总处理', () => {
    const snapshot: AppSnapshot = {
      ...base,
      usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 50, cost: 0 },
    }
    const html = renderToString(<I18nProvider initialLang="zh"><RightPanel snapshot={snapshot} /></I18nProvider>)
    const stripped = html.replace(/<!-- -->/g, '')
    expect(stripped).toContain('缓存写入')
    expect(stripped).toContain('总处理')
    expect(stripped).toContain('1.8k tokens') // 1000 + 500 + 200 + 50
    // scope tooltips: total formula and cost-not-reported caveat
    expect(stripped).toContain('title="总处理 = 输入 + 输出 + 缓存读取 + 缓存写入"')
    expect(stripped).toContain('title="成本为 0：provider 未报告价格时可能显示为 0，不代表免费"')
  })

  it('usage section stays empty when all counters are zero', () => {
    const html = renderToString(<I18nProvider initialLang="zh"><RightPanel snapshot={base} /></I18nProvider>)
    expect(html).toContain('暂无活动')
    expect(html).not.toContain('总处理')
  })
})
