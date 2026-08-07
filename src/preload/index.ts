import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppInfo,
  type AppSnapshot,
  type CustomProviderConfig,
  type DesktopInfo,
  type DesktopPlatform,
  type DingtalkConfig,
  type DingtalkStatus,
  type ImageAttachment,
  type PiDesktopApi,
  type ProviderConnectionTest,
  type SettingsPatch,
  type ThinkingLevel,
  type ToolApprovalMode,
} from '../shared/contracts'

function currentPlatform(): DesktopPlatform {
  const platform = process.platform
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') return platform
  return 'other'
}

// Separate readonly namespace so window.pi's method surface stays stable.
// `lang` is an optional test/CI override (PI_STUDIO_LANG); real installs fall
// back to the renderer's navigator.language detection.
const desktop: DesktopInfo = {
  platform: currentPlatform(),
  ...(process.env.PI_STUDIO_LANG === 'zh' || process.env.PI_STUDIO_LANG === 'en' ? { lang: process.env.PI_STUDIO_LANG } : {}),
}

const api: PiDesktopApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  chooseWorkspace: () => ipcRenderer.invoke(IPC.chooseWorkspace),
  openWorkspace: (path: string) => ipcRenderer.invoke(IPC.openWorkspace, path),
  newSession: () => ipcRenderer.invoke(IPC.newSession),
  openSession: (path: string) => ipcRenderer.invoke(IPC.openSession, path),
  deleteSession: (path: string) => ipcRenderer.invoke(IPC.deleteSession, path),
  renameSession: (name: string) => ipcRenderer.invoke(IPC.renameSession, name),
  compactSession: (customInstructions?: string) => ipcRenderer.invoke(IPC.compactSession, customInstructions),
  copyLastMessage: () => ipcRenderer.invoke(IPC.copyLastMessage),
  exportSession: () => ipcRenderer.invoke(IPC.exportSession),
  getSessionStats: () => ipcRenderer.invoke(IPC.sessionStats),
  reloadSession: () => ipcRenderer.invoke(IPC.reloadSession),
  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  createSessionGroup: (name: string, dirs: string[]) => ipcRenderer.invoke(IPC.createSessionGroup, name, dirs),
  renameSessionGroup: (id: string, name: string) => ipcRenderer.invoke(IPC.renameSessionGroup, id, name),
  deleteSessionGroup: (id: string) => ipcRenderer.invoke(IPC.deleteSessionGroup, id),
  moveSessionToGroup: (sessionPath: string, groupId: string | null) => ipcRenderer.invoke(IPC.moveSessionToGroup, sessionPath, groupId),
  quitApp: () => ipcRenderer.invoke(IPC.quitApp),
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  getDynamicCommands: () => ipcRenderer.invoke(IPC.dynamicCommands),
  getExtensions: () => ipcRenderer.invoke(IPC.extensions),
  getProviderConfig: (providerId: string) => ipcRenderer.invoke(IPC.providerConfig, providerId),
  getProviderTypes: () => ipcRenderer.invoke(IPC.providerTypes),
  saveProviderKey: (providerId: string, apiKey: string) => ipcRenderer.invoke(IPC.saveProviderKey, providerId, apiKey),
  testProviderConnection: (config: ProviderConnectionTest) => ipcRenderer.invoke(IPC.testConnection, config),
  sendPrompt: (text: string, images?: ImageAttachment[]) => ipcRenderer.invoke(IPC.prompt, text, images),
  abort: () => ipcRenderer.invoke(IPC.abort),
  cancelSubagent: (taskId: string) => ipcRenderer.invoke(IPC.cancelSubagent, taskId),
  setModel: (provider: string, id: string) => ipcRenderer.invoke(IPC.model, provider, id),
  setThinking: (level: ThinkingLevel) => ipcRenderer.invoke(IPC.thinking, level),
  // Forwarded to main with no local cache: main validates, confirms and persists.
  setToolApprovalMode: (mode: ToolApprovalMode) => ipcRenderer.invoke(IPC.setToolApprovalMode, mode),
  getSettings: () => ipcRenderer.invoke(IPC.settings),
  updateSettings: (patch: SettingsPatch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  // The key is forwarded straight to main; it is never stored in the preload.
  setRuntimeApiKey: (provider: string, key: string) => ipcRenderer.invoke(IPC.runtimeApiKey, provider, key),
  logoutProvider: (provider: string) => ipcRenderer.invoke(IPC.logoutProvider, provider),
  addCustomProvider: (config: CustomProviderConfig) => ipcRenderer.invoke(IPC.customProvider, config),
  refreshModels: () => ipcRenderer.invoke(IPC.refreshModels),
  getEngineStatus: () => ipcRenderer.invoke(IPC.engineStatus),
  getEngineVersions: () => ipcRenderer.invoke(IPC.engineVersions),
  installEngine: (version: string) => ipcRenderer.invoke(IPC.engineInstall, version),
  activateEngine: (version: string) => ipcRenderer.invoke(IPC.engineActivate, version),
  uninstallEngine: (version: string) => ipcRenderer.invoke(IPC.engineUninstall, version),
  deactivateEngine: () => ipcRenderer.invoke(IPC.engineDeactivate),
  getPackages: () => ipcRenderer.invoke(IPC.packages),
  listSubagents: () => ipcRenderer.invoke(IPC.subagents),
  saveSubagent: (name, edit) => ipcRenderer.invoke(IPC.subagentSave, name, edit),
  deleteSubagent: (name) => ipcRenderer.invoke(IPC.subagentDelete, name),
  installPackage: (source: string) => ipcRenderer.invoke(IPC.packageInstall, source),
  updatePackages: (source?: string) => ipcRenderer.invoke(IPC.packageUpdate, source),
  removePackage: (source: string) => ipcRenderer.invoke(IPC.packageRemove, source),
  checkPackageUpdates: () => ipcRenderer.invoke(IPC.packageCheck),
  onSnapshot: (listener: (snapshot: AppSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot): void => listener(snapshot)
    ipcRenderer.on(IPC.changed, handler)
    return () => ipcRenderer.removeListener(IPC.changed, handler)
  },
  getDingtalkConfig: () => ipcRenderer.invoke(IPC.dingtalkConfig),
  saveDingtalkConfig: (config: DingtalkConfig) => ipcRenderer.invoke(IPC.dingtalkSaveConfig, config),
  startDingtalk: () => ipcRenderer.invoke(IPC.dingtalkStart),
  stopDingtalk: () => ipcRenderer.invoke(IPC.dingtalkStop),
  getDingtalkStatus: () => ipcRenderer.invoke(IPC.dingtalkStatus),
  onDingtalkStatus: (listener: (status: DingtalkStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DingtalkStatus): void => listener(status)
    ipcRenderer.on(IPC.dingtalkChanged, handler)
    return () => ipcRenderer.removeListener(IPC.dingtalkChanged, handler)
  },
}

contextBridge.exposeInMainWorld('pi', api)
contextBridge.exposeInMainWorld('desktop', desktop)
