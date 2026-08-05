/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AppSnapshot, ProviderStatus, SettingsPatch, SettingsSnapshot } from '../../src/shared/contracts'
import SettingsPanel from '../../src/renderer/src/components/SettingsPanel'

function provider(over: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    authStatus: 'stored',
    authLabel: null,
    credentialType: 'api-key',
    availableModelCount: 3,
    ...over,
  }
}

function settings(over: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    providers: [provider()],
    defaultProvider: null,
    defaultModel: null,
    defaultThinkingLevel: 'medium',
    compactionEnabled: false,
    retryEnabled: false,
    httpIdleTimeoutMs: 300_000,
    compaction: { reserveTokens: 40_000, keepRecentTokens: 20_000 },
    retry: { maxRetries: 2, baseDelayMs: 2_000, maxDelayMs: 10_000 },
    keyPersistence: 'runtime-only',
    toolApprovalMode: 'ask',
    error: null,
    ...over,
  }
}

const snapshot: AppSnapshot = {
  workspace: { path: '/tmp/ws', name: 'ws' },
  activeSessionPath: null,
  sessions: [],
  models: [
    { provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet', contextWindow: 200_000 },
    { provider: 'anthropic', id: 'claude-haiku', name: 'Claude Haiku' },
    { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000 },
  ],
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

const api = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  setRuntimeApiKey: vi.fn(),
  logoutProvider: vi.fn(),
  refreshModels: vi.fn(),
  setToolApprovalMode: vi.fn(),
} as unknown as Window['pi']

let onClose: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.pi = { ...api } as unknown as Window['pi']
  onClose = vi.fn()
})

afterEach(() => {
  cleanup()
})

async function renderReady() {
  const utils = render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
  await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
  return utils
}

describe('SettingsPanel', () => {
  it('shows a loading state, then provider list with name/id/auth/count/credentialType', async () => {
    let resolve!: (s: SettingsSnapshot) => void
    vi.mocked(api.getSettings).mockReturnValue(new Promise((res) => (resolve = res)))
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    expect(screen.getByText('正在加载设置…')).toBeTruthy()
    resolve(settings())
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    expect(screen.getByText('anthropic')).toBeTruthy()
    expect(screen.getByText('已存储')).toBeTruthy()
    expect(screen.getByText('3 个模型')).toBeTruthy()
    expect(screen.getByText('api-key')).toBeTruthy()
    // first provider auto-selected → API key section ready
    expect(screen.getByLabelText('API Key')).toBeTruthy()
  })

  it('shows error state and retry recovers', async () => {
    vi.mocked(api.getSettings).mockRejectedValueOnce(new Error('boom'))
    vi.mocked(api.getSettings).mockResolvedValueOnce(settings())
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText(/无法加载设置：boom/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    expect(api.getSettings).toHaveBeenCalledTimes(2)
  })

  it('shows pi /login guidance when there are no providers and disables key entry', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings({ providers: [] }))
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText(/pi \/login/)).toBeTruthy())
    expect(screen.getByText('未发现已配置的模型提供商。')).toBeTruthy()
    expect(screen.getByRole('button', { name: /刷新模型列表/ })).toBeTruthy()
    expect(screen.queryByLabelText('API Key')).toBeNull()
  })

  it('submits the runtime key with correct args, clears the input, leaves no DOM residue or storage', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.setRuntimeApiKey).mockResolvedValue(settings())
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    const input = screen.getByLabelText('API Key') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.autocomplete).toBe('new-password')
    fireEvent.change(input, { target: { value: 'sk-secret-123' } })
    fireEvent.click(screen.getByRole('button', { name: '设置 Key' }))
    await waitFor(() => expect(api.setRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'sk-secret-123'))
    await waitFor(() => expect(input.value).toBe(''))
    expect(screen.queryByDisplayValue('sk-secret-123')).toBeNull()
    expect(document.body.innerHTML).not.toContain('sk-secret-123')
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
    expect(screen.getByText(/API Key 已设置/)).toBeTruthy()
  })

  it('clears the secret and reports the error when the runtime reports a settings error', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.setRuntimeApiKey).mockResolvedValue(settings({ error: { message: '设置 API Key 失败', recoverable: true } }))
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    const input = screen.getByLabelText('API Key') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'sk-secret-123' } })
    fireEvent.click(screen.getByRole('button', { name: '设置 Key' }))
    await waitFor(() => expect(screen.getByText('设置 API Key 失败')).toBeTruthy())
    expect(input.value).toBe('') // cleared on failure too
    expect(document.body.innerHTML).not.toContain('sk-secret-123')
  })

  it('clears the secret when the IPC call rejects', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.setRuntimeApiKey).mockRejectedValueOnce(new Error('ipc boom'))
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    const input = screen.getByLabelText('API Key') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'sk-secret-123' } })
    fireEvent.click(screen.getByRole('button', { name: '设置 Key' }))
    await waitFor(() => expect(screen.getByText(/ipc boom/)).toBeTruthy())
    expect(input.value).toBe('')
    expect(document.body.innerHTML).not.toContain('sk-secret-123')
  })

  it('clears the secret when switching providers and never carries it over', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(
      settings({ providers: [provider(), provider({ id: 'openai', name: 'OpenAI', authStatus: 'runtime' })] }),
    )
    vi.mocked(api.setRuntimeApiKey).mockResolvedValue(settings())
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    const input = screen.getByLabelText('API Key') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'sk-secret-123' } })
    expect(input.value).toBe('sk-secret-123')
    fireEvent.click(screen.getByRole('button', { name: /OpenAI/ })) // switch provider
    expect(input.value).toBe('') // wiped immediately, no DOM residue
    expect(document.body.innerHTML).not.toContain('sk-secret-123')
    fireEvent.change(input, { target: { value: 'sk-openai-456' } })
    fireEvent.click(screen.getByRole('button', { name: '设置 Key' }))
    await waitFor(() => expect(api.setRuntimeApiKey).toHaveBeenCalledWith('openai', 'sk-openai-456'))
  })

  it('never submits an in-flight key to a provider switched mid-submit', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(
      settings({ providers: [provider(), provider({ id: 'openai', name: 'OpenAI' })] }),
    )
    let resolve!: (s: SettingsSnapshot) => void
    vi.mocked(api.setRuntimeApiKey).mockReturnValue(new Promise((res) => (resolve = res)))
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    const input = screen.getByLabelText('API Key') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'sk-secret-123' } })
    fireEvent.click(screen.getByRole('button', { name: '设置 Key' }))
    expect(api.setRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'sk-secret-123')
    // switch provider while the request is still in flight
    fireEvent.click(screen.getByRole('button', { name: /OpenAI/ }))
    resolve(settings())
    await waitFor(() => expect(api.setRuntimeApiKey).toHaveBeenCalledTimes(1))
    expect(api.setRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'sk-secret-123') // original target only
    expect(document.body.innerHTML).not.toContain('sk-secret-123')
  })

  it('clears the secret when the dialog closes (button and Escape) and leaves no DOM residue', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    const input = screen.getByLabelText('API Key') as HTMLInputElement
    const dialog = screen.getByRole('dialog', { name: '设置' })
    fireEvent.change(input, { target: { value: 'sk-secret-123' } })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: 'sk-secret-456' } })
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(input.value).toBe('')
    expect(document.body.innerHTML).not.toContain('sk-secret-123')
    expect(document.body.innerHTML).not.toContain('sk-secret-456')
  })

  it('sends only changed fields and never null (no provider/model → toggles/timeout still save)', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.updateSettings).mockResolvedValue(settings({ httpIdleTimeoutMs: 30_000 }))
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('HTTP 空闲超时（秒）'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: '保存默认设置' }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(1))
    const patch = vi.mocked(api.updateSettings).mock.calls[0]![0] as SettingsPatch
    // no provider/model picked → keys absent, null never sent, save still succeeds
    expect(patch).toEqual({ httpIdleTimeoutMs: 30_000 })
    expect('defaultProvider' in patch).toBe(false)
    expect('defaultModel' in patch).toBe(false)
    expect(Object.values(patch)).not.toContain(null)
    await waitFor(() => expect(screen.getByText('默认设置已保存')).toBeTruthy())
  })

  it('sends only the fields that actually changed', async () => {
    const initial = settings({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet', retryEnabled: true })
    vi.mocked(api.getSettings).mockResolvedValue(initial)
    vi.mocked(api.updateSettings).mockResolvedValue({ ...initial, compactionEnabled: true })
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    fireEvent.click(screen.getByLabelText('自动压缩上下文'))
    fireEvent.click(screen.getByRole('button', { name: '保存默认设置' }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.updateSettings).mock.calls[0]![0]).toEqual({ compactionEnabled: true })
  })

  it('includes defaultProvider/defaultModel only as a non-null valid pair', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.updateSettings).mockResolvedValue(settings({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet' }))
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('默认提供商'), { target: { value: 'anthropic' } })
    fireEvent.change(screen.getByLabelText('默认模型'), { target: { value: 'claude-sonnet' } })
    fireEvent.click(screen.getByRole('button', { name: '保存默认设置' }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(1))
    const patch = vi.mocked(api.updateSettings).mock.calls[0]![0] as SettingsPatch
    expect(patch).toEqual({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet' })
    expect(Object.values(patch)).not.toContain(null)
  })

  it('drops the model when the provider changes and never sends a stale/empty model', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet' }))
    vi.mocked(api.updateSettings).mockResolvedValue(settings({ defaultProvider: 'openai' }))
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('默认提供商'), { target: { value: 'openai' } })
    expect((screen.getByLabelText('默认模型') as HTMLSelectElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: '保存默认设置' }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(1))
    const patch = vi.mocked(api.updateSettings).mock.calls[0]![0] as SettingsPatch
    expect(patch).toEqual({ defaultProvider: 'openai' })
    expect(Object.values(patch)).not.toContain(null)
  })

  it('filters the provider list by name/id via search, pins the selection and shows an empty state', async () => {
    const providers = [
      provider(),
      provider({ id: 'openai', name: 'OpenAI', authStatus: 'runtime' }),
      provider({ id: 'deepseek', name: 'DeepSeek' }),
    ]
    vi.mocked(api.getSettings).mockResolvedValue(settings({ providers }))
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    // search box + scrollable list classes are present
    expect(document.querySelector('.sett-provider-search')).toBeTruthy()
    expect(document.querySelector('.sett-provider-search input')).toBeTruthy()
    expect(document.querySelector('.sett-provider-list')).toBeTruthy()
    const search = screen.getByLabelText('搜索提供商')
    // filter by name/id
    fireEvent.change(search, { target: { value: 'open' } })
    expect(screen.getByRole('button', { name: /OpenAI/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /DeepSeek/ })).toBeNull()
    // the auto-selected Anthropic does not match → stays pinned and visible
    expect(screen.getByText('已选（不在搜索结果中）')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy()
    // id-only match
    fireEvent.change(search, { target: { value: 'deepseek' } })
    expect(screen.getByRole('button', { name: /DeepSeek/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /OpenAI/ })).toBeNull()
    // no results → empty state; the pinned selection remains
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByText('未找到匹配的提供商')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy()
    expect(document.querySelector('.sett-provider-list')).toBeNull()
  })

  it('keeps the pinned selected provider clickable and clears any typed secret on selection', async () => {
    const providers = [
      provider(),
      provider({ id: 'openai', name: 'OpenAI', authStatus: 'runtime' }),
      provider({ id: 'deepseek', name: 'DeepSeek' }),
    ]
    vi.mocked(api.getSettings).mockResolvedValue(settings({ providers }))
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('搜索提供商'), { target: { value: 'deep' } })
    expect(screen.getByText('已选（不在搜索结果中）')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /DeepSeek/ })).toBeTruthy()
    const input = screen.getByLabelText('API Key') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'sk-secret-123' } })
    fireEvent.click(screen.getByRole('button', { name: /Anthropic/ })) // reselect via the pinned row
    expect(input.value).toBe('')
    expect(document.body.innerHTML).not.toContain('sk-secret-123')
  })

  it('saves a single patch with seconds→ms conversion and syncs the draft on success', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    const saved = settings({ retryEnabled: true, httpIdleTimeoutMs: 30_000, defaultProvider: 'anthropic', defaultModel: 'claude-sonnet' })
    vi.mocked(api.updateSettings).mockResolvedValue(saved)
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())

    fireEvent.change(screen.getByLabelText('HTTP 空闲超时（秒）'), { target: { value: '30' } })
    fireEvent.click(screen.getByLabelText('自动重试'))
    fireEvent.change(screen.getByLabelText('默认提供商'), { target: { value: 'anthropic' } })
    const modelSel = screen.getByLabelText('默认模型') as HTMLSelectElement
    expect(modelSel.disabled).toBe(false) // linked to the chosen provider
    expect(Array.from(modelSel.options).map((o) => o.value)).toEqual(['', 'claude-sonnet', 'claude-haiku'])
    fireEvent.change(modelSel, { target: { value: 'claude-sonnet' } })
    fireEvent.click(screen.getByRole('button', { name: '保存默认设置' }))

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(1))
    const patch = vi.mocked(api.updateSettings).mock.calls[0]![0] as SettingsPatch
    expect(patch.httpIdleTimeoutMs).toBe(30_000)
    expect(patch.retryEnabled).toBe(true)
    expect(patch.defaultProvider).toBe('anthropic')
    expect(patch.defaultModel).toBe('claude-sonnet')
    await waitFor(() => expect(screen.getByText('默认设置已保存')).toBeTruthy())
    // draft synced with the persisted snapshot (timeout back to seconds)
    expect((screen.getByLabelText('HTTP 空闲超时（秒）') as HTMLInputElement).value).toBe('30')
  })

  it('rejects out-of-range timeout without calling updateSettings', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('HTTP 空闲超时（秒）'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: '保存默认设置' }))
    await waitFor(() => expect(screen.getByText(/1–600 秒之间/)).toBeTruthy())
    expect(api.updateSettings).not.toHaveBeenCalled()
  })

  it('logout requires a second confirmation, then calls logoutProvider', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.logoutProvider).mockResolvedValue(settings())
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    expect(api.logoutProvider).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认退出' }))
    await waitFor(() => expect(api.logoutProvider).toHaveBeenCalledWith('anthropic'))
    await waitFor(() => expect(screen.getByText('已退出登录')).toBeTruthy())
  })

  it('refresh button calls refreshModels', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.refreshModels).mockResolvedValue(settings())
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /刷新模型列表/ }))
    await waitFor(() => expect(api.refreshModels).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('模型列表已刷新')).toBeTruthy())
  })

  it('shows read-only compaction/retry values', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    expect(screen.getByText('压缩保留')).toBeTruthy()
    expect(screen.getByText('40.0k')).toBeTruthy() // reserveTokens via formatTokens
    expect(screen.getByText('20.0k')).toBeTruthy() // keepRecentTokens
    expect(screen.getByText('2 次')).toBeTruthy() // maxRetries
    expect(screen.getByText('2.0s')).toBeTruthy() // baseDelayMs via formatDuration
  })

  it('dialog semantics: aria dialog, initial focus on close, Escape closes, focus restored', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    const { unmount } = render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    const dialog = screen.getByRole('dialog', { name: '设置' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭设置')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  // ---------- tool approval (managed mode) ----------

  it('shows the danger partition: ask copy, switch off, neutral pill, aria-live status', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    expect(screen.getByRole('heading', { name: /工具审批/ })).toBeTruthy()
    const sw = screen.getByRole('switch')
    expect((sw as HTMLInputElement).checked).toBe(false) // ask = off
    expect(screen.getByText(/每次执行 bash \/ edit \/ write 前都会向你确认/)).toBeTruthy()
    expect(screen.getByText('逐次确认', { selector: '.sett-approval-pill' })).toBeTruthy()
    // danger partition classes
    expect(document.querySelector('.sett-approval')).toBeTruthy()
    expect(document.querySelector('.sett-approval-managed')).toBeNull()
    // aria-live status region for mode feedback
    const status = document.querySelector('.sett-approval-status')
    expect(status?.getAttribute('aria-live')).toBe('polite')
    expect(status?.getAttribute('role')).toBe('status')
  })

  it('managed state: switch on, high-risk copy, managed pill and section class', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings({ toolApprovalMode: 'managed' }))
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('全托管', { selector: '.sett-approval-pill' })).toBeTruthy()
    expect(
      screen.getByText(/不再逐次确认；使用当前用户权限；不是沙箱；请仅在信任当前任务时开启/),
    ).toBeTruthy()
    expect(document.querySelector('.sett-approval-managed')).toBeTruthy()
  })

  it('toggle to managed calls setToolApprovalMode("managed") and flips the switch on the returned mode', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.setToolApprovalMode).mockResolvedValue(settings({ toolApprovalMode: 'managed' }))
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    const sw = screen.getByRole('switch') as HTMLInputElement
    fireEvent.click(sw)
    await waitFor(() => expect(api.setToolApprovalMode).toHaveBeenCalledWith('managed'))
    await waitFor(() => expect(sw.checked).toBe(true))
    expect(screen.getByText('已开启全托管模式')).toBeTruthy()
  })

  it('cancelled native confirmation: mode stays ask, switch stays off, 已取消 shown, no optimistic enable', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    // main returns the unchanged ask settings when the native dialog is cancelled
    vi.mocked(api.setToolApprovalMode).mockResolvedValue(settings())
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    const sw = screen.getByRole('switch') as HTMLInputElement
    fireEvent.click(sw)
    await waitFor(() => expect(api.setToolApprovalMode).toHaveBeenCalledWith('managed'))
    await waitFor(() => expect(screen.getByText(/已取消：未开启全托管模式/)).toBeTruthy())
    expect(sw.checked).toBe(false) // never optimistically enabled
    expect(document.querySelector('.sett-approval-managed')).toBeNull()
  })

  it('managed→ask flips off immediately and reports success', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings({ toolApprovalMode: 'managed' }))
    vi.mocked(api.setToolApprovalMode).mockResolvedValue(settings())
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    const sw = screen.getByRole('switch') as HTMLInputElement
    expect(sw.checked).toBe(true)
    fireEvent.click(sw)
    await waitFor(() => expect(api.setToolApprovalMode).toHaveBeenCalledWith('ask'))
    await waitFor(() => expect(sw.checked).toBe(false))
    expect(screen.getByText('已关闭全托管模式')).toBeTruthy()
  })

  it('settings error from main keeps the switch off and surfaces the error', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.setToolApprovalMode).mockResolvedValue(
      settings({ error: { message: '保存工具审批模式失败', recoverable: true } }),
    )
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    const sw = screen.getByRole('switch') as HTMLInputElement
    fireEvent.click(sw)
    await waitFor(() => expect(screen.getByText('保存工具审批模式失败')).toBeTruthy())
    expect(sw.checked).toBe(false) // real mode from the response drives the UI
  })

  it('IPC rejection shows the error and re-syncs the switch via getSettings', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.setToolApprovalMode).mockRejectedValueOnce(new Error('ipc boom'))
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    const sw = screen.getByRole('switch') as HTMLInputElement
    fireEvent.click(sw)
    await waitFor(() => expect(screen.getByText(/ipc boom/)).toBeTruthy())
    expect(sw.checked).toBe(false)
    // re-read the real mode
    expect(api.getSettings).toHaveBeenCalledTimes(2)
    expect(sw.checked).toBe(false)
  })

  it('disables the switch while the mode request is in flight, then re-enables', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    let resolve!: (s: SettingsSnapshot) => void
    vi.mocked(api.setToolApprovalMode).mockReturnValue(new Promise((res) => (resolve = res)))
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    const sw = screen.getByRole('switch') as HTMLInputElement
    fireEvent.click(sw)
    await waitFor(() => expect(sw.disabled).toBe(true))
    expect(sw.checked).toBe(false) // no optimistic flip while busy
    resolve(settings({ toolApprovalMode: 'managed' }))
    await waitFor(() => expect(sw.disabled).toBe(false))
    expect(sw.checked).toBe(true)
  })

  it('mode change merges the settings response without losing the API key or the defaults draft', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    // response with a different providers/read-only snapshot than the draft
    vi.mocked(api.setToolApprovalMode).mockResolvedValue(settings({ toolApprovalMode: 'managed' }))
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    // unsaved draft + typed secret
    const key = screen.getByLabelText('API Key') as HTMLInputElement
    fireEvent.change(key, { target: { value: 'sk-secret-123' } })
    const timeout = screen.getByLabelText('HTTP 空闲超时（秒）') as HTMLInputElement
    fireEvent.change(timeout, { target: { value: '30' } })
    // toggle the mode
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(screen.getByText('已开启全托管模式')).toBeTruthy())
    // neither the secret nor the unsaved draft was reset by the merge
    expect(key.value).toBe('sk-secret-123')
    expect(timeout.value).toBe('30')
    expect(screen.queryByDisplayValue('sk-secret-123')).not.toBeNull()
    // closing the dialog still clears the secret
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    expect(key.value).toBe('')
    expect(document.body.innerHTML).not.toContain('sk-secret-123')
  })

  it('opened with initialSection="approval": scrolls to and focuses the approval switch', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    render(<SettingsPanel snapshot={snapshot} onClose={onClose} initialSection="approval" />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Anthropic/ })).toBeTruthy())
    await waitFor(() => expect(document.activeElement?.hasAttribute('data-sett-approval-toggle')).toBe(true))
  })
})
