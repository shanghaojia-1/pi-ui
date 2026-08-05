import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppSnapshot,
  type DesktopInfo,
  type DesktopPlatform,
  type PiDesktopApi,
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
const desktop: DesktopInfo = { platform: currentPlatform() }

const api: PiDesktopApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  chooseWorkspace: () => ipcRenderer.invoke(IPC.chooseWorkspace),
  openWorkspace: (path: string) => ipcRenderer.invoke(IPC.openWorkspace, path),
  newSession: () => ipcRenderer.invoke(IPC.newSession),
  openSession: (path: string) => ipcRenderer.invoke(IPC.openSession, path),
  sendPrompt: (text: string) => ipcRenderer.invoke(IPC.prompt, text),
  abort: () => ipcRenderer.invoke(IPC.abort),
  setModel: (provider: string, id: string) => ipcRenderer.invoke(IPC.model, provider, id),
  setThinking: (level: ThinkingLevel) => ipcRenderer.invoke(IPC.thinking, level),
  // Forwarded to main with no local cache: main validates, confirms and persists.
  setToolApprovalMode: (mode: ToolApprovalMode) => ipcRenderer.invoke(IPC.setToolApprovalMode, mode),
  getSettings: () => ipcRenderer.invoke(IPC.settings),
  updateSettings: (patch: SettingsPatch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  // The key is forwarded straight to main; it is never stored in the preload.
  setRuntimeApiKey: (provider: string, key: string) => ipcRenderer.invoke(IPC.runtimeApiKey, provider, key),
  logoutProvider: (provider: string) => ipcRenderer.invoke(IPC.logoutProvider, provider),
  refreshModels: () => ipcRenderer.invoke(IPC.refreshModels),
  onSnapshot: (listener: (snapshot: AppSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot): void => listener(snapshot)
    ipcRenderer.on(IPC.changed, handler)
    return () => ipcRenderer.removeListener(IPC.changed, handler)
  },
}

contextBridge.exposeInMainWorld('pi', api)
contextBridge.exposeInMainWorld('desktop', desktop)
