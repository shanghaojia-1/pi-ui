/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AppSnapshot, SessionGroup, SessionListItem } from '../../src/shared/contracts'
import Sidebar from '../../src/renderer/src/components/Sidebar'
import { I18nProvider } from '../../src/renderer/src/lib/i18n'

const session = (id: string, title: string, preview: string, modifiedAt: string, groupId: string | null = null): SessionListItem => ({
  id,
  path: `/sessions/${id}.jsonl`,
  title,
  preview,
  workspace: { path: '/ws', name: 'ws' },
  messageCount: 3,
  modifiedAt,
  groupId,
})

const snapshot = (sessions: SessionListItem[], groups: SessionGroup[] = []): AppSnapshot => ({
  workspace: { path: '/ws', name: 'ws' },
  activeSessionPath: sessions[0]?.path ?? null,
  sessions,
  groups,
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
})

function renderSidebar(snap: AppSnapshot | null, over: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const props = {
    snapshot: snap,
    busy: false,
    onOpenDir: vi.fn(),
    onNewSession: vi.fn(),
    onOpenSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onOpenSettings: vi.fn(),
    ...over,
  }
  const utils = render(
    <I18nProvider initialLang="zh">
      <Sidebar {...props} />
    </I18nProvider>,
  )
  return { ...utils, props }
}

beforeEach(() => {
  vi.useRealTimers()
  Object.defineProperty(window, 'pi', {
    configurable: true,
    value: {
      createSessionGroup: vi.fn(async () => snapshot([])),
      deleteSessionGroup: vi.fn(async () => snapshot([])),
      moveSessionToGroup: vi.fn(async () => snapshot([])),
      newSession: vi.fn(async () => snapshot([])),
      openWorkspace: vi.fn(async () => snapshot([])),
      pickDirectory: vi.fn(async () => null),
      renameSessionGroup: vi.fn(async () => snapshot([])),
      updateSessionGroup: vi.fn(async () => snapshot([])),
    } as unknown as Window['pi'],
  })
})
afterEach(cleanup)

describe('Sidebar', () => {
  it('shows the first-task CTA when a workspace is open and there are no sessions', () => {
    const { props } = renderSidebar(snapshot([]))
    expect(screen.getByText('开始第一个任务')).toBeTruthy()
    fireEvent.click(screen.getByText('开始第一个任务'))
    expect(props.onNewSession).toHaveBeenCalledTimes(1)
    // The kbd hint spans multiple elements; assert on the container text.
    const hint = document.querySelector('.sidebar-empty-hint')
    expect(hint?.textContent).toMatch(/或按 .*N 新建/)
  })

  it('shows the open-folder hint when no workspace is open', () => {
    renderSidebar(null)
    expect(screen.getByText('打开目录后显示会话')).toBeTruthy()
    expect(screen.queryByText('开始第一个任务')).toBeNull()
  })

  it('filters sessions by title and preview, with a clear button', () => {
    const sessions = [
      session('a', 'Auth refactor', 'fixing login flow', '2026-08-07T10:00:00Z'),
      session('b', 'Sidebar polish', 'search and empty states', '2026-08-07T09:00:00Z'),
    ]
    renderSidebar(snapshot(sessions))
    const input = screen.getByLabelText('搜索会话')
    fireEvent.change(input, { target: { value: 'auth' } })
    expect(screen.getByText('Auth refactor')).toBeTruthy()
    expect(screen.queryByText('Sidebar polish')).toBeNull()
    expect(screen.getByText('1 个匹配')).toBeTruthy()

    fireEvent.change(input, { target: { value: 'search' } })
    expect(screen.getByText('Sidebar polish')).toBeTruthy()
    expect(screen.queryByText('Auth refactor')).toBeNull()

    // Clear restores the full list.
    fireEvent.click(screen.getByLabelText('清除搜索'))
    expect(screen.getByText('Auth refactor')).toBeTruthy()
    expect(screen.getByText('Sidebar polish')).toBeTruthy()
    expect((input as HTMLInputElement).value).toBe('')
  })

  it('shows each search result group source', () => {
    const groups: SessionGroup[] = [{ id: 'g1', name: '前端项目', dirs: ['/ws'] }]
    renderSidebar(snapshot([
      session('a', '导航修复', '分组内容', '2026-08-07T10:00:00Z', 'g1'),
      session('b', '文档整理', '未分组内容', '2026-08-07T09:00:00Z'),
    ], groups))

    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: '内容' } })
    expect(screen.getByText('前端项目')).toBeTruthy()
    expect(screen.getByText('未分组')).toBeTruthy()
  })

  it('shows a no-match state for an empty search result', () => {
    renderSidebar(snapshot([session('a', 'Auth refactor', 'fixing login', '2026-08-07T10:00:00Z')]))
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'zzz' } })
    expect(screen.getByText('没有匹配的会话')).toBeTruthy()
    expect(screen.queryByText('Auth refactor')).toBeNull()
  })

  it('hides the search box when no workspace is open', () => {
    renderSidebar(null)
    expect(screen.queryByLabelText('搜索会话')).toBeNull()
  })

  it('delete confirmation auto-resets after 2 seconds', () => {
    vi.useFakeTimers()
    const sessions = [session('a', 'Auth refactor', 'fixing login', '2026-08-07T10:00:00Z')]
    renderSidebar(snapshot(sessions))
    const del = screen.getByLabelText(/删除会话/) as HTMLButtonElement
    fireEvent.click(del)
    expect(del.className).toContain('session-delete-confirm')
    // Re-arm and let the timer expire: confirmation must reset.
    act(() => { vi.advanceTimersByTime(2100) })
    expect(del.className).not.toContain('session-delete-confirm')
  })

  it('renders session titles with a hover title for overflow', () => {
    renderSidebar(snapshot([session('a', 'A very long session title that overflows', 'x', '2026-08-07T10:00:00Z')]))
    expect(screen.getByText('A very long session title that overflows').getAttribute('title')).toBe(
      'A very long session title that overflows',
    )
  })

  it('labels a flat session list as recent when no custom groups exist', () => {
    renderSidebar(snapshot([session('a', '最近任务', '继续处理', '2026-08-07T10:00:00Z')]))
    expect(screen.getByText('最近会话')).toBeTruthy()
    expect(screen.queryByText('未分组')).toBeNull()
  })

  it('exposes group creation and submits the current workspace by default', async () => {
    renderSidebar(snapshot([]))

    fireEvent.click(screen.getByRole('button', { name: '新建分组' }))
    const name = screen.getByLabelText('分组名称')
    fireEvent.change(name, { target: { value: '  客户端  ' } })
    fireEvent.click(screen.getByRole('button', { name: '创建分组' }))

    expect(window.pi.createSessionGroup).toHaveBeenCalledWith('客户端', ['/ws'])
  })

  it('creates an ungrouped task atomically', () => {
    renderSidebar(snapshot([]))
    fireEvent.click(screen.getByRole('button', { name: '新建任务选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '新建未分组任务' }))
    expect(window.pi.newSession).toHaveBeenCalledWith(null)
    expect(window.pi.moveSessionToGroup).not.toHaveBeenCalled()
  })

  it('renders groups as accessible collapsible sections with a stable actions menu', () => {
    const groups: SessionGroup[] = [{ id: 'g1', name: '前端项目', dirs: ['/ws'] }]
    const sessions = [
      session('a', '修复导航', '调整交互', '2026-08-07T10:00:00Z', 'g1'),
      session('b', '整理文档', '补充 README', '2026-08-07T09:00:00Z'),
    ]
    renderSidebar(snapshot(sessions, groups))

    const toggle = document.querySelector('.session-group-toggle') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('修复导航')).toBeTruthy()
    expect(screen.getByText('未分组')).toBeTruthy()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('修复导航')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '前端项目 的分组操作' }))
    expect(screen.getByRole('menuitem', { name: '编辑分组' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '删除分组' })).toBeTruthy()
  })

  it('edits a group name and its bound directories', async () => {
    const groups: SessionGroup[] = [{ id: 'g1', name: '前端项目', dirs: ['/ws'] }]
    vi.mocked(window.pi.pickDirectory).mockResolvedValue('/other')
    renderSidebar(snapshot([], groups))

    fireEvent.click(screen.getByRole('button', { name: '前端项目 的分组操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑分组' }))
    const name = screen.getByLabelText('分组名称') as HTMLInputElement
    expect(name.value).toBe('前端项目')
    fireEvent.change(name, { target: { value: '客户端' } })
    fireEvent.click(screen.getByRole('button', { name: '移除目录' }))
    fireEvent.click(screen.getByRole('button', { name: '添加目录' }))
    await screen.findByText('other')
    fireEvent.click(screen.getByRole('button', { name: '保存分组' }))

    expect(window.pi.updateSessionGroup).toHaveBeenCalledWith('g1', '客户端', ['/other'])
  })

  it('requires a second click before deleting a group', () => {
    const groups: SessionGroup[] = [{ id: 'g1', name: '前端项目', dirs: ['/ws'] }]
    renderSidebar(snapshot([], groups))

    fireEvent.click(screen.getByRole('button', { name: '前端项目 的分组操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除分组' }))
    expect(window.pi.deleteSessionGroup).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: '确认删除？' }))
    expect(window.pi.deleteSessionGroup).toHaveBeenCalledWith('g1')
  })

  it('keeps empty groups visible as useful drop targets', () => {
    const groups: SessionGroup[] = [{ id: 'g1', name: '空分组', dirs: ['/ws'] }]
    renderSidebar(snapshot([], groups))
    expect(screen.getByText('拖入会话到此分组')).toBeTruthy()
  })
})
