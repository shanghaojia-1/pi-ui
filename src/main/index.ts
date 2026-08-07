import { dirname, join } from 'node:path'
import { delimiter } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent, type MessageBoxOptions, type WebContents } from 'electron'
import { IPC, isApiKey, isCustomProviderConfig, isEngineVersion, isGroupDirs, isImageAttachments, isPackageSource, isProviderConnectionTest, isProviderName, isSessionGroupName, isSettingsPatch, isThinkingLevel, isToolApprovalMode, type AppInfo, type ImageAttachment, type SettingsSnapshot } from '../shared/contracts'
import { buildContextMenu, safeExternalUrl } from './context-menu'
import { activateEngineVersion, deactivateEngine, findNpm, getEngineApi, getEngineStatus, installEngineVersion, listRegistryVersions, loadEngineApi, uninstallEngineVersion } from './engine-loader'
import { ManagedModeStore } from './managed-mode'
import { PiRuntime } from './runtime'
import { windowOptionsForPlatform } from './window-options'

const runtime = new PiRuntime()
let mainWindow: BrowserWindow | null = null
/** Persisted tool-approval policy; loaded before runtime.initialize and injected into the runtime. */
let managedModeStore: ManagedModeStore | null = null

// Test isolation: e2e suites redirect the persisted user-data dir (managed
// mode, window state, localStorage) so a developer's real profile never
// leaks into a sandboxed run. Must run before whenReady / BrowserWindow.
if (process.env.PI_STUDIO_USER_DATA) {
  app.setPath('userData', process.env.PI_STUDIO_USER_DATA)
}

/**
 * Reusable trusted-sender gate for settings/sensitive write IPC: only the
 * main window's own (non-destroyed) webContents may submit. Any other sender
 * is rejected outright with fixed text before any state is touched, so a
 * compromised or unexpected frame can never change settings or policy.
 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false
  return event.sender === window.webContents
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    // Per-platform appearance (hiddenInset + traffic lights on macOS, native
    // frame + auto-hide menu bar elsewhere) lives in the pure
    // windowOptionsForPlatform helper so tests can cover all platforms.
    ...windowOptionsForPlatform(process.platform),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  })
  // Only http/https may reach the system browser; javascript:, data: and
  // other schemes are denied before any URL-parsing side effects. The same
  // strict safeExternalUrl gate also guards context-menu link opening, so
  // both entry points can never disagree on a protocol.
  window.webContents.setWindowOpenHandler(({ url }) => {
    const safe = safeExternalUrl(url)
    if (safe) void shell.openExternal(safe)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  registerContextMenu(window.webContents)
  runtime.setWindow(window)
  if (process.env.ELECTRON_RENDERER_URL) {
    // Fixed text only: the URL or raw error must never reach the console.
    void window.loadURL(process.env.ELECTRON_RENDERER_URL).catch(() => console.error('Failed to load renderer URL'))
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html')).catch(() => console.error('Failed to load renderer'))
  }
  return window
}

function registerContextMenu(webContents: WebContents): void {
  webContents.on('context-menu', (_event, params) => {
    const window = BrowserWindow.fromWebContents(webContents)
    if (!window || window.isDestroyed() || webContents.isDestroyed()) return
    const template = buildContextMenu(params, {
      // The builder only ever receives already-validated URLs, but re-verify
      // here so no unvalidated value can reach shell.openExternal.
      openExternal: (url) => {
        const safe = safeExternalUrl(url)
        if (safe) void shell.openExternal(safe)
      },
      copyText: (text) => clipboard.writeText(text),
      replaceMisspelling: (word) => webContents.replaceMisspelling(word),
      addToDictionary: (word) => webContents.session.addWordToSpellCheckerDictionary(word),
    })
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup({ window })
  })
}

function textArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 100_000) throw new Error(`Invalid ${name}`)
  return value
}

app.whenReady().then(async () => {
  // Load the pi engine (external version if activated, builtin otherwise) BEFORE
  // the runtime starts; every runtime call reads this cached engine API.
  await loadEngineApi()
  // Finder-launched GUI apps inherit a minimal PATH; make node/npm reachable
  // for the SDK's own npm invocations (package install/update) too.
  try {
    const npm = findNpm()
    if (npm && process.platform !== 'win32') {
      const binDir = dirname(npm.command)
      process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ''}`
    }
  } catch { /* PATH injection is best-effort */ }
  mainWindow = createWindow()
  // Tool-approval policy: create and load the persisted store BEFORE the
  // runtime starts so the first tool_call already sees the persisted mode.
  // Any load failure fails closed to 'ask' and never reaches the runtime.
  managedModeStore = new ManagedModeStore(app.getPath('userData'))
  try { await managedModeStore.load() } catch { /* load failure stays 'ask' */ }
  runtime.setToolApprovalMode(managedModeStore.getMode())
  try { await runtime.initialize(process.cwd()) }
  catch { console.error('Pi initialization failed') } // fixed text: the raw error may embed paths/credentials
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow() })
})

ipcMain.handle(IPC.snapshot, () => runtime.snapshot())
ipcMain.handle(IPC.chooseWorkspace, () => runtime.chooseWorkspace())
ipcMain.handle(IPC.openWorkspace, (_event, path: unknown) => runtime.openWorkspace(textArg(path, 'workspace')))
ipcMain.handle(IPC.newSession, () => runtime.newSession())
ipcMain.handle(IPC.openSession, (_event, path: unknown) => runtime.openSession(textArg(path, 'session')))
ipcMain.handle(IPC.deleteSession, (_event, path: unknown) => runtime.deleteSession(textArg(path, 'session')))
ipcMain.handle(IPC.renameSession, (_event, name: unknown) => runtime.renameSession(textArg(name, 'session name')))
ipcMain.handle(IPC.compactSession, (_event, instructions: unknown) => {
  if (instructions !== undefined && instructions !== null && typeof instructions !== 'string') throw new Error('Invalid compact instructions')
  return runtime.compactSession(instructions === null ? undefined : instructions)
})
ipcMain.handle(IPC.copyLastMessage, () => runtime.copyLastMessage())
ipcMain.handle(IPC.exportSession, () => runtime.exportSession())
ipcMain.handle(IPC.sessionStats, () => runtime.getSessionStats())
ipcMain.handle(IPC.reloadSession, () => runtime.reloadSession())
ipcMain.handle(IPC.pickDirectory, () => runtime.pickDirectory())
ipcMain.handle(IPC.createSessionGroup, (_event, name: unknown, dirs: unknown) => {
  if (!isSessionGroupName(name) || !isGroupDirs(dirs)) throw new Error('Invalid session group')
  return runtime.createSessionGroup(name, dirs)
})
ipcMain.handle(IPC.renameSessionGroup, (_event, id: unknown, name: unknown) => {
  if (!isSessionGroupName(id) || !isSessionGroupName(name)) throw new Error('Invalid session group')
  return runtime.renameSessionGroup(id, name)
})
ipcMain.handle(IPC.deleteSessionGroup, (_event, id: unknown) => {
  if (!isSessionGroupName(id)) throw new Error('Invalid session group')
  return runtime.deleteSessionGroup(id)
})
ipcMain.handle(IPC.moveSessionToGroup, (_event, sessionPath: unknown, groupId: unknown) => {
  if (typeof sessionPath !== 'string' || sessionPath.length < 1 || sessionPath.length > 4096) throw new Error('Invalid session path')
  if (groupId !== null && (!isSessionGroupName(groupId))) throw new Error('Invalid session group')
  return runtime.moveSessionToGroup(sessionPath, groupId as string | null)
})
ipcMain.handle(IPC.quitApp, () => { app.quit() })
ipcMain.handle(IPC.appInfo, (): AppInfo => ({
  name: 'Pi Studio',
  version: app.getVersion(),
  electron: process.versions.electron,
  platform: process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux' ? process.platform : 'other',
  agentDir: getEngineApi().getAgentDir(),
}))
ipcMain.handle(IPC.dynamicCommands, () => runtime.getDynamicCommands())
ipcMain.handle(IPC.extensions, () => runtime.getExtensions())
ipcMain.handle(IPC.providerConfig, (_event, providerId: unknown) => runtime.getProviderConfig(textArg(providerId, 'provider')))
ipcMain.handle(IPC.providerTypes, () => runtime.getProviderTypes())
ipcMain.handle(IPC.saveProviderKey, (_event, providerId: unknown, apiKey: unknown) => runtime.saveProviderKey(textArg(providerId, 'provider'), textArg(apiKey, 'apiKey')))
ipcMain.handle(IPC.testConnection, (_event, config: unknown) => {
  if (!isProviderConnectionTest(config)) throw new Error('Invalid connection test')
  return runtime.testProviderConnection(config)
})
ipcMain.handle(IPC.prompt, (_event, text: unknown, images: unknown) => {
  // images is optional: undefined (plain text) is always valid; anything else
  // must pass the full attachment validation.
  if (images !== undefined && !isImageAttachments(images)) throw new Error('Invalid image attachments')
  return runtime.prompt(textArg(text, 'prompt'), images as ImageAttachment[] | undefined)
})
ipcMain.handle(IPC.abort, () => runtime.abort())
ipcMain.handle(IPC.model, (_event, provider: unknown, id: unknown) => runtime.setModel(textArg(provider, 'provider'), textArg(id, 'model')))
ipcMain.handle(IPC.thinking, (_event, level: unknown) => {
  if (!isThinkingLevel(level)) throw new Error('Invalid thinking level')
  return runtime.setThinking(level)
})

// Settings IPC: every renderer-supplied value is validated in main before it
// reaches the runtime; invalid input throws a fixed message that never echoes
// the input back, and runtime-side failures surface as the sanitized settings
// error inside the returned SettingsSnapshot.
ipcMain.handle(IPC.settings, () => runtime.getSettings())
ipcMain.handle(IPC.updateSettings, (event, patch: unknown) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
  if (!isSettingsPatch(patch)) throw new Error('Invalid settings patch')
  return runtime.updateSettings(patch)
})
ipcMain.handle(IPC.runtimeApiKey, (event, provider: unknown, key: unknown) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
  if (!isProviderName(provider)) throw new Error('Invalid provider')
  if (!isApiKey(key)) throw new Error('Invalid API key')
  return runtime.setRuntimeApiKey(provider, key)
})
ipcMain.handle(IPC.logoutProvider, (event, provider: unknown) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
  if (!isProviderName(provider)) throw new Error('Invalid provider')
  return runtime.logoutProvider(provider)
})
ipcMain.handle(IPC.refreshModels, () => runtime.refreshModels())
ipcMain.handle(IPC.engineStatus, () => getEngineStatus())
ipcMain.handle(IPC.engineVersions, () => listRegistryVersions())
ipcMain.handle(IPC.engineInstall, (_event, version: unknown) => {
  if (!isEngineVersion(version)) throw new Error('Invalid engine version')
  return installEngineVersion(version)
})
ipcMain.handle(IPC.engineActivate, (_event, version: unknown) => {
  if (!isEngineVersion(version)) throw new Error('Invalid engine version')
  activateEngineVersion(version)
})
ipcMain.handle(IPC.engineUninstall, (_event, version: unknown) => {
  if (!isEngineVersion(version)) throw new Error('Invalid engine version')
  uninstallEngineVersion(version)
})
ipcMain.handle(IPC.engineDeactivate, () => { deactivateEngine() })
ipcMain.handle(IPC.packages, () => runtime.listPackages())
ipcMain.handle(IPC.packageInstall, (_event, source: unknown) => {
  if (!isPackageSource(source)) throw new Error('Invalid package source')
  return runtime.installPackage(source)
})
ipcMain.handle(IPC.packageUpdate, (_event, source: unknown) => {
  if (source !== undefined && source !== null && !isPackageSource(source)) throw new Error('Invalid package source')
  return runtime.updatePackages(source === null ? undefined : source)
})
ipcMain.handle(IPC.packageRemove, (_event, source: unknown) => {
  if (!isPackageSource(source)) throw new Error('Invalid package source')
  return runtime.removePackage(source)
})
ipcMain.handle(IPC.packageCheck, () => runtime.checkPackageUpdates())
ipcMain.handle(IPC.customProvider, (_event, config: unknown) => {
  if (!isCustomProviderConfig(config)) throw new Error('Invalid custom provider config')
  return runtime.addCustomProvider(config)
})

/** Native ask→managed confirmation, parented to the main window; cancel-first. */
async function confirmManagedMode(): Promise<boolean> {
  const options: MessageBoxOptions = {
    type: 'warning',
    title: '开启全托管模式',
    message: '开启全托管模式？',
    detail: '开启后，命令与文件修改不再逐次确认，将按当前用户权限直接执行。这不是沙箱：Pi 可以运行任意命令并读写你的文件。',
    buttons: ['开启全托管', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  // isTrustedSender has verified the window is alive; the fallback is defensive.
  const win = mainWindow
  const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return result.response === 0
}

/**
 * Tool-approval-mode IPC. The dangerous enable (ask→managed) is confirmed
 * with a native dialog HERE in main and persisted BEFORE the runtime
 * switches; managed→ask needs no confirmation and flips runtime memory
 * first so a persist failure can never re-enable managed while running.
 * Idempotent: requesting the current mode never prompts or writes again.
 * All store writes are awaited before this handler resolves, so no pending
 * write can outlive the request (exit is safe without extra flushing).
 */
ipcMain.handle(IPC.setToolApprovalMode, async (event, mode: unknown): Promise<SettingsSnapshot> => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
  if (!isToolApprovalMode(mode)) throw new Error('Invalid tool approval mode')
  const store = managedModeStore
  if (mode === runtime.getToolApprovalMode()) return runtime.getSettings() // idempotent
  if (mode === 'managed') {
    // Dangerous enable: native confirmation, then a durable store write
    // BEFORE the runtime switches. A cancelled dialog or a failed write
    // (the store fails closed to 'ask') never enables managed.
    if (!(await confirmManagedMode())) return runtime.getSettings()
    if (store) {
      await store.setMode('managed') // silent fail-closed on write errors
      if (store.getMode() !== 'managed') {
        return { ...(await runtime.getSettings()), error: { message: '保存工具审批模式失败', recoverable: true } }
      }
    }
    runtime.setToolApprovalMode('managed')
    return runtime.getSettings()
  }
  // managed → ask: runtime memory first, then persist; a persist failure
  // must never re-enable managed while running and surfaces one fixed
  // sanitized message (raw errors may embed paths).
  runtime.setToolApprovalMode('ask')
  if (store) {
    try { await store.setMode('ask') }
    catch {
      return { ...(await runtime.getSettings()), error: { message: '保存工具审批模式失败', recoverable: true } }
    }
  }
  return runtime.getSettings()
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
let quitting = false
app.on('before-quit', (event) => {
  event.preventDefault()
  if (quitting) return
  quitting = true
  // Only the first before-quit performs the async cleanup; app.exit() then
  // terminates without re-entering this handler.
  void runtime.dispose().finally(() => app.exit())
})
