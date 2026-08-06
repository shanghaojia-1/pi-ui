import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '../..')
const SCREENSHOTS = join(PROJECT_ROOT, 'artifacts', 'screenshots')

const SESSION_ID = 'sess_telemetry_seed'

/** JSONL v3 seed: session header + user message + one assistant message carrying real usage. */
function seedJsonl(cwd: string): string {
  const t0 = Date.now()
  const usage = {
    input: 1000,
    output: 240,
    cacheRead: 500,
    cacheWrite: 100,
    totalTokens: 1840,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  const records: unknown[] = [
    { type: 'session', version: 3, id: SESSION_ID, cwd, timestamp: t0 },
    {
      type: 'message',
      id: 'm-user',
      parentId: SESSION_ID,
      timestamp: t0 + 1,
      message: { role: 'user', content: 'telemetry seed prompt', timestamp: t0 + 1 },
    },
    {
      type: 'message',
      id: 'm-assistant',
      parentId: 'm-user',
      timestamp: t0 + 2,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello from seeded telemetry session' }],
        api: 'openai-responses',
        provider: 'test',
        model: 'test',
        usage,
        stopReason: 'stop',
        timestamp: t0 + 2,
      },
    },
  ]
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

test.describe.serial('Settings visuals & telemetry from a seeded session (isolated, no LLM)', () => {
  let app: ElectronApplication
  let page: Page
  let tempRoot: string
  let tempHome: string
  let tempAgent: string
  let tempWorkspace: string
  let wsReal: string
  let lightAppBg = ''
  const pageErrors: string[] = []

  test.beforeAll(async () => {
    if (!existsSync(join(PROJECT_ROOT, 'out', 'main', 'index.js'))) {
      throw new Error('out/main/index.js missing — run `npm run build` first')
    }
    mkdirSync(SCREENSHOTS, { recursive: true })

    tempRoot = mkdtempSync(join(tmpdir(), 'pi-settings-e2e-'))
    tempHome = join(tempRoot, 'home')
    tempAgent = join(tempRoot, 'agent')
    tempWorkspace = join(tempRoot, 'workspace')
    for (const dir of [tempHome, tempAgent, tempWorkspace]) mkdirSync(dir)
    writeFileSync(join(tempWorkspace, 'README.md'), '# E2E settings workspace\n')
    wsReal = realpathSync(tempWorkspace)

    // Session dir keyed by realpath cwd, exactly like the markdown spec's helper.
    const encodedDir = '--' + wsReal.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'
    const dir = join(tempAgent, 'sessions', encodedDir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, SESSION_ID + '.jsonl'), seedJsonl(wsReal))

    const tempUserData = join(tempRoot, 'user-data')
    mkdirSync(tempUserData)
    const env = { ...process.env, HOME: tempHome, PI_CODING_AGENT_DIR: tempAgent, PI_STUDIO_LANG: 'zh', PI_STUDIO_USER_DATA: tempUserData } as Record<string, string>
    delete env.ELECTRON_RENDERER_URL
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

  async function resizeTo(width: number, height: number): Promise<number> {
    await app.evaluate(({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) win.setSize(w, h)
    }, [width, height] as const)
    await page.waitForTimeout(500)
    return page.evaluate(() => window.innerWidth)
  }

  async function assertDialogInViewport(dialog: Locator): Promise<void> {
    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(vp.w + 1)
    expect(box!.y + box!.height).toBeLessThanOrEqual(vp.h + 1)
  }

  async function expectFocusInDialog(): Promise<void> {
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            for (const d of document.querySelectorAll('[role="dialog"]')) {
              const label = d.getAttribute('aria-label') ?? ''
              if (label.includes('设置') || (d.textContent ?? '').includes('设置')) {
                return d.contains(document.activeElement)
              }
            }
            return false
          }),
        { timeout: 10_000, message: 'focus should move into the settings dialog' },
      )
      .toBe(true)
  }

  async function assertProvidersEntry(dialog: Locator): Promise<void> {
    // The settings page offers entry points (New provider / refresh) plus a
    // read-only list of already-configured providers; the active provider is
    // chosen in the chat dialog, and there is no interactive key panel here.
    await expect(dialog.getByRole('button', { name: '新建供应商' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /刷新模型列表/ })).toBeVisible()
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0)
    await expect(dialog.locator('.sett-provider-search')).toHaveCount(0)
  }

  test('telemetry bar: seeded usage renders cache hit & recent output 240, speed stays dash, bar fits conversation', async () => {
    await page.emulateMedia({ colorScheme: 'light' })
    await resizeTo(1400, 900)

    // Seeded session is auto-restored; the assistant message is rendered.
    await expect(page.getByText('hello from seeded telemetry session').first()).toBeVisible({ timeout: 60_000 })

    const bar = page.locator('.telemetry-bar')
    await expect(bar).toBeVisible()

    const itemOf = (label: string) => bar.locator('.telemetry-item', { hasText: label }).locator('.telemetry-value')

    // Cache-hit cell must show a real value, not the null-state em dash.
    const cacheCell = itemOf('缓存命中')
    await expect
      .poll(() => cacheCell.textContent(), { timeout: 10_000, message: 'cache hit should show a value' })
      .not.toBe('—')
    const cacheText = await cacheCell.textContent()
    expect(cacheText).toMatch(/\d/)

    // Speed (token-rate history) has no timing data in the seed → em dash.
    await expect(bar.locator('.telemetry-speed .telemetry-value')).toHaveText('—')

    // Recent output shows the seeded 240 tokens.
    const outputText = await itemOf('最近输出').textContent()
    expect(outputText).toContain('240')

    // Context may legitimately be a dash when no context window is known.
    const contextText = await itemOf('上下文').textContent()
    expect(contextText === '—' || /\d/.test(contextText ?? '')).toBe(true)

    // Snapshot telemetry mirrors the DOM.
    const snap = await snapshot()
    const telemetry = snap.telemetry as Record<string, unknown>
    expect(telemetry.cacheHitRate).toBeGreaterThan(0)
    expect(telemetry.latestOutputTokens).toBe(240)
    expect(telemetry.tokenRate).toBeNull()
    expect(telemetry.tokenRateKind).toBe('unavailable')
    const contextTokens = telemetry.contextTokens as number | null
    expect(contextTokens === null || contextTokens >= 0).toBe(true)

    // The bar must not be wider than the conversation column it sits above.
    const barBox = await bar.boundingBox()
    const convoBox = await page.locator('.conversation').first().boundingBox()
    expect(barBox).not.toBeNull()
    expect(convoBox, 'conversation container should exist').not.toBeNull()
    expect(barBox!.width).toBeLessThanOrEqual(convoBox!.width + 1)
    expect(barBox!.x).toBeGreaterThanOrEqual(convoBox!.x - 1)

    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SCREENSHOTS, 'telemetry-bar.png') })
    expect(pageErrors).toEqual([])
  })

  test('settings dialog light: opens in viewport, focus inside, close restores; light screenshot', async () => {
    await page.emulateMedia({ colorScheme: 'light' })
    await resizeTo(1400, 900)
    await page.waitForTimeout(400)

    const settingsBtn = page.getByRole('button', { name: '设置', exact: true })
    await settingsBtn.click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('button', { name: '保存默认设置' })).toBeVisible()

    await assertDialogInViewport(dialog)
    await expectFocusInDialog()
    await assertProvidersEntry(dialog)

    lightAppBg = await page.evaluate(() => getComputedStyle(document.querySelector('.app') as HTMLElement).backgroundColor)
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SCREENSHOTS, 'settings-light.png') })

    // Closing the dialog restores focus to the trigger.
    await page.getByRole('button', { name: '关闭设置' }).click()
    await expect(dialog).not.toBeVisible()
    await expect(settingsBtn).toBeFocused()
    expect(pageErrors).toEqual([])
  })

  test('settings dialog dark: distinct theme, in viewport, focus inside, close restores; dark screenshot', async () => {
    await page.emulateMedia({ colorScheme: 'dark' })
    expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true)
    await resizeTo(1400, 900)
    await page.waitForTimeout(400)

    const settingsBtn = page.getByRole('button', { name: '设置', exact: true })
    await settingsBtn.click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('button', { name: '保存默认设置' })).toBeVisible()

    await assertDialogInViewport(dialog)
    await expectFocusInDialog()
    await assertProvidersEntry(dialog)

    const darkBg = await page.evaluate(() => getComputedStyle(document.querySelector('.app') as HTMLElement).backgroundColor)
    expect(darkBg).not.toBe(lightAppBg)
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SCREENSHOTS, 'settings-dark.png') })

    await page.getByRole('button', { name: '关闭设置' }).click()
    await expect(dialog).not.toBeVisible()
    await expect(settingsBtn).toBeFocused()
    expect(pageErrors).toEqual([])
  })
})
