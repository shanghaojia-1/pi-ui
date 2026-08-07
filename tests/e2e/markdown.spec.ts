import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { seedConfiguredEngine } from './engine-fixture'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '../..')
const SCREENSHOTS = join(PROJECT_ROOT, 'artifacts', 'screenshots')

const SESSION_ID = 'sess_markdown_seed'
const FENCE = '```'

/** JSONL v3 seed: session header + user message + rich assistant message + an assistant block with an unclosed fence. */
function seedJsonl(cwd: string): string {
  const t0 = Date.now()
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  const records: unknown[] = [
    { type: 'session', version: 3, id: SESSION_ID, cwd, timestamp: t0 },
    {
      type: 'message',
      id: 'm-user',
      parentId: SESSION_ID,
      timestamp: t0 + 1,
      message: { role: 'user', content: '请渲染这段 Markdown', timestamp: t0 + 1 },
    },
    {
      type: 'message',
      id: 'm-rich',
      parentId: 'm-user',
      timestamp: t0 + 2,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: RICH_MARKDOWN }],
        api: 'openai-responses',
        provider: 'test',
        model: 'test',
        usage,
        stopReason: 'stop',
        timestamp: t0 + 2,
      },
    },
    {
      type: 'message',
      id: 'm-broken',
      parentId: 'm-rich',
      timestamp: t0 + 3,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: FENCE + 'js\nconst unclosed = true // 未闭合的 fence\n' }],
        api: 'openai-responses',
        provider: 'test',
        model: 'test',
        usage,
        stopReason: 'stop',
        timestamp: t0 + 3,
      },
    },
  ]
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

const RICH_MARKDOWN = [
  '# Markdown E2E 标题',
  '',
  '## 二级标题：格式',
  '',
  '正文包含 **粗体**、*斜体* 与 ***粗斜体***，还有 ~~删除线~~、==高亮== 与 `inline code`。',
  '',
  '- 无序项一',
  '- 无序项二',
  '  - 嵌套项',
  '',
  '1. 有序项一',
  '2. 有序项二',
  '',
  '> 引用块：保持冷静，继续编码。',
  '> 第二行引用。',
  '',
  '## 表格与任务',
  '',
  '### 子标题',
  '',
  '| 名称 | 状态 |',
  '| --- | --- |',
  '| 解析 | 完成 |',
  '| 渲染 | 进行中 |',
  '',
  '- [x] 已完成任务',
  '- [ ] 未完成任务',
  '',
  '## 代码块',
  '',
  FENCE + 'ts',
  'const greet = (name: string): string => `Hello, ${name}!`',
  "console.log(greet('pi'))",
  FENCE,
  '',
  FENCE + 'js',
  'const longCodeLine = "' + 'x'.repeat(2000) + '" // 超长行',
  FENCE,
  '',
  '## 链接与 HTML',
  '',
  '访问 [示例站点](https://example.com/docs) 或直接 https://example.com。',
  '',
  '<div style="border:1px solid currentColor;padding:4px">原生 HTML 块</div>',
  '',
  '超长行：' + '长'.repeat(3000),
  '',
].join('\n')

test.describe.serial('Markdown rendering from a seeded session (isolated, no LLM)', () => {
  let app: ElectronApplication
  let page: Page
  let tempRoot: string
  let tempHome: string
  let tempAgent: string
  let tempWorkspace: string
  let wsReal: string
  const pageErrors: string[] = []

  test.beforeAll(async () => {
    if (!existsSync(join(PROJECT_ROOT, 'out', 'main', 'index.js'))) {
      throw new Error('out/main/index.js missing — run `npm run build` first')
    }

    tempRoot = mkdtempSync(join(tmpdir(), 'pi-markdown-e2e-'))
    tempHome = join(tempRoot, 'home')
    tempAgent = join(tempRoot, 'agent')
    tempWorkspace = join(tempRoot, 'workspace')
    for (const dir of [tempHome, tempAgent, tempWorkspace]) mkdirSync(dir)
    writeFileSync(join(tempWorkspace, 'README.md'), '# E2E markdown workspace\n')
    wsReal = realpathSync(tempWorkspace)

    // The app keys session dirs as '--' + cwd (leading separator stripped,
    // every separator and the drive colon collapsed into '-') + '--' — mirror
    // the SDK encoder exactly so the seeded session lands in the right dir on
    // every platform (\ and : matter on Windows).
    const encodedDir = '--' + wsReal.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'
    const dir = join(tempAgent, 'sessions', encodedDir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, SESSION_ID + '.jsonl'), seedJsonl(wsReal))

    const tempUserData = join(tempRoot, 'user-data')
    mkdirSync(tempUserData)
    seedConfiguredEngine(tempUserData, PROJECT_ROOT)
    const env = { ...process.env, HOME: tempHome, PI_CODING_AGENT_DIR: tempAgent, PI_STUDIO_LANG: 'zh', PI_STUDIO_USER_DATA: tempUserData } as Record<string, string>
    delete env.ELECTRON_RENDERER_URL
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      args: [PROJECT_ROOT],
      cwd: tempWorkspace,
      env,
    })
    page = await app.firstWindow()
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await page.waitForSelector('.app', { timeout: 60_000 })
  })

  test.afterAll(async () => {
    await app?.close().catch(() => undefined)
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  })

  async function snapshot(): Promise<Record<string, unknown>> {
    return page.evaluate(() => window.pi.getSnapshot() as unknown as Record<string, unknown>)
  }

  async function resizeTo(width: number): Promise<number> {
    await app.evaluate(({ BrowserWindow }, w) => {
      const win = BrowserWindow.getAllWindows()[0]
      // setContentSize (not setSize) so the web content area is exactly the
      // requested width on every platform (Windows frames + DPI would shave
      // a few px off innerWidth otherwise).
      if (win) win.setContentSize(w, 800)
    }, width)
    await page.waitForTimeout(500)
    return page.evaluate(() => window.innerWidth)
  }

  test('seed session is auto-restored and markdown renders with semantic DOM', async () => {
    const heading = page.getByRole('heading', { level: 1, name: 'Markdown E2E 标题' })
    try {
      await expect(heading).toBeVisible({ timeout: 60_000 })
    } catch (error) {
      const sessionsRoot = join(tempAgent, 'sessions')
      const listing = existsSync(sessionsRoot)
        ? readdirSync(sessionsRoot, { withFileTypes: true })
            .map((d) => (d.isDirectory() ? d.name + '/' : d.name))
            .join(', ')
        : '(no sessions dir)'
      throw new Error(
        `seed session not restored. sessions dir: ${sessionsRoot}; entries: ${listing}; workspace realpath: ${wsReal}`,
        { cause: error },
      )
    }

    // The restored session is the active one and carries all three seeded messages
    const snap = await snapshot()
    expect(snap.activeSessionPath).toContain(SESSION_ID + '.jsonl')
    expect(snap.messages).toHaveLength(3)
    await expect(page.locator('.session-item-active')).toHaveCount(1)

    // Semantic DOM: headings, inline styles, lists, quote, inline code
    await expect(page.getByRole('heading', { level: 2, name: '二级标题：格式' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 3, name: '子标题' })).toBeVisible()
    await expect(page.locator('strong', { hasText: /^粗体$/ })).toHaveCount(1)
    await expect(page.locator('em', { hasText: /^斜体$/ })).toHaveCount(1)
    await expect(page.locator('em strong', { hasText: /^粗斜体$/ })).toHaveCount(1)
    await expect(page.locator('del', { hasText: /^删除线$/ })).toHaveCount(1)
    await expect(page.locator('blockquote', { hasText: '保持冷静' })).toBeVisible()
    await expect(page.locator('ul li', { hasText: '无序项一' })).toBeVisible()
    await expect(page.locator('ol li', { hasText: '有序项一' })).toBeVisible()
    await expect(page.locator('ul ul')).toHaveCount(1) // nested list
    await expect(page.locator('code', { hasText: 'inline code' })).toBeVisible()
    await expect(page.getByText('高亮').first()).toBeVisible() // ==高亮== kept (mark or literal)

    // Code fences with language classes and syntax-highlighted tokens
    const tsCode = page.locator('pre code.language-ts', { hasText: 'greet' })
    await expect(tsCode).toBeVisible()
    const tokenSpans = await tsCode.evaluate((el) => (el as HTMLElement).querySelectorAll('span').length)
    expect(tokenSpans).toBeGreaterThan(0) // syntax highlighting produced token spans
    await expect(page.locator('pre code.language-js', { hasText: 'longCodeLine' })).toBeVisible()

    // Table + task list
    await expect(page.locator('table', { hasText: '解析' })).toBeVisible()
    await expect(page.locator('table tr')).toHaveCount(3)
    const checkboxes = page.locator('input[type="checkbox"]')
    await expect(checkboxes).toHaveCount(2)
    await expect(checkboxes.nth(0)).toBeChecked()
    await expect(checkboxes.nth(1)).not.toBeChecked()

    // Links are https and open safely (new tab, no opener)
    const links = await page
      .locator('a[href^="https://"]')
      .evaluateAll((els) =>
        els.map((a) => {
          const el = a as HTMLAnchorElement
          return { href: el.getAttribute('href'), target: el.target, rel: el.rel }
        }),
      )
    expect(links.length).toBeGreaterThanOrEqual(2)
    expect(links.some((l) => l.href === 'https://example.com/docs')).toBe(true)
    expect(links.some((l) => (l.href ?? '').startsWith('https://example.com'))).toBe(true)
    for (const l of links) {
      expect(l.target).toBe('_blank')
      expect(l.rel).toContain('noopener')
    }

    // Raw HTML is sanitized: rendered as escaped literal text, never executed as DOM
    await expect(
      page.getByText('<div style="border:1px solid currentColor;padding:4px">原生 HTML 块</div>').first(),
    ).toBeVisible()
    expect(await page.locator('div', { hasText: /^原生 HTML 块$/ }).count()).toBe(0)

    // Super-long text line wraps without blowing out the layout
    await expect(page.getByText('超长行：').first()).toBeVisible()
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(pageOverflow).toBeLessThanOrEqual(1)

    // Second assistant block with an unclosed fence still renders without breaking
    await expect(page.getByText('const unclosed = true').first()).toBeVisible()

    expect(pageErrors).toEqual([])
  })

  test('code blocks scroll horizontally without widening the column; copy button gives aria-live feedback', async () => {
    const innerWidth = await page.evaluate(() => window.innerWidth)
    const pres = await page.locator('pre').evaluateAll((els) =>
      els.map((el) => {
        const rect = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return {
          scrollable: el.scrollWidth > el.clientWidth,
          overflowX: cs.overflowX,
          left: rect.left,
          right: rect.right,
          width: rect.width,
        }
      }),
    )
    expect(pres.length).toBeGreaterThanOrEqual(2)
    expect(pres.some((p) => p.scrollable)).toBe(true) // the long js line must overflow
    for (const p of pres) {
      if (p.scrollable) expect(['auto', 'scroll']).toContain(p.overflowX)
      expect(p.right).toBeLessThanOrEqual(innerWidth + 1) // never widens the layout
    }

    // Copy button on a code block: click it, then expect feedback in an aria-live region
    let copyBtn: Locator | null = null
    for (const sel of [
      'button[aria-label*="复制"]',
      'button[title*="复制"]',
      'button[class*="copy" i]',
      '[class*="copy" i] button',
      '[class*="code" i] button',
      'pre button',
    ]) {
      const loc = page.locator(sel).first()
      if ((await loc.count()) > 0) {
        copyBtn = loc
        break
      }
    }
    expect(copyBtn, 'a copy button should exist on a code block').not.toBeNull()
    await copyBtn!.click()
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            for (const el of document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')) {
              if (/复制|已复制|copied/i.test(el.textContent ?? '')) return true
            }
            return false
          }),
        { timeout: 10_000, message: 'copy click should surface feedback in an aria-live region' },
      )
      .toBe(true)
    expect(pageErrors).toEqual([])
  })

  test('light/dark themes render distinct styles; 1400px screenshots', async () => {
    await page.emulateMedia({ colorScheme: 'light' })
    const width = await resizeTo(1400)
    expect(width).toBeGreaterThanOrEqual(1390)

    const styleOf = (sel: string, prop: string) =>
      page.evaluate(
        ([s, p]) => getComputedStyle(document.querySelector(s) as HTMLElement).getPropertyValue(p),
        [sel, prop] as const,
      )
    // Code-block background may live on the <pre> or an ancestor; find the first non-transparent one.
    const codeBg = (sel: string) =>
      page.evaluate((s) => {
        let el: HTMLElement | null = document.querySelector(s)
        while (el) {
          const bg = getComputedStyle(el).backgroundColor
          if (bg && bg !== 'rgba(0, 0, 0, 0)') return bg
          el = el.parentElement
        }
        return 'rgba(0, 0, 0, 0)'
      }, sel)
    await page.waitForTimeout(400)
    const lightAppBg = await styleOf('.app', 'background-color')
    const lightCodeBg = await codeBg('pre')
    await page.screenshot({ path: join(SCREENSHOTS, 'markdown-light.png') })

    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForTimeout(600)
    const darkAppBg = await styleOf('.app', 'background-color')
    const darkCodeBg = await codeBg('pre')
    expect(darkAppBg).not.toBe(lightAppBg)
    expect(darkCodeBg).not.toBe(lightCodeBg)
    await page.screenshot({ path: join(SCREENSHOTS, 'markdown-dark.png') })

    expect(pageErrors).toEqual([])
  })
})
