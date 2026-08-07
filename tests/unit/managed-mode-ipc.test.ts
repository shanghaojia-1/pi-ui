import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC, type SettingsSnapshot } from '../../src/shared/contracts'
import { MANAGED_MODE_FILENAME, parseManagedModeFile } from '../../src/main/managed-mode'

/**
 * IPC-level tests against the real main entry (src/main/index.ts): the store
 * is created and loaded before runtime.initialize, every sensitive write IPC
 * enforces the trusted-sender gate, and the ask→managed native confirmation
 * lives in main. Electron, the SDK and one fs failure point are mocked; the
 * store itself runs on the real filesystem so persistence stays observable.
 */
const mocks = vi.hoisted(() => {
  class FakeWebContents {
    send = vi.fn()
    isDestroyed = (): boolean => false
    on = vi.fn()
    setWindowOpenHandler = vi.fn()
  }
  class FakeBrowserWindow {
    webContents = new FakeWebContents()
    isDestroyed = (): boolean => false
    on = vi.fn()
    isMaximized = vi.fn(() => false)
    minimize = vi.fn()
    maximize = vi.fn()
    unmaximize = vi.fn()
    close = vi.fn()
    // createWindow loads the renderer on the BrowserWindow (real Electron API).
    loadURL = vi.fn().mockResolvedValue(undefined)
    loadFile = vi.fn().mockResolvedValue(undefined)
    static fromWebContents = vi.fn(() => null)
    static instances: FakeBrowserWindow[] = []
    constructor() { FakeBrowserWindow.instances.push(this) }
  }
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => { resolveReady = resolve })
  return {
    app: {
      whenReady: vi.fn(() => ready),
      getPath: vi.fn(),
      on: vi.fn(),
      quit: vi.fn(),
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: { handle: vi.fn() },
    dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
    clipboard: { writeText: vi.fn() },
    Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
    shell: { openExternal: vi.fn() },
    // SDK surface PiRuntime imports; the boot path only needs these.
    createAgentSession: vi.fn(),
    getAgentDir: vi.fn(),
    ModelRuntime: { create: vi.fn() },
    SessionManager: { create: vi.fn(), open: vi.fn(), list: vi.fn() },
    DefaultResourceLoader: vi.fn(),
    rename: vi.fn(),
    actualFs: {} as Record<string, (...args: unknown[]) => unknown>,
    ready: { promise: ready, resolve: () => resolveReady() },
  }
})

vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: mocks.BrowserWindow,
  ipcMain: mocks.ipcMain,
  dialog: mocks.dialog,
  clipboard: mocks.clipboard,
  Menu: mocks.Menu,
  shell: mocks.shell,
}))

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: mocks.createAgentSession,
  DefaultResourceLoader: mocks.DefaultResourceLoader,
  getAgentDir: mocks.getAgentDir,
  ModelRuntime: mocks.ModelRuntime,
  SessionManager: mocks.SessionManager,
}))

// The main entry now loads the SDK through the engine loader; serve the same
// mocked SDK surface (and stub the engine-management exports) so the IPC
// boot path stays deterministic.
vi.mock('../../src/main/engine-loader', () => ({
  getEngineApi: () => ({
    createAgentSession: mocks.createAgentSession,
    DefaultResourceLoader: mocks.DefaultResourceLoader,
    getAgentDir: mocks.getAgentDir,
    ModelRuntime: mocks.ModelRuntime,
    SessionManager: mocks.SessionManager,
    DefaultPackageManager: class DefaultPackageManager {},
  }),
  loadEngineApi: vi.fn(),
  getEngineStatus: vi.fn(),
  listRegistryVersions: vi.fn(),
  installEngineVersion: vi.fn(),
  activateEngineVersion: vi.fn(),
  uninstallEngineVersion: vi.fn(),
  deactivateEngine: vi.fn(),
}))

// Only the atomic rename is mocked (the managed-mode test suite's proven
// failure point); everything else passes through to the real filesystem.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  mocks.actualFs = actual as unknown as Record<string, (...args: unknown[]) => unknown>
  return { ...actual, rename: mocks.rename }
})

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

class FakeSession {
  messages: unknown[] = []
  model: unknown = null
  thinkingLevel = 'medium'
  sessionId = 'fake-session'
  sessionFile: string | null = null
  settingsManager: unknown = null
  activeToolNames = ['read', 'bash', 'edit', 'write', 'subagent']
  subscribe = (): (() => void) => () => {}
  async bindExtensions(): Promise<void> {}
  getActiveToolNames(): string[] { return [...this.activeToolNames] }
  setActiveToolsByName(names: string[]): void { this.activeToolNames = [...names] }
  dispose(): void {}
  async setModel(): Promise<void> {}
  setThinkingLevel(): void {}
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))
const TMP = realpathSync(tmpdir())
const storeFile = (dir: string): string => join(dir, MANAGED_MODE_FILENAME)
function exists(path: string): boolean {
  try { readFileSync(path); return true } catch { return false }
}

let userDataDir: string
let agentDir: string
/** The main window of the LATEST boot (fresh runtime + store per test). */
let mainWindow: {
  isDestroyed: () => boolean
  webContents: { send: { mock: { calls: unknown[] } }; isDestroyed: () => boolean }
}
let mainSender: unknown
const bootDirs: string[] = []

/**
 * Boots a FRESH main entry (new module registry): a new runtime whose
 * approval mode always starts 'ask', a new store on a fresh userData dir and
 * a new main window. Every test therefore observes the exact boot path
 * (store created/loaded before runtime.initialize, mode injected, then a
 * 'pi:changed' send) with zero state carried over from the previous test.
 */
async function bootMain(): Promise<void> {
  userDataDir = mkdtempSync(join(TMP, 'pi-ipc-'))
  agentDir = mkdtempSync(join(TMP, 'pi-agent-ipc-'))
  bootDirs.push(userDataDir, agentDir)
  mocks.app.getPath.mockReturnValue(userDataDir)
  mocks.getAgentDir.mockReturnValue(agentDir)
  vi.resetModules()
  await import('../../src/main/index')
  handlers.clear()
  for (const [channel, handler] of mocks.ipcMain.handle.mock.calls as [string, Handler][]) {
    handlers.set(channel, handler)
  }
  mainWindow = mocks.BrowserWindow.instances.at(-1)!
  // Wait until boot finished: createWindow ran and runtime.initialize emitted.
  for (let i = 0; i < 200; i += 1) {
    await flush()
    if (mainWindow.webContents.send.mock.calls.length > 0) break
  }
  mainSender = { sender: mainWindow.webContents }
}

beforeAll(async () => {
  // One-time mock surfaces; per-test dirs and getPath are set inside bootMain.
  mocks.ModelRuntime.create.mockResolvedValue({
    getAvailable: async () => [],
    getModel: () => null,
    // providerStatuses runs on every settings snapshot; supply the full surface.
    getProviders: () => [],
    listCredentials: async () => [],
    getProviderAuthStatus: () => null,
  })
  mocks.SessionManager.list.mockResolvedValue([])
  mocks.SessionManager.create.mockImplementation((path: string) => ({ getSessionDir: () => path }))
  mocks.SessionManager.open.mockReturnValue({})
  mocks.createAgentSession.mockResolvedValue({ session: new FakeSession(), modelFallbackMessage: undefined })
  mocks.DefaultResourceLoader.mockImplementation((options: unknown) => ({ reload: async () => {}, options }))
  mocks.ready.resolve()
})

afterAll(() => {
  for (const dir of bootDirs) rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  vi.clearAllMocks()
  // Drop any unconsumed once-implementations from the previous test, then
  // restore the real rename (the store's single mocked failure point).
  mocks.rename.mockReset()
  await bootMain()
  mocks.rename.mockImplementation(mocks.actualFs.rename!)
})

describe('setToolApprovalMode IPC', () => {
  it('ask→managed: cancel denies without touching the store and returns the current settings', async () => {
    const handler = handlers.get(IPC.setToolApprovalMode)!
    mocks.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    const settings = await handler(mainSender, 'managed') as SettingsSnapshot
    expect(settings.toolApprovalMode).toBe('ask')
    expect(settings.error).toBeNull()
    // Native confirmation: parented to the main window, cancel-first warning.
    const [win, options] = mocks.dialog.showMessageBox.mock.calls[0] as [unknown, { type: string; buttons: string[]; defaultId: number; cancelId: number; detail: string; message: string }]
    expect(win).toBe(mainWindow)
    expect(options.type).toBe('warning')
    expect(options.buttons).toEqual(['开启全托管', '取消'])
    expect(options.defaultId).toBe(1)
    expect(options.cancelId).toBe(1)
    expect(options.detail).toContain('不再逐次确认')
    expect(options.detail).toContain('按当前用户权限')
    expect(options.detail).toContain('不是沙箱')
    // Cancelled: no store write, no runtime switch.
    expect(exists(storeFile(userDataDir))).toBe(false)
  })

  it('ask→managed: confirming persists the mode and a repeat request never prompts or writes again', async () => {
    const handler = handlers.get(IPC.setToolApprovalMode)!
    mocks.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    const settings = await handler(mainSender, 'managed') as SettingsSnapshot
    expect(settings.toolApprovalMode).toBe('managed')
    expect(settings.error).toBeNull()
    expect(parseManagedModeFile(readFileSync(storeFile(userDataDir), 'utf8'))).toEqual({ version: 1, mode: 'managed' })
    // The AppSnapshot IPC reads the same live mode.
    const snap = await handlers.get(IPC.snapshot)!(mainSender) as { toolApprovalMode: string }
    expect(snap.toolApprovalMode).toBe('managed')

    // Idempotent: already managed — no second dialog, no second store write.
    mocks.dialog.showMessageBox.mockClear()
    mocks.rename.mockClear() // the first request's durable write happened above
    const again = await handler(mainSender, 'managed') as SettingsSnapshot
    expect(again.toolApprovalMode).toBe('managed')
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(mocks.rename).not.toHaveBeenCalled()
  })

  it('ask→managed: a failed store write never enables managed and surfaces one fixed error', async () => {
    const handler = handlers.get(IPC.setToolApprovalMode)!
    mocks.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    mocks.rename.mockRejectedValueOnce(new Error('EXDEV: cross-device link'))
    const settings = await handler(mainSender, 'managed') as SettingsSnapshot
    expect(settings.toolApprovalMode).toBe('ask') // failed closed
    expect(settings.error).toEqual({ message: '保存工具审批模式失败', recoverable: true })
    expect(exists(storeFile(userDataDir))).toBe(false)
  })

  it('managed→ask needs no confirmation, persists, and keeps runtime ask when the write fails', async () => {
    const handler = handlers.get(IPC.setToolApprovalMode)!
    // Enable managed first (confirmed).
    mocks.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    await handler(mainSender, 'managed')
    mocks.dialog.showMessageBox.mockClear()

    // Closing needs no confirmation and persists 'ask'.
    const closed = await handler(mainSender, 'ask') as SettingsSnapshot
    expect(closed.toolApprovalMode).toBe('ask')
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(parseManagedModeFile(readFileSync(storeFile(userDataDir), 'utf8'))).toEqual({ version: 1, mode: 'ask' })

    // Re-enable, then fail the 'ask' write: runtime memory was already ask
    // first, so it stays ask and the stale managed record is removed.
    await handler(mainSender, 'managed')
    mocks.dialog.showMessageBox.mockClear() // the re-enable confirmed above
    mocks.rename.mockRejectedValueOnce(new Error('EIO: i/o error'))
    const failed = await handler(mainSender, 'ask') as SettingsSnapshot
    expect(failed.toolApprovalMode).toBe('ask')
    expect(failed.error).toEqual({ message: '保存工具审批模式失败', recoverable: true })
    expect(exists(storeFile(userDataDir))).toBe(false) // no stale managed record
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('rejects an invalid mode before any dialog or write', async () => {
    const handler = handlers.get(IPC.setToolApprovalMode)!
    await expect(handler(mainSender, 'auto')).rejects.toThrow('Invalid tool approval mode')
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(exists(storeFile(userDataDir))).toBe(false)
  })
})

describe('trusted-sender gate', () => {
  // Some sensitive handlers throw synchronously before returning a promise;
  // route them through a resolved promise so the throw becomes a rejection.
  const call = (handler: Handler, sender: unknown, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve().then(() => handler(sender, ...args))

  it('rejects illegal senders outright on every sensitive write IPC, leaving state untouched', async () => {
    const evil = { sender: { send: () => {} } } // some other webContents
    const attempts: Array<[string, unknown[]]> = [
      [IPC.setToolApprovalMode, ['managed']],
      [IPC.updateSettings, [{ defaultThinkingLevel: 'low' }]],
      [IPC.runtimeApiKey, ['beta', 'sk-test-123']],
      [IPC.logoutProvider, ['beta']],
    ]
    for (const [channel, args] of attempts) {
      await expect(call(handlers.get(channel)!, evil, ...args)).rejects.toThrow('Untrusted IPC sender')
    }
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(exists(storeFile(userDataDir))).toBe(false)
    // The runtime never switched.
    expect((await handlers.get(IPC.snapshot)!(mainSender) as { toolApprovalMode: string }).toolApprovalMode).toBe('ask')
  })

  it('a destroyed main window also fails the gate', async () => {
    const original = mainWindow
    original.isDestroyed = () => true
    try {
      await expect(handlers.get(IPC.setToolApprovalMode)!(mainSender, 'managed')).rejects.toThrow('Untrusted IPC sender')
      expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled()
    } finally {
      original.isDestroyed = () => false
    }
  })

  it('non-sensitive IPC keeps working from the main window', async () => {
    const snapshot = await handlers.get(IPC.snapshot)!(mainSender) as { toolApprovalMode: string }
    expect(snapshot.toolApprovalMode).toBe('ask')
    const settings = await handlers.get(IPC.settings)!(mainSender) as SettingsSnapshot
    expect(settings.toolApprovalMode).toBe('ask')
    expect(settings.error).toBeNull()
  })

  it('boots into a pre-persisted managed mode from the store file', async () => {
    // Re-import the main entry with a fresh module registry and a userData
    // dir that already holds a persisted managed file: the store's current
    // mode must be injected into the runtime before initialize.
    const dir = mkdtempSync(join(TMP, 'pi-ipc-boot-'))
    writeFileSync(join(dir, MANAGED_MODE_FILENAME), JSON.stringify({ version: 1, mode: 'managed' }))
    try {
      mocks.app.getPath.mockReturnValue(dir)
      vi.resetModules()
      await import('../../src/main/index')
      // Rebuild the map so this boot's runtime is the one invoked.
      for (const [channel, handler] of mocks.ipcMain.handle.mock.calls as [string, Handler][]) {
        handlers.set(channel, handler)
      }
      const window = mocks.BrowserWindow.instances.at(-1)!
      for (let i = 0; i < 200; i += 1) {
        await flush()
        if (window.webContents.send.mock.calls.length > 0) break
      }
      const snap = await handlers.get(IPC.snapshot)!(window.webContents) as { toolApprovalMode: string }
      expect(snap.toolApprovalMode).toBe('managed')
      // Idempotent: already managed, no dialog on a repeat request.
      mocks.dialog.showMessageBox.mockClear()
      const again = await handlers.get(IPC.setToolApprovalMode)!({ sender: window.webContents }, 'managed') as SettingsSnapshot
      expect(again.toolApprovalMode).toBe('managed')
      expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled()
    } finally {
      mocks.app.getPath.mockReturnValue(userDataDir)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
