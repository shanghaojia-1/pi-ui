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
 * - win32/linux: native frame + default title bar, movable, menu bar hidden —
 *   no titleBarOverlay and no renderer top inset, so there is never a double
 *   title bar / dead space.
 * - other: safe fallback to the default-frame branch (native title bar).
 */
export function windowOptionsForPlatform(platform: string): BrowserWindowConstructorOptions {
  const isMac = platform === 'darwin'
  return {
    width: 1480, height: 920, minWidth: 980, minHeight: 680,
    title: 'Pi Studio', backgroundColor: '#f5f5f3',
    frame: true,
    movable: true,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    ...(isMac ? { trafficLightPosition: TRAFFIC_LIGHT_POSITION } : {}),
    autoHideMenuBar: !isMac,
  }
}
