/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AppSnapshot, SettingsPatch, SettingsSnapshot } from '../../src/shared/contracts'
import SettingsPanel from '../../src/renderer/src/components/SettingsPanel'
import { I18nProvider } from '../../src/renderer/src/lib/i18n'

function settings(over: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    providers: [],
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
  groups: [],
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
  reloadSession: vi.fn().mockResolvedValue(snapshot),
  getExtensions: vi.fn().mockResolvedValue({ extensions: [], errors: [] }),
  getSkills: vi.fn().mockResolvedValue({ skills: [], diagnostics: [] }),
  getProviderConfig: vi.fn(),
  getProviderTypes: vi.fn().mockResolvedValue([]),
  testProviderConnection: vi.fn(),
  saveProviderKey: vi.fn(),
  addCustomProvider: vi.fn(),
  getEngineStatus: vi.fn().mockResolvedValue({
    active: null,
    compatible: true,
    supportedRange: '>=0.83.0 <0.85.0',
    installed: [],
    npm: { available: true, path: '/usr/bin/npm' },
    installDir: '/tmp/engine',
    error: null,
  }),
  getEngineVersions: vi.fn().mockResolvedValue([]),
  installEngine: vi.fn(),
  activateEngine: vi.fn(),
  uninstallEngine: vi.fn(),
  deactivateEngine: vi.fn(),
  getPackages: vi.fn().mockResolvedValue({ packages: [], updateSources: [] }),
  installPackage: vi.fn(),
  updatePackages: vi.fn(),
  removePackage: vi.fn(),
  checkPackageUpdates: vi.fn().mockResolvedValue([]),
  listSubagents: vi.fn().mockResolvedValue([]),
  saveSubagent: vi.fn().mockResolvedValue([]),
  deleteSubagent: vi.fn().mockResolvedValue([]),
  getDingtalkConfig: vi.fn().mockResolvedValue({ enabled: false, clientId: '', clientSecret: '', allowList: [] }),
  saveDingtalkConfig: vi.fn().mockResolvedValue({ state: 'disabled', detail: null, connectedAt: null, lastMessageAt: null, lastSender: null }),
  startDingtalk: vi.fn().mockResolvedValue({ state: 'disabled', detail: null, connectedAt: null, lastMessageAt: null, lastSender: null }),
  stopDingtalk: vi.fn().mockResolvedValue({ state: 'disabled', detail: null, connectedAt: null, lastMessageAt: null, lastSender: null }),
  getDingtalkStatus: vi.fn().mockResolvedValue({ state: 'disabled', detail: null, connectedAt: null, lastMessageAt: null, lastSender: null }),
  onDingtalkStatus: vi.fn().mockReturnValue(() => {}),
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

/** Renders the panel inside I18nProvider so `t` resolves real strings (zh). */
function renderPanel(ui: React.ReactElement) {
  return render(<I18nProvider initialLang="zh">{ui}</I18nProvider>)
}

/** Clicks the settings nav rail entry for the given partition. */
function gotoNav(name: string): void {
  fireEvent.click(screen.getByRole('button', { name }))
}

async function renderReady() {
  const utils = renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
  await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
  return utils
}

describe('SettingsPanel', () => {
  it('shows a loading state, then the providers section (entry buttons; configured list only with data)', async () => {
    let resolve!: (s: SettingsSnapshot) => void
    vi.mocked(api.getSettings).mockReturnValue(new Promise((res) => (resolve = res)))
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    expect(screen.getByText('正在加载设置…')).toBeTruthy()
    resolve(settings())
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('模型提供商')
    await waitFor(() => expect(screen.getByRole('button', { name: '新建供应商' })).toBeTruthy())
    // Entry buttons; no interactive provider list, search or key panel — the
    // active provider/model is chosen in the chat dialog, and new ones are
    // added through the New-provider modal.
    expect(screen.getByRole('button', { name: /刷新模型列表/ })).toBeTruthy()
    expect(screen.queryByLabelText('搜索提供商')).toBeNull()
    expect(screen.queryByLabelText('API Key')).toBeNull()
    // No configured providers in this fixture → the read-only list is absent.
    expect(screen.queryByText('已配置供应商')).toBeNull()
  })

  it('shows error state and retry recovers', async () => {
    vi.mocked(api.getSettings).mockRejectedValueOnce(new Error('boom'))
    vi.mocked(api.getSettings).mockResolvedValueOnce(settings())
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText(/无法加载设置：boom/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    expect(api.getSettings).toHaveBeenCalledTimes(2)
  })

  it('providers section shows entry buttons and only configured (keyed) providers', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(
      settings({
        providers: [
          { id: 'anthropic', name: 'Anthropic', authStatus: 'stored', authLabel: null, credentialType: 'api-key', availableModelCount: 3 },
          { id: 'ollama', name: 'Local Ollama', authStatus: 'models-json', authLabel: null, credentialType: null, availableModelCount: 2 },
          // No API key configured → must NOT appear in the list.
          { id: 'deepseek', name: 'DeepSeek', authStatus: 'none', authLabel: null, credentialType: null, availableModelCount: 0 },
        ],
      }),
    )
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('模型提供商')
    await waitFor(() => expect(screen.getByRole('button', { name: '新建供应商' })).toBeTruthy())
    expect(screen.getByRole('button', { name: /刷新模型列表/ })).toBeTruthy()
    // Read-only configured-provider cards with auth source and model count.
    expect(screen.getByText('已配置供应商')).toBeTruthy()
    expect(screen.getByText('Anthropic')).toBeTruthy()
    expect(screen.getByText('已存储')).toBeTruthy()
    expect(screen.getByText('3 个模型')).toBeTruthy()
    expect(screen.getByText('Local Ollama')).toBeTruthy()
    expect(screen.getByText('models.json')).toBeTruthy()
    expect(screen.getByText('2 个模型')).toBeTruthy()
    // Providers without an API key are not "configured" and stay hidden.
    expect(screen.queryByText('DeepSeek')).toBeNull()
    // Still no search / key panel.
    expect(screen.queryByLabelText('搜索提供商')).toBeNull()
    expect(screen.queryByLabelText('API Key')).toBeNull()
  })







  it('edit button opens the dialog pre-filled with the provider config (id locked)', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(
      settings({
        providers: [
          { id: 'ollama', name: 'Local Ollama', authStatus: 'stored', authLabel: null, credentialType: 'api-key', availableModelCount: 2 },
        ],
      }),
    )
    vi.mocked(api.getProviderConfig).mockResolvedValue({
      id: 'ollama',
      name: 'Local Ollama',
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      models: [{ id: 'llama3.1:8b' }, { id: 'qwen2.5' }],
      hasApiKey: true,
      builtin: false,
    })
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('模型提供商')
    await waitFor(() => expect(screen.getByRole('button', { name: '新建供应商' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: '编辑供应商' })).toBeTruthy())
    // Pre-filled values from the provider config.
    expect((screen.getByLabelText('提供商 ID（必填）') as HTMLInputElement).value).toBe('ollama')
    expect((screen.getByLabelText('显示名称（可选）') as HTMLInputElement).value).toBe('Local Ollama')
    expect((screen.getByLabelText('Base URL（必填）') as HTMLInputElement).value).toBe('http://localhost:11434/v1')
    // Models arrive as chips; the id is locked while editing.
    expect(screen.getByText('llama3.1:8b')).toBeTruthy()
    expect(screen.getByText('qwen2.5')).toBeTruthy()
    expect((screen.getByLabelText('提供商 ID（必填）') as HTMLInputElement).disabled).toBe(true)
    // Key stays blank with a keep-current hint.
    expect((screen.getByLabelText('API Key（可选）') as HTMLInputElement).value).toBe('')
  })





  it('built-in flow: pick a pi type, fill the key, saveProviderKey is called', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.getProviderTypes).mockResolvedValue([
      { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', configured: false },
      { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', configured: false },
    ])
    vi.mocked(api.saveProviderKey).mockResolvedValue(settings())
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('模型提供商')
    await waitFor(() => expect(screen.getByRole('button', { name: '新建供应商' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '新建供应商' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: '添加自定义提供商' })).toBeTruthy())
    // Step 1: pick a built-in type.
    fireEvent.change(screen.getByLabelText('供应商类型'), { target: { value: 'deepseek' } })
    // Official endpoint hint; the custom fields (ID/URL/models) are hidden.
    expect(screen.getByText(/api.deepseek.com/)).toBeTruthy()
    expect(screen.queryByLabelText('提供商 ID（必填）')).toBeNull()
    expect(screen.queryByLabelText('Base URL（必填）')).toBeNull()
    // Step 2: the key.
    fireEvent.change(screen.getByLabelText('API Key（可选）'), { target: { value: 'sk-ds' } })
    fireEvent.click(screen.getByRole('button', { name: '添加提供商' }))
    await waitFor(() => expect(api.saveProviderKey).toHaveBeenCalledWith('deepseek', 'sk-ds'))
    expect(api.addCustomProvider).not.toHaveBeenCalled()
  })
  it('custom flow: per-model display name, context window and image input round-trip to addCustomProvider', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.addCustomProvider).mockResolvedValue(settings())
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('模型提供商')
    await waitFor(() => expect(screen.getByRole('button', { name: '新建供应商' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '新建供应商' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: '添加自定义提供商' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('提供商 ID（必填）'), { target: { value: 'my-ollama' } })
    fireEvent.change(screen.getByLabelText('Base URL（必填）'), { target: { value: 'http://localhost:11434/v1' } })
    // Add a model, then configure it per-model.
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'llama3.1:8b' } })
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }))
    expect(screen.getByText('llama3.1:8b')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('模型显示名称（可选）'), { target: { value: 'Llama 3.1 8B' } })
    fireEvent.change(screen.getByLabelText('上下文窗口'), { target: { value: '128000' } })
    expect(screen.getByText('≈ 128.0k')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '图片' }))
    fireEvent.click(screen.getByRole('button', { name: '添加提供商' }))
    await waitFor(() => expect(api.addCustomProvider).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.addCustomProvider).mock.calls[0]![0]).toEqual({
      id: 'my-ollama',
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      models: [{ id: 'llama3.1:8b', name: 'Llama 3.1 8B', input: ['text', 'image'], contextWindow: 128000 }],
    })
  })

  it('custom flow: invalid per-model context window blocks saving with a message', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.addCustomProvider).mockResolvedValue(settings())
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('模型提供商')
    await waitFor(() => expect(screen.getByRole('button', { name: '新建供应商' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '新建供应商' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: '添加自定义提供商' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('提供商 ID（必填）'), { target: { value: 'my-ollama' } })
    fireEvent.change(screen.getByLabelText('Base URL（必填）'), { target: { value: 'http://localhost:11434/v1' } })
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'm1' } })
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }))
    fireEvent.change(screen.getByLabelText('上下文窗口'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: '添加提供商' }))
    await waitFor(() => expect(screen.getByText('上下文窗口必须是大于 0 的整数（tokens）')).toBeTruthy())
    expect(api.addCustomProvider).not.toHaveBeenCalled()
  })
  it('edit-mode connection test sends the provider id so main can reuse the stored key', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(
      settings({
        providers: [
          { id: 'ollama', name: 'Local Ollama', authStatus: 'stored', authLabel: null, credentialType: 'api-key', availableModelCount: 1 },
        ],
      }),
    )
    vi.mocked(api.getProviderConfig).mockResolvedValue({
      id: 'ollama',
      name: 'Local Ollama',
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      models: [{ id: 'm' }],
      hasApiKey: true,
      builtin: false,
    })
    vi.mocked(api.testProviderConnection).mockResolvedValue({ ok: true, status: 200, kind: 'ok' })
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('模型提供商')
    await waitFor(() => expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: '编辑供应商' })).toBeTruthy())
    // Blank key field + saved key hint: the test must reuse the stored key.
    expect((screen.getByLabelText('API Key（可选）') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('未输入新 Key 时，测试将使用 models.json 中已保存的 Key。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    await waitFor(() =>
      expect(api.testProviderConnection).toHaveBeenCalledWith({
        providerId: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions',
      }),
    )
    await waitFor(() => expect(screen.getByText('连接成功')).toBeTruthy())
  })





  it('sends only changed fields and never null (no provider/model → toggles/timeout still save)', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.updateSettings).mockResolvedValue(settings({ httpIdleTimeoutMs: 30_000 }))
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('默认设置')
    await waitFor(() => expect(screen.getByRole('button', { name: '保存默认设置' })).toBeTruthy())
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
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('默认设置')
    await waitFor(() => expect(screen.getByRole('button', { name: '保存默认设置' })).toBeTruthy())
    fireEvent.click(screen.getByLabelText('自动压缩上下文'))
    fireEvent.click(screen.getByRole('button', { name: '保存默认设置' }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.updateSettings).mock.calls[0]![0]).toEqual({ compactionEnabled: true })
  })

  it('picking a default model sends the provider+model pair it belongs to', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.updateSettings).mockResolvedValue(settings({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet' }))
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('默认设置')
    await waitFor(() => expect(screen.getByRole('button', { name: '保存默认设置' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('默认模型'), { target: { value: 'anthropic:claude-sonnet' } })
    fireEvent.click(screen.getByRole('button', { name: '保存默认设置' }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(1))
    const patch = vi.mocked(api.updateSettings).mock.calls[0]![0] as SettingsPatch
    expect(patch).toEqual({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet' })
    expect(Object.values(patch)).not.toContain(null)
  })

  it('switching the default model to another provider saves a consistent pair', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet' }))
    vi.mocked(api.updateSettings).mockResolvedValue(settings({ defaultProvider: 'openai', defaultModel: 'gpt-4o' }))
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('默认设置')
    await waitFor(() => expect(screen.getByRole('button', { name: '保存默认设置' })).toBeTruthy())
    const modelSel = screen.getByLabelText('默认模型') as HTMLSelectElement
    expect(modelSel.value).toBe('anthropic:claude-sonnet')
    fireEvent.change(modelSel, { target: { value: 'openai:gpt-4o' } })
    fireEvent.click(screen.getByRole('button', { name: '保存默认设置' }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(1))
    const patch = vi.mocked(api.updateSettings).mock.calls[0]![0] as SettingsPatch
    expect(patch).toEqual({ defaultProvider: 'openai', defaultModel: 'gpt-4o' })
    expect(Object.values(patch)).not.toContain(null)
  })



  it('saves a single patch with seconds→ms conversion and syncs the draft on success', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    const saved = settings({ retryEnabled: true, httpIdleTimeoutMs: 30_000, defaultProvider: 'anthropic', defaultModel: 'claude-sonnet' })
    vi.mocked(api.updateSettings).mockResolvedValue(saved)
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('默认设置')
    await waitFor(() => expect(screen.getByRole('button', { name: '保存默认设置' })).toBeTruthy())

    fireEvent.change(screen.getByLabelText('HTTP 空闲超时（秒）'), { target: { value: '30' } })
    fireEvent.click(screen.getByLabelText('自动重试'))
    const modelSel = screen.getByLabelText('默认模型') as HTMLSelectElement
    expect(modelSel.disabled).toBe(false) // models exist in the catalog
    expect(Array.from(modelSel.options).map((o) => o.value)).toEqual([
      '',
      'anthropic:claude-sonnet',
      'anthropic:claude-haiku',
      'openai:gpt-4o',
    ])
    fireEvent.change(modelSel, { target: { value: 'anthropic:claude-sonnet' } })
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
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('默认设置')
    await waitFor(() => expect(screen.getByRole('button', { name: '保存默认设置' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('HTTP 空闲超时（秒）'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: '保存默认设置' }))
    await waitFor(() => expect(screen.getByText(/1–600 秒之间/)).toBeTruthy())
    expect(api.updateSettings).not.toHaveBeenCalled()
  })


  it('refresh button calls refreshModels', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.refreshModels).mockResolvedValue(settings())
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('模型提供商')
    await waitFor(() => expect(screen.getByRole('button', { name: /刷新模型列表/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /刷新模型列表/ }))
    await waitFor(() => expect(api.refreshModels).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('模型列表已刷新')).toBeTruthy())
  })

  it('shows read-only compaction/retry values', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('默认设置')
    await waitFor(() => expect(screen.getByText('压缩保留')).toBeTruthy())
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
    const { unmount } = renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    const dialog = screen.getByRole('dialog', { name: '设置' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭设置')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('clicks on the backdrop (outside the sheet) close the dialog; clicks inside do not', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    const overlay = document.querySelector('.sett-overlay') as HTMLElement
    const sheet = document.querySelector('.sett-sheet') as HTMLElement
    expect(overlay).toBeTruthy()
    expect(sheet).toBeTruthy()
    // Clicking inside the sheet never closes.
    fireEvent.click(sheet)
    expect(onClose).not.toHaveBeenCalled()
    // Clicking the backdrop itself closes.
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // ---------- tool approval (managed mode) ----------

  it('shows the danger partition: ask copy, switch off, neutral pill, aria-live status', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('工具审批')
    await waitFor(() => expect(screen.getByRole('heading', { name: /工具审批/ })).toBeTruthy())
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
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('工具审批')
    await waitFor(() => expect(screen.getByRole('switch')).toBeTruthy())
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
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('工具审批')
    await waitFor(() => expect(screen.getByRole('switch')).toBeTruthy())
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
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('工具审批')
    await waitFor(() => expect(screen.getByRole('switch')).toBeTruthy())
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
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('工具审批')
    await waitFor(() => expect(screen.getByRole('switch')).toBeTruthy())
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
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('工具审批')
    await waitFor(() => expect(screen.getByRole('switch')).toBeTruthy())
    const sw = screen.getByRole('switch') as HTMLInputElement
    fireEvent.click(sw)
    await waitFor(() => expect(screen.getByText('保存工具审批模式失败')).toBeTruthy())
    expect(sw.checked).toBe(false) // real mode from the response drives the UI
  })

  it('IPC rejection shows the error and re-syncs the switch via getSettings', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.setToolApprovalMode).mockRejectedValueOnce(new Error('ipc boom'))
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('工具审批')
    await waitFor(() => expect(screen.getByRole('switch')).toBeTruthy())
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
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('工具审批')
    await waitFor(() => expect(screen.getByRole('switch')).toBeTruthy())
    const sw = screen.getByRole('switch') as HTMLInputElement
    fireEvent.click(sw)
    await waitFor(() => expect(sw.disabled).toBe(true))
    expect(sw.checked).toBe(false) // no optimistic flip while busy
    resolve(settings({ toolApprovalMode: 'managed' }))
    await waitFor(() => expect(sw.disabled).toBe(false))
    expect(sw.checked).toBe(true)
  })

  it('mode change merges the settings response without losing the defaults draft', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    // response with a different read-only snapshot than the draft
    vi.mocked(api.setToolApprovalMode).mockResolvedValue(settings({ toolApprovalMode: 'managed' }))
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('默认设置')
    await waitFor(() => expect(screen.getByRole('button', { name: '保存默认设置' })).toBeTruthy())
    // unsaved draft
    const timeout = screen.getByLabelText('HTTP 空闲超时（秒）') as HTMLInputElement
    fireEvent.change(timeout, { target: { value: '30' } })
    // toggle the mode
    gotoNav('工具审批')
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(screen.getByText('已开启全托管模式')).toBeTruthy())
    // the unsaved draft was not reset by the merge
    expect(timeout.value).toBe('30')
  })

  it('opened with initialSection="approval": activates the approval partition and focuses the switch', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} initialSection="approval" />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    await waitFor(() => expect(document.activeElement?.hasAttribute('data-sett-approval-toggle')).toBe(true))
  })

  // ---------- settings navigation rail ----------

  it('renders the section navigation rail and highlights the clicked entry', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    const nav = screen.getByRole('navigation', { name: '设置分区' })
    const items = nav.querySelectorAll('.sett-nav-item')
    expect(items.length).toBe(9)
    expect(nav.querySelector('[aria-current="true"]')?.textContent).toBe('外观')
    const approval = Array.from(items).find((b) => b.textContent === '工具审批') as HTMLElement
    fireEvent.click(approval)
    expect(nav.querySelector('[aria-current="true"]')?.textContent).toBe('工具审批')
  })

  // ---------- skills ----------

  it('lists and filters skills, then exposes source and invocation details', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.getSkills).mockResolvedValue({
      skills: [
        {
          name: 'review-code',
          description: 'Review a change for correctness',
          filePath: '/tmp/ws/.pi/skills/review-code/SKILL.md',
          baseDir: '/tmp/ws/.pi/skills/review-code',
          sourceLabel: 'project',
          source: 'auto',
          origin: 'top-level',
          disableModelInvocation: false,
        },
        {
          name: 'release',
          description: 'Prepare a release',
          filePath: '/agent/skills/release/SKILL.md',
          baseDir: '/agent/skills/release',
          sourceLabel: 'user',
          source: 'npm:release-tools',
          origin: 'package',
          disableModelInvocation: true,
        },
      ],
      diagnostics: [{ type: 'warning', message: 'Ignored malformed metadata', path: '/tmp/bad/SKILL.md' }],
    })
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('技能')
    await waitFor(() => expect(screen.getByText('review-code')).toBeTruthy())
    expect(screen.getByText('release')).toBeTruthy()
    expect(screen.getByText('2 个技能')).toBeTruthy()
    expect(screen.getByText('加载诊断')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('搜索技能'), { target: { value: 'release-tools' } })
    expect(screen.queryByText('review-code')).toBeNull()
    const release = screen.getByText('release').closest('details')!
    fireEvent.click(release.querySelector('summary')!)
    expect(screen.getByText('/agent/skills/release/SKILL.md')).toBeTruthy()
    expect(screen.getByText('仅显式调用')).toBeTruthy()
    expect(screen.getByText('/skill:release')).toBeTruthy()
  })

  it('reloads the session and refreshes the skill inventory', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.getSkills)
      .mockResolvedValueOnce({ skills: [], diagnostics: [] })
      .mockResolvedValueOnce({
        skills: [{
          name: 'new-skill', description: 'Freshly loaded', filePath: '/skill/SKILL.md', baseDir: '/skill',
          sourceLabel: 'user', source: 'auto', origin: 'top-level', disableModelInvocation: false,
        }],
        diagnostics: [],
      })
    vi.mocked(api.reloadSession).mockResolvedValue(snapshot)

    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('技能')
    await waitFor(() => expect(screen.getByText(/当前没有发现技能/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '重载技能' }))
    await waitFor(() => expect(screen.getByText('new-skill')).toBeTruthy())
    expect(api.reloadSession).toHaveBeenCalledTimes(1)
    expect(api.getSkills).toHaveBeenCalledTimes(2)
    expect(screen.getByText('技能已重载')).toBeTruthy()
  })

  it('initialSection="approval" activates the approval entry in the rail', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} initialSection="approval" />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    const nav = screen.getByRole('navigation', { name: '设置分区' })
    expect(nav.querySelector('[aria-current="true"]')?.textContent).toBe('工具审批')
  })

  // ---------- subagents ----------

  const AGENTS = [
    {
      name: 'scout',
      description: 'Fast recon',
      tools: ['read', 'grep', 'find', 'ls', 'bash'],
      model: 'claude-haiku-4-5',
      systemPrompt: 'Recon quickly.',
      filePath: '/agent/agents/scout.md',
    },
    {
      name: 'worker',
      description: 'General purpose',
      systemPrompt: 'Do work.',
      filePath: '/agent/agents/worker.md',
    },
  ]

  it('lists subagents with model and tool chips after navigating to the partition', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.listSubagents).mockResolvedValue(AGENTS)
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('子代理')
    await waitFor(() => expect(screen.getByText('scout')).toBeTruthy())
    expect(screen.getByText('Fast recon')).toBeTruthy()
    expect(screen.getByText('claude-haiku-4-5')).toBeTruthy()
    expect(screen.getByText('read')).toBeTruthy()
    expect(screen.getByText('bash')).toBeTruthy()
    expect(screen.getByText('worker')).toBeTruthy()
    expect(screen.getByText('General purpose')).toBeTruthy()
    expect(api.listSubagents).toHaveBeenCalledTimes(1)
  })

  it('creates a subagent through the inline editor and refreshes the list', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.listSubagents).mockResolvedValue([])
    vi.mocked(api.saveSubagent).mockResolvedValue(AGENTS)
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('子代理')
    await waitFor(() => expect(screen.getByText('还没有子代理，点“新建子代理”创建一个。')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '新建子代理' }))
    fireEvent.change(screen.getByLabelText('名称（文件名，不可改）'), { target: { value: 'debugger' } })
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: 'Finds bugs' } })
    // Model picker (catalog-driven) + tool toggle chips.
    fireEvent.change(screen.getByLabelText('模型（可选）'), { target: { value: 'claude-haiku' } })
    fireEvent.click(screen.getByRole('button', { name: 'read' }))
    fireEvent.click(screen.getByRole('button', { name: 'bash' }))
    fireEvent.change(screen.getByLabelText('系统提示词'), { target: { value: 'Hunt bugs.' } })
    fireEvent.click(screen.getByRole('button', { name: '保存子代理' }))
    await waitFor(() => expect(api.saveSubagent).toHaveBeenCalledWith('debugger', {
      name: 'debugger',
      description: 'Finds bugs',
      model: 'claude-haiku',
      tools: ['read', 'bash'],
      systemPrompt: 'Hunt bugs.',
    }))
    await waitFor(() => expect(screen.getByText('scout')).toBeTruthy()) // refreshed list
  })

  it('validates the name and refuses to save empty descriptions', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.listSubagents).mockResolvedValue([])
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('子代理')
    await waitFor(() => expect(screen.getByRole('button', { name: '新建子代理' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '新建子代理' }))
    fireEvent.change(screen.getByLabelText('名称（文件名，不可改）'), { target: { value: '../evil' } })
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: '保存子代理' }))
    await waitFor(() => expect(screen.getByText('请输入名称（字母/数字/.-_）')).toBeTruthy())
    expect(api.saveSubagent).not.toHaveBeenCalled()
  })

  it('deletes a subagent after confirmation', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.listSubagents).mockResolvedValue(AGENTS)
    vi.mocked(api.deleteSubagent).mockResolvedValue(AGENTS.slice(1))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('子代理')
    await waitFor(() => expect(screen.getByText('scout')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]!)
    await waitFor(() => expect(api.deleteSubagent).toHaveBeenCalledWith('scout'))
    expect(confirmSpy).toHaveBeenCalledWith('确定删除子代理“scout”？')
    // The refreshed list no longer shows the deleted agent.
    await waitFor(() => expect(screen.queryByText('scout')).toBeNull())
    confirmSpy.mockRestore()
  })

  // ---------- DingTalk robot bridge ----------

  it('dingtalk section: pre-fills from config, parses allowlist lines and saves', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings())
    vi.mocked(api.getDingtalkConfig).mockResolvedValue({
      enabled: true,
      clientId: 'app-key-1',
      clientSecret: 'secret-1',
      allowList: ['staff-1', 'staff-2'],
    })
    vi.mocked(api.saveDingtalkConfig).mockResolvedValue({
      state: 'connected',
      detail: null,
      connectedAt: 1_700_000_000_000,
      lastMessageAt: null,
      lastSender: 'staff-1',
    })
    renderPanel(<SettingsPanel snapshot={snapshot} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置分区' })).toBeTruthy())
    gotoNav('钉钉远程控制')
    await waitFor(() => expect(screen.getByRole('heading', { name: /钉钉远程控制/ })).toBeTruthy())
    // Draft initialized from the persisted config.
    expect((screen.getByLabelText('Client ID（AppKey）') as HTMLInputElement).value).toBe('app-key-1')
    expect((screen.getByLabelText('Client Secret（AppSecret）') as HTMLInputElement).value).toBe('secret-1')
    expect((screen.getByLabelText('允许的发送者（每行一个）') as HTMLTextAreaElement).value).toBe('staff-1\nstaff-2')
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(true)
    // Edit the fields; the allowlist is trimmed per line with empties dropped.
    fireEvent.change(screen.getByLabelText('Client ID（AppKey）'), { target: { value: '  app-key-2  ' } })
    fireEvent.change(screen.getByLabelText('Client Secret（AppSecret）'), { target: { value: 'secret-2' } })
    fireEvent.change(screen.getByLabelText('允许的发送者（每行一个）'), { target: { value: ' staff-1 \n\nstaff-3\n' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(api.saveDingtalkConfig).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.saveDingtalkConfig).mock.calls[0]![0]).toEqual({
      enabled: true,
      clientId: 'app-key-2',
      clientSecret: 'secret-2',
      allowList: ['staff-1', 'staff-3'],
    })
    // The returned status drives the state card and the connect/disconnect button.
    await waitFor(() => expect(screen.getByText('配置已保存')).toBeTruthy())
    expect(screen.getByText('已连接')).toBeTruthy()
    expect(screen.getByText('最近消息来自：')).toBeTruthy()
    expect(screen.getByText('staff-1')).toBeTruthy()
    expect(screen.getByRole('button', { name: '断开' })).toBeTruthy()
  })
})
