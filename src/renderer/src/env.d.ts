import type { DesktopInfo, PiDesktopApi } from '../../shared/contracts'

declare global {
  interface Window {
    pi: PiDesktopApi
    desktop: DesktopInfo
  }
}
export {}
