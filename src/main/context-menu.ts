import type { MenuItemConstructorOptions } from 'electron'

/**
 * Strict http/https gate shared by the context-menu "打开链接" action and the
 * setWindowOpenHandler: only URLs the WHATWG parser accepts AND whose protocol
 * is exactly http: or https: may reach the system browser. javascript:, data:,
 * file:, mailto: and malformed input are rejected before any side effect.
 * Returns the canonicalized URL (parser-normalized) or null when unsafe.
 */
export function safeExternalUrl(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

/** Minimal structural subset of Electron's ContextMenuParams (keeps the builder pure). */
export interface ContextMenuInput {
  isEditable: boolean
  selectionText: string
  /** Empty string when no link is under the cursor. */
  linkURL: string
  /** Empty string when no misspelled word is under the cursor. */
  misspelledWord: string
  dictionarySuggestions: string[]
}

/** Side effects the builder needs; injected so it stays pure and testable. */
export interface ContextMenuActions {
  /** Opens an already-validated URL in the system browser. */
  openExternal: (url: string) => void
  /** Copies arbitrary text to the clipboard. */
  copyText: (text: string) => void
  /** Replaces the misspelled word with the given suggestion. */
  replaceMisspelling: (word: string) => void
  /** Adds the misspelled word to the user dictionary. */
  addToDictionary: (word: string) => void
}

/** Upper bound on dictionary suggestions surfaced in the menu. */
export const MAX_DICTIONARY_SUGGESTIONS = 5

/**
 * Pure context-menu template builder. The renderer can never supply menu
 * commands or URLs: everything derives from the webContents context params and
 * every side effect goes through the injected callbacks.
 *
 * Layout mirrors Chromium's native menu: spelling suggestions + "添加到词典"
 * first, then the edit/selection block, then the validated link block.
 */
export function buildContextMenu(input: ContextMenuInput, actions: ContextMenuActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []

  // Spelling: first 3–5 dictionary candidates become replaceMisspelling
  // entries; a misspelled word always offers the user-dictionary add.
  if (input.misspelledWord) {
    for (const suggestion of input.dictionarySuggestions.slice(0, MAX_DICTIONARY_SUGGESTIONS)) {
      items.push({ label: suggestion, click: () => actions.replaceMisspelling(suggestion) })
    }
    items.push({ label: '添加到词典', click: () => actions.addToDictionary(input.misspelledWord) })
  }

  if (input.isEditable) {
    if (items.length > 0) items.push({ type: 'separator' })
    items.push(
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' },
      { role: 'selectAll' },
    )
  } else if (input.selectionText) {
    // Non-editable selection: copy the exact selected text via the injected
    // callback — never a renderer-supplied command or URL.
    if (items.length > 0) items.push({ type: 'separator' })
    items.push({ label: '复制', click: () => actions.copyText(input.selectionText) })
  } else {
    // Blank area with no selection: selecting everything stays useful.
    if (items.length > 0) items.push({ type: 'separator' })
    items.push({ role: 'selectAll' })
  }

  // Links: only a strictly validated http/https URL may be opened or copied.
  // The injected openExternal callback re-verifies before any side effect.
  const safeLink = input.linkURL ? safeExternalUrl(input.linkURL) : null
  if (safeLink) {
    items.push({ type: 'separator' })
    items.push(
      { label: '打开链接', click: () => actions.openExternal(safeLink) },
      { label: '复制链接', click: () => actions.copyText(safeLink) },
    )
  }

  return items
}
