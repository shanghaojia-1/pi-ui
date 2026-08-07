import type { BrowserWindowConstructorOptions } from 'electron'

/**
 * macOS traffic lights float over the renderer drag strip (hiddenInset); the
 * inset position is macOS-only and intentionally omitted elsewhere.
 */
const TRAFFIC_LIGHT_POSITION = { x: 18, y: 18 }

/**
 * Pure, Electron-free BrowserWindow options per host platform — unit-testable
 * without launching Electron.
 *
 * - darwin: `hiddenInset` keeps the native traffic lights floating over a
 *   renderer drag strip; the traffic-light position is macOS-only; the macOS
 *   menu bar stays visible (autoHideMenuBar is never enabled).
 * - win32: frameless (`frame: false`) — the renderer draws a theme-following
 *   title bar (`.window-bar`, same 44px band as the macOS drag strip) with
 *   self-drawn minimize / maximize / close controls wired through IPC. The
 *   title bar's `-webkit-app-region: drag` keeps move, double-click maximize
 *   and Aero Snap working.
 * - linux/other: safe fallback to the default native frame.
 */
export function windowOptionsForPlatform(platform: string): BrowserWindowConstructorOptions {
  const isMac = platform === 'darwin'
  const isWin = platform === 'win32'
  return {
    width: 1480, height: 920, minWidth: 980, minHeight: 680,
    title: 'Pi Studio', backgroundColor: '#f5f5f3',
    movable: true,
    ...(isMac
      ? { frame: true, titleBarStyle: 'hiddenInset' as const, trafficLightPosition: TRAFFIC_LIGHT_POSITION, autoHideMenuBar: false }
      : isWin
        ? { frame: false }
        : { frame: true, titleBarStyle: 'default' as const, autoHideMenuBar: true }),
  }
}
