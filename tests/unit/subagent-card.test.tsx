/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SubagentDetails, ToolBlock } from '../../src/shared/contracts'
import ToolCall from '../../src/renderer/src/components/ToolCall'
import { I18nProvider } from '../../src/renderer/src/lib/i18n'

const LEGACY_DETAILS: SubagentDetails = {
  mode: 'single',
  agentScope: 'user',
  projectAgentsDir: null,
  results: [{
    agent: 'scout', agentSource: 'user', task: 'find auth', exitCode: 0, model: 'claude-haiku',
    usage: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 0, cost: 0.0012, contextTokens: 2000, turns: 2 },
    messages: [{ role: 'assistant', content: [
      { type: 'toolCall', id: 'c1', name: 'grep', arguments: { pattern: 'auth' } },
      { type: 'text', text: 'Found auth in src/auth.ts' },
    ] }],
  }],
}

const LIVE_DETAILS: SubagentDetails = {
  version: 2,
  runId: 'run-1',
  mode: 'parallel',
  agentScope: 'user',
  projectAgentsDir: null,
  total: 3,
  maxConcurrency: 2,
  results: [
    {
      id: 'run-1:0', agent: 'scout', task: 'map models', status: 'running_tool', exitCode: -1,
      liveText: 'Inspecting the model registry', messages: [],
      events: [{
        id: 'tool-1', kind: 'tool', status: 'running', label: 'Running grep', timestamp: 1,
        toolName: 'grep', args: '{"pattern":"model"}', output: 'src/models.ts',
      }],
    },
    { id: 'run-1:1', agent: 'reviewer', task: 'review auth', status: 'queued', exitCode: -1, messages: [], events: [] },
    { id: 'run-1:2', agent: 'worker', task: 'fix tests', status: 'completed', exitCode: 0, output: 'Tests fixed.', messages: [], events: [] },
  ],
}

function renderCard(over: Partial<ToolBlock> = {}, details: SubagentDetails = LEGACY_DETAILS): void {
  const tool: ToolBlock = {
    type: 'tool', id: 't1', name: 'subagent', status: 'success', input: '', output: '', details, ...over,
  }
  render(<I18nProvider initialLang="zh"><ToolCall tool={tool} /></I18nProvider>)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SubagentCard', () => {
  it('renders and expands legacy persisted results', () => {
    renderCard()
    expect(screen.getByText('子代理')).toBeTruthy()
    expect(screen.getByText('1/1 完成')).toBeTruthy()
    fireEvent.click(screen.getByText('subagent'))
    fireEvent.click(screen.getByText('scout'))
    expect(screen.getByText('find auth')).toBeTruthy()
    expect(screen.getByText('grep')).toBeTruthy()
    expect(screen.getByText('Found auth in src/auth.ts')).toBeTruthy()
  })

  it('shows queued/running/completed counts from the version 2 protocol', () => {
    renderCard({ status: 'running' }, LIVE_DETAILS)
    expect(screen.getByText('1/3 完成 · 1 运行 · 1 排队')).toBeTruthy()
    expect(screen.getByText('运行工具')).toBeTruthy()
    expect(screen.getByText('排队中')).toBeTruthy()
    expect(screen.getByText('完成')).toBeTruthy()
  })

  it('auto-expands live tasks and exposes tool activity plus partial output', () => {
    renderCard({ status: 'running' }, LIVE_DETAILS)
    expect(screen.getByText('实时过程')).toBeTruthy()
    expect(screen.getByText('Running grep')).toBeTruthy()
    expect(screen.getByText('{"pattern":"model"}')).toBeTruthy()
    expect(screen.getByText('src/models.ts')).toBeTruthy()
    expect(screen.getByText('Inspecting the model registry')).toBeTruthy()
  })

  it('stops the parent run from the live card', () => {
    const abort = vi.fn().mockResolvedValue(undefined)
    const cancelSubagent = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'pi', { configurable: true, value: { abort, cancelSubagent } })
    renderCard({ status: 'running' }, LIVE_DETAILS)
    fireEvent.click(screen.getByRole('button', { name: '停止此子代理' }))
    expect(cancelSubagent).toHaveBeenCalledWith('run-1:0')
    fireEvent.click(screen.getByRole('button', { name: '停止全部子代理' }))
    expect(abort).toHaveBeenCalledOnce()
  })

  it('renders chain steps using the declared total', () => {
    renderCard({ status: 'running' }, {
      ...LIVE_DETAILS,
      mode: 'chain',
      total: 2,
      results: [
        { id: 'a', agent: 'scout', task: 'recon', step: 1, status: 'completed', exitCode: 0, messages: [] },
        { id: 'b', agent: 'planner', task: 'plan', step: 2, status: 'thinking', exitCode: -1, messages: [] },
      ],
    })
    expect(screen.getByText('链式 · 2 步')).toBeTruthy()
    expect(screen.getByText('1/2 完成 · 1 运行 · 0 排队')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('falls back to a generic completed tool card when details are malformed', () => {
    const tool: ToolBlock = { type: 'tool', id: 'bad', name: 'subagent', status: 'success', input: '{}', output: 'plain', details: { mode: 'single' } }
    render(<I18nProvider initialLang="zh"><ToolCall tool={tool} /></I18nProvider>)
    expect(document.querySelector('.subagent-card')).toBeNull()
    fireEvent.click(screen.getByText('subagent'))
    expect(screen.getByText('plain')).toBeTruthy()
  })

  it('shows a startup placeholder before the first structured update', () => {
    renderCard({ status: 'running', details: undefined })
    expect(screen.getByText('正在启动子代理…')).toBeTruthy()
  })
})
