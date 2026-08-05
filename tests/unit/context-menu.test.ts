import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import {
  buildContextMenu,
  MAX_DICTIONARY_SUGGESTIONS,
  safeExternalUrl,
  type ContextMenuActions,
  type ContextMenuInput,
} from '../../src/main/context-menu'

function actions(): ContextMenuActions & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    openExternal: (url) => calls.push(['open', url]),
    copyText: (text) => calls.push(['copy', text]),
    replaceMisspelling: (word) => calls.push(['replace', word]),
    addToDictionary: (word) => calls.push(['dictionary', word]),
  }
}

function baseInput(overrides: Partial<ContextMenuInput> = {}): ContextMenuInput {
  return {
    isEditable: false,
    selectionText: '',
    linkURL: '',
    misspelledWord: '',
    dictionarySuggestions: [],
    ...overrides,
  }
}

/** Invokes the click handler of the item whose label matches, if any. */
function clickItem(items: MenuItemConstructorOptions[], label: string): void {
  const item = items.find((candidate) => candidate.label === label)
  expect(item, `item ${label} missing`).toBeTruthy()
  expect(item!.click, `item ${label} has no click handler`).toBeTruthy()
  ;(item!.click as () => void)()
}

/** Role labels in template order, separators stripped. */
function rolesOf(items: MenuItemConstructorOptions[]): Array<string | undefined> {
  return items.filter((item) => item.role).map((item) => item.role)
}

/** String labels in template order, separators and role items stripped. */
function labelsOf(items: MenuItemConstructorOptions[]): string[] {
  return items
    .map((item) => item.label)
    .filter((label): label is string => typeof label === 'string')
}

describe('buildContextMenu: editable context', () => {
  it('offers undo/redo/cut/copy/paste/selectAll in order', () => {
    const items = buildContextMenu(baseInput({ isEditable: true, selectionText: 'abc' }), actions())
    expect(rolesOf(items)).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
  })

  it('editable with a selection still shows the full edit set, no custom copy', () => {
    const items = buildContextMenu(baseInput({ isEditable: true, selectionText: 'abc' }), actions())
    expect(items.some((item) => item.label === '复制')).toBe(false)
    expect(rolesOf(items)).toContain('copy')
  })
})

describe('buildContextMenu: selection and blank context', () => {
  it('non-editable selection offers a single copy item that copies the selection', () => {
    const api = actions()
    const items = buildContextMenu(baseInput({ selectionText: 'hello world' }), api)
    expect(rolesOf(items)).toEqual([])
    expect(labelsOf(items)).toEqual(['复制'])
    clickItem(items, '复制')
    expect(api.calls).toEqual([['copy', 'hello world']])
  })

  it('non-editable with no selection offers selectAll (blank area)', () => {
    const items = buildContextMenu(baseInput({}), actions())
    expect(rolesOf(items)).toEqual(['selectAll'])
  })

  it('blank area never copies or opens anything', () => {
    const api = actions()
    buildContextMenu(baseInput({}), api)
    expect(api.calls).toEqual([])
  })
})

describe('buildContextMenu: link handling', () => {
  it('shows 打开链接 and 复制链接 for a plain http URL', () => {
    const api = actions()
    const items = buildContextMenu(baseInput({ linkURL: 'http://example.com/page' }), api)
    expect(labelsOf(items)).toEqual(['打开链接', '复制链接'])
    clickItem(items, '打开链接')
    expect(api.calls[0]).toEqual(['open', 'http://example.com/page'])
    api.calls.length = 0
    clickItem(items, '复制链接')
    expect(api.calls[0]).toEqual(['copy', 'http://example.com/page'])
  })

  it('opens and copies the canonicalized URL, not the raw input', () => {
    const api = actions()
    const items = buildContextMenu(baseInput({ linkURL: 'HTTPS://Example.COM/a b' }), api)
    clickItem(items, '打开链接')
    clickItem(items, '复制链接')
    // URL parser behavior: scheme/host lowercased, raw space percent-encoded.
    expect(api.calls).toEqual([
      ['open', 'https://example.com/a%20b'],
      ['copy', 'https://example.com/a%20b'],
    ])
  })

  it('accepts leading/trailing whitespace, which the URL parser strips', () => {
    const api = actions()
    const items = buildContextMenu(baseInput({ linkURL: '  \n https://example.com/x ' }), api)
    clickItem(items, '打开链接')
    // URL parser behavior: C0 control + space trim happens inside the parser.
    expect(api.calls).toEqual([['open', 'https://example.com/x']])
  })

  it('never shows or fires link items for javascript:/data:/file:/mailto: URLs', () => {
    for (const linkURL of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'mailto:a@b.c']) {
      const api = actions()
      const items = buildContextMenu(baseInput({ linkURL }), api)
      expect(labelsOf(items)).not.toContain('打开链接')
      expect(labelsOf(items)).not.toContain('复制链接')
      for (const item of items) if (item.click) (item.click as () => void)()
      expect(api.calls).toEqual([])
    }
  })

  it('rejects malformed URLs the parser cannot handle (space in host, bad percent host, empty host)', () => {
    for (const linkURL of ['https://exa mple.com', 'https://%zz.com', 'https://', 'http://']) {
      const api = actions()
      const items = buildContextMenu(baseInput({ linkURL }), api)
      expect(labelsOf(items)).not.toContain('打开链接')
      expect(labelsOf(items)).not.toContain('复制链接')
      for (const item of items) if (item.click) (item.click as () => void)()
      expect(api.calls).toEqual([])
    }
  })

  it('empty linkURL means no link block', () => {
    const api = actions()
    const items = buildContextMenu(baseInput({}), api)
    expect(labelsOf(items)).not.toContain('打开链接')
    expect(api.calls).toEqual([])
  })
})

describe('safeExternalUrl', () => {
  it('returns canonical http/https URLs and null for everything else', () => {
    expect(safeExternalUrl('https://example.com')).toBe('https://example.com/')
    expect(safeExternalUrl('HTTP://EXAMPLE.com')).toBe('http://example.com/')
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('data:text/html,x')).toBeNull()
    expect(safeExternalUrl('file:///etc/passwd')).toBeNull()
    expect(safeExternalUrl('mailto:a@b.c')).toBeNull()
    expect(safeExternalUrl('https://exa mple.com')).toBeNull()
    expect(safeExternalUrl('')).toBeNull()
  })
})

describe('buildContextMenu: spelling', () => {
  it('limits dictionary suggestions to the first 3-5 candidates', () => {
    const suggestions = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']
    const api = actions()
    const items = buildContextMenu(baseInput({ misspelledWord: 'wrod', dictionarySuggestions: suggestions }), api)
    const replaceItems = items.filter((item) => typeof item.label === 'string' && item.label !== '添加到词典')
    expect(replaceItems.map((item) => item.label)).toEqual(suggestions.slice(0, MAX_DICTIONARY_SUGGESTIONS))
    expect(replaceItems.length).toBeLessThanOrEqual(5)
    clickItem(items, suggestions[0]!)
    expect(api.calls).toEqual([['replace', 'one']])
  })

  it('offers 添加到词典 whenever a word is misspelled, even with no suggestions', () => {
    const api = actions()
    const items = buildContextMenu(baseInput({ misspelledWord: 'wrod', dictionarySuggestions: [] }), api)
    clickItem(items, '添加到词典')
    expect(api.calls).toEqual([['dictionary', 'wrod']])
  })

  it('each suggestion replaces with exactly that word', () => {
    const api = actions()
    const items = buildContextMenu(
      baseInput({ misspelledWord: 'wrod', dictionarySuggestions: ['word', 'ward'] }),
      api,
    )
    clickItem(items, 'ward')
    expect(api.calls).toEqual([['replace', 'ward']])
  })

  it('no misspelled word means no spelling section', () => {
    const items = buildContextMenu(baseInput({ dictionarySuggestions: ['word'] }), actions())
    expect(items.some((item) => item.label === '添加到词典')).toBe(false)
    expect(items.filter((item) => typeof item.label === 'string')).toEqual([])
  })})

describe('buildContextMenu: combined context and renderer isolation', () => {
  it('editable misspelled field with a link shows all sections in order', () => {
    const items = buildContextMenu(
      baseInput({
        isEditable: true,
        selectionText: 'sel',
        linkURL: 'https://example.com',
        misspelledWord: 'wrod',
        dictionarySuggestions: ['word'],
      }),
      actions(),
    )
    expect(rolesOf(items)).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
    expect(labelsOf(items)).toEqual(expect.arrayContaining(['word', '添加到词典', '打开链接', '复制链接']))
  })

  it('every side effect goes through injected callbacks — nothing else is invoked', () => {
    const api = actions()
    const spy = vi.spyOn(api, 'openExternal')
    const items = buildContextMenu(
      baseInput({ selectionText: 'abc', linkURL: 'https://example.com' }),
      api,
    )
    for (const item of items) if (item.click) (item.click as () => void)()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(api.calls).toEqual([
      ['copy', 'abc'],
      ['open', 'https://example.com/'],
      ['copy', 'https://example.com/'],
    ])
  })

  it('invalid link never reaches the open/copy callbacks even when other items fire', () => {
    const api = actions()
    const items = buildContextMenu(
      baseInput({ selectionText: 'abc', linkURL: 'javascript:alert(1)' }),
      api,
    )
    for (const item of items) if (item.click) (item.click as () => void)()
    expect(api.calls).toEqual([['copy', 'abc']])
  })
})
