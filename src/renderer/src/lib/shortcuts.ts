/**
 * Platform-aware shortcut rendering. macOS keeps the classic symbol glyphs
 * (⌘ ⇧ ⌥ ⌃); Windows/Linux use Ctrl/Shift/Alt text instead, since ⌘ does not
 * exist on those platforms and the physical modifier is Ctrl. The host
 * platform comes from the preload contract (window.desktop.platform), never
 * from userAgent sniffing.
 */
const isMac = window.desktop?.platform === 'darwin'

/** Renders a platform-specific shortcut pair: (macOS form, win/linux form). */
export function shortcut(mac: string, win: string): string {
  return isMac ? mac : win
}

/** Primary modifier (Command on macOS, Ctrl elsewhere). */
export const MOD = shortcut('⌘', 'Ctrl')
/** Shift key (⇧ on macOS, Shift elsewhere). */
export const SHIFT = shortcut('⇧', 'Shift')
/** Option/Alt key. */
export const ALT = shortcut('⌥', 'Alt')
