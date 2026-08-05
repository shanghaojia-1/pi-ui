import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CSS_PATH = join(import.meta.dirname, '../../src/renderer/src/styles.css')
const CSS = readFileSync(CSS_PATH, 'utf8')

/**
 * CSS unit assertions for the platform-gated window shell: the drag strip is
 * hidden by default (non-darwin) and only rendered/styled under the
 * `.platform-darwin` root selector, with interactive surfaces carved out as
 * no-drag regions.
 */
describe('window shell CSS (platform-gated drag strip)', () => {
  it('hides the drag strip by default so non-darwin platforms get no top inset', () => {
    expect(CSS).toMatch(/\.drag-strip\s*\{\s*display:\s*none\s*;/)
  })

  it('styles the strip only under the .platform-darwin root selector: 44px, block, draggable', () => {
    const rule = CSS.match(/\.platform-darwin\s+\.drag-strip\s*\{[^}]*\}/)?.[0]
    expect(rule).toBeDefined()
    expect(rule).toContain('display: block')
    expect(rule).toContain('height: 44px')
    expect(rule).toContain('-webkit-app-region: drag')
  })

  it('keeps divider borders on the sidebar/right strips inside the darwin rule set', () => {
    expect(CSS).toMatch(/\.platform-darwin\s+\.app-col-left\s+\.drag-strip\s*\{[^}]*border-right:[^}]*\}/)
    expect(CSS).toMatch(/\.platform-darwin\s+\.app-col-right\s+\.drag-strip\s*\{[^}]*border-left:[^}]*\}/)
  })

  it('marks interactive surfaces as no-drag (buttons/inputs/textareas/selects and scroll regions)', () => {
    const rule = CSS.match(/button,[^}]*textarea[^}]*select[^}]*\.conversation\s*\{[^}]*\}/)?.[0]
    expect(rule).toBeDefined()
    expect(rule).toContain('-webkit-app-region: no-drag')
    // scrollable surfaces must also stay clickable
    for (const cls of ['.sidebar-sessions', '.messages', '.rp-scroll', '.banner-zone', '.composer-box']) {
      expect(CSS).toMatch(new RegExp(`${cls.replace('.', '\\.')}[^{]*\\{[^}]*no-drag`))
    }
  })

  it('keeps the splash draggable on darwin while connecting', () => {
    expect(CSS).toMatch(/\.platform-darwin\.splash\s*\{[^}]*\-webkit-app-region:\s*drag\s*;/)
  })
})
