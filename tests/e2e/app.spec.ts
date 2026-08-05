import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '../..')
const SCREENSHOTS = join(PROJECT_ROOT, 'artifacts', 'screenshots')

const API_METHODS = [
  'abort', 'chooseWorkspace', 'getSettings', 'getSnapshot', 'logoutProvider',
  'newSession', 'onSnapshot', 'openSession', 'openWorkspace', 'refreshModels',
  'sendPrompt', 'setModel', 'setRuntimeApiKey', 'setThinking', 'setToolApprovalMode',
  'updateSettings',
].sort()

test.describe.serial('Pi Studio sandbox (isolated agent dir, no LLM)', () => {
  let app: ElectronApplication
  let page: Page
  let tempRoot: string
  let tempHome: string
  let tempAgent: string
  let tempWorkspace: string
  const pageErrors: string[] = []

  test.beforeAll(async () => {
    if (!existsMain()) throw new Error('out/main/index.js missing — run `npm run build` first')

    tempRoot = mkdtempSync(join(tmpdir(), 'pi-studio-e2e-'))
    tempHome = join(tempRoot, 'home')
    tempAgent = join(tempRoot, 'agent')
    tempWorkspace = join(tempRoot, 'workspace')
    for (const dir of [tempHome, tempAgent, tempWorkspace]) mkdirSync(dir)
    writeFileSync(join(tempWorkspace, 'README.md'), '# E2E sandbox workspace\n')

    const env = { ...process.env, HOME: tempHome, PI_CODING_AGENT_DIR: tempAgent } as Record<string, string>
    delete env.ELECTRON_RENDERER_URL
    app = await _electron.launch({
      args: [PROJECT_ROOT],
      cwd: tempWorkspace,
      env,
    })
    page = await app.firstWindow()
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    // Splash -> app shell; the workspace is initialized from process.cwd() (tempWorkspace)
    await page.waitForSelector('.app', { timeout: 60_000 })
    await expect(page.getByText('未找到可用模型', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
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
      if (win) win.setSize(w, 800)
    }, width)
    await page.waitForTimeout(500)
    return page.evaluate(() => window.innerWidth)
  }

  async function ensurePanelsOpen(): Promise<void> {
    for (const [openName, closeName] of [
      ['展开侧栏', '收起侧栏'],
      ['展开活动面板', '收起活动面板'],
    ] as const) {
      const open = page.getByRole('button', { name: openName })
      if (await open.isVisible()) await open.click()
      await expect(page.getByRole('button', { name: closeName })).toHaveAttribute('aria-pressed', 'true')
    }
  }

  test('sandbox: window.pi exposes the full contract and getSnapshot matches it', async () => {
    const api = await page.evaluate(() => ({
      type: typeof window.pi,
      methods: Object.keys(window.pi).sort(),
    }))
    expect(api.type).toBe('object')
    expect(api.methods).toEqual(API_METHODS)

    const snap = await snapshot()
    // Workspace resolved from launch cwd (realpath-normalized)
    expect(snap.workspace).toMatchObject({ path: realpathSync(tempWorkspace), name: 'workspace' })
    expect(snap.activeSessionPath).toBeTruthy()
    expect(snap.sessions).toEqual(expect.any(Array))
    expect(snap.models).toEqual([]) // empty agent dir -> no models, no network calls
    // session still binds a fallback model marker (no real provider) — that is the
    // "model fallback" state the UI surfaces
    expect(snap.activeModel === null || snap.activeModel === 'unknown:unknown').toBe(true)
    // no model -> SDK clamps thinking level to 'off' (agent-session getter); 'medium' only when a model is bound
    expect(snap.thinkingLevel).toBe('off')
    expect(snap.messages).toEqual([])
    expect(snap.runState).toBe('idle')
    expect(snap.statusText).toBe('Ready')
    expect(snap.queueCount).toBe(0)
    expect(snap.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })
    // startup may surface a model-fallback warning, but nothing else
    expect(snap.error === null || /model/i.test((snap.error as { message: string }).message)).toBe(true)
  })

  test('wide layout: sidebar / main / right panel / topbar / statusbar all present', async () => {
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.locator('.right-panel')).toBeVisible()
    await expect(page.locator('.topbar')).toBeVisible()
    await expect(page.locator('.statusbar')).toBeVisible()
    const sidebarBox = await page.locator('.sidebar').boundingBox()
    const rightBox = await page.locator('.right-panel').boundingBox()
    expect(sidebarBox && sidebarBox.width).toBeGreaterThan(200)
    expect(rightBox && rightBox.width).toBeGreaterThan(300)
    await expect(page.getByRole('button', { name: '收起侧栏' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: '收起活动面板' })).toHaveAttribute('aria-pressed', 'true')
    // Right panel empty state
    await expect(page.getByText('暂无活动')).toBeVisible()
    // Topbar model placeholder for the no-model state
    await expect(page.getByText('无可用模型')).toBeVisible()
  })

  test('no-model state: warning banner, disabled composer, safe Cmd/Ctrl+K', async () => {
    await expect(page.getByText('未找到可用模型', { exact: true }).first()).toBeVisible()
    await expect(page.locator('.banner-zone')).toHaveAttribute('aria-live', 'polite')

    const composer = page.getByRole('textbox', { name: '消息输入' })
    await expect(composer).toBeDisabled()
    await expect(composer).toHaveAttribute('placeholder', '未找到可用模型，请检查 API 鉴权')
    await expect(page.getByRole('button', { name: '发送' })).toBeDisabled()

    // New session button is enabled (workspace exists) but composer stays disabled
    await expect(page.getByRole('button', { name: /新任务/ })).toBeEnabled()

    // Accessibility landmarks
    await expect(page.locator('.sidebar-sessions')).toHaveAttribute('aria-label', '会话列表')
    await expect(page.getByRole('status').first()).toContainText('就绪') // idle run-pill label

    // Cmd/Ctrl+K must not throw even though the composer is disabled
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
    await page.waitForTimeout(300)
    expect(pageErrors).toEqual([])
  })

  test('IPC validation: illegal thinking levels / prompt args are rejected safely', async () => {
    const before = await snapshot()

    for (const bad of ['bogus', '', 'MAX', 'off ', 42, null, undefined]) {
      const outcome = await page.evaluate(
        (v) => window.pi.setThinking(v as never).then(() => 'resolved', (e: Error) => e.message),
        bad,
      )
      expect(outcome).toContain('Invalid thinking level')
    }

    // Valid level round-trips through main and back; no model -> SDK clamps any level to 'off'
    const after = await page.evaluate(() => window.pi.setThinking('max'))
    expect(after.thinkingLevel).toBe('off')
    await page.evaluate(() => window.pi.setThinking('medium'))

    // Non-string and oversized prompts rejected before reaching any run
    const nonString = await page.evaluate(
      () => window.pi.sendPrompt(123 as never).then(() => 'resolved', (e: Error) => e.message),
    )
    expect(nonString).toContain('Invalid prompt')
    const oversized = await page.evaluate(
      () => window.pi.sendPrompt('x'.repeat(100_001)).then(() => 'resolved', (e: Error) => e.message),
    )
    expect(oversized).toContain('Invalid prompt')

    // Whitespace-only prompt is a safe no-op (never runs the agent)
    const noop = await page.evaluate(async () => {
      await window.pi.sendPrompt('   ')
      return window.pi.getSnapshot()
    })
    expect(noop.messages).toEqual([])
    expect(noop.runState).toBe('idle')

    // Non-string workspace/session args rejected
    for (const [method, arg] of [
      ['openWorkspace', 42],
      ['openSession', {}],
    ] as const) {
      const outcome = await page.evaluate(
        ([m, a]) =>
          (window.pi as unknown as Record<string, (x: unknown) => Promise<unknown>>)[m]!(a).then(
            () => 'resolved',
            (e: Error) => e.message,
          ),
        [method, arg] as const,
      )
      expect(outcome).toContain('Invalid')
    }

    // Main process survived all rejections; app state unchanged
    const afterAll = await snapshot()
    expect(afterAll.messages).toEqual([])
    expect(afterAll.runState).toBe('idle')
    expect(afterAll.error).toEqual(before.error)
    expect(afterAll.thinkingLevel).toBe('off') // no model -> always clamped to 'off'
  })

  test('new session is safe offline and reflected in the sidebar', async () => {
    const before = await snapshot()
    expect(before.activeSessionPath).toBeTruthy()

    await page.getByRole('button', { name: /新任务/ }).click()

    await expect.poll(() => page.evaluate(() => window.pi.getSnapshot().then((s) => s.activeSessionPath))).not.toBe(
      before.activeSessionPath,
    )
    const after = await snapshot()
    expect(after.messages).toEqual([])
    expect(after.runState).toBe('idle')
    // a fresh session with no models surfaces the recoverable model-fallback notice
    expect(after.error === null || (after.error as { message: string }).message === 'Model fallback').toBe(true)
    await expect(page.locator('.session-item-active')).toHaveCount(1)
    expect(pageErrors).toEqual([])
  })

  test('settings dialog: default toggles/timeout persist via API, reopen, and new session (no LLM)', async () => {
    // 1) Open the dialog from the sidebar; defaults are editable even with no providers.
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('button', { name: '保存默认设置' })).toBeVisible()

    // 2) Toggle both default switches and set the idle timeout (seconds→ms on save).
    await page.getByLabel('自动重试').check()
    await page.getByLabel('自动压缩上下文').check()
    await page.getByLabel('HTTP 空闲超时（秒）').fill('120')
    await page.getByRole('button', { name: '保存默认设置' }).click()
    await expect(page.getByText('默认设置已保存')).toBeVisible()

    // 3) Persisted values are visible through the API…
    const saved = await page.evaluate(() => window.pi.getSettings())
    expect(saved.retryEnabled).toBe(true)
    expect(saved.compactionEnabled).toBe(true)
    expect(saved.httpIdleTimeoutMs).toBe(120_000)
    expect(saved.keyPersistence).toBe('runtime-only') // keys are never persisted by contract
    // No providers/models exist: the patch must have omitted provider/model
    // entirely (never null, never empty strings) and the save still succeeded.
    expect(saved.defaultProvider).toBe(null)
    expect(saved.defaultModel).toBe(null)

    // 4) …and survive a dialog reopen (draft reloaded from the agent dir).
    await page.getByRole('button', { name: '关闭设置' }).click()
    await expect(dialog).not.toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByLabel('自动重试')).toBeChecked()
    await expect(page.getByLabel('自动压缩上下文')).toBeChecked()
    await expect(page.getByLabel('HTTP 空闲超时（秒）')).toHaveValue('120')
    await page.getByRole('button', { name: '关闭设置' }).click()

    // 5) Settings live in the agent dir, not the session: a fresh session reloads them.
    await page.getByRole('button', { name: /新任务/ }).click()
    await expect
      .poll(() => page.evaluate(() => window.pi.getSettings().then((s) => s.retryEnabled)))
      .toBe(true)

    // 6) This test never runs the agent: no messages, idle state, zero usage.
    const snap = await snapshot()
    expect(snap.messages).toEqual([])
    expect(snap.runState).toBe('idle')
    expect(snap.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })
  })

  test('telemetry bar: five metrics present, null-state dashes, zero LLM traffic', async () => {
    const bar = page.locator('.telemetry-bar')
    await expect(bar).toBeVisible()
    for (const label of ['速度', '缓存命中', '上下文', 'TTFT', '最近输出']) {
      await expect(bar.getByText(label, { exact: true })).toBeVisible()
    }
    // No run has ever happened: speed/cache/TTFT/output are null → em dashes.
    await expect(bar.locator('.telemetry-speed .telemetry-value')).toHaveText('—')
    expect(await bar.locator('.telemetry-na').count()).toBeGreaterThanOrEqual(4)
    const snap = await snapshot()
    const telemetry = snap.telemetry as Record<string, unknown>
    expect(telemetry.tokenRate).toBeNull()
    expect(telemetry.tokenRateKind).toBe('unavailable')
    expect(telemetry.ttftMs).toBeNull()
    expect(telemetry.cacheHitRate).toBeNull()
    expect(telemetry.latestOutputTokens).toBeNull()
    expect(telemetry).toHaveProperty('contextTokens')
    expect(telemetry).toHaveProperty('contextWindow')
    expect(telemetry).toHaveProperty('contextPercent')
    // The whole suite never invokes the LLM: no messages, idle state, no tokens billed.
    expect(snap.messages).toEqual([])
    expect(snap.runState).toBe('idle')
    expect(snap.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })
  })

  test('narrow viewport collapses the right panel; screenshots for all themes', async () => {
    // 1) wide-light (default 1480x920, both panels open)
    const wide = await resizeTo(1480)
    expect(wide).toBeGreaterThan(1200)
    await ensurePanelsOpen()
    await page.waitForTimeout(400) // let grid transition settle
    // Settings first screen (scroll-position assertion; no dedicated
    // screenshot): with the provider list height-capped, the API Key note
    // and the defaults section fit in the initial viewport unscrolled.
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settingsDialog = page.getByRole('dialog', { name: '设置' })
    await expect(settingsDialog).toBeVisible()
    const viewportHeight = await page.evaluate(() => window.innerHeight)
    for (const heading of ['API Key（仅本次运行）', '默认设置']) {
      const box = await page.getByRole('heading', { name: heading, exact: true }).boundingBox()
      expect(box).not.toBeNull()
      expect((box as { y: number; height: number }).y).toBeGreaterThanOrEqual(0)
      expect((box as { y: number; height: number }).y + (box as { y: number; height: number }).height).toBeLessThanOrEqual(
        viewportHeight,
      )
    }
    await page.getByRole('button', { name: '关闭设置' }).click()
    await expect(settingsDialog).not.toBeVisible()
    const lightBg = await page.evaluate(() => getComputedStyle(document.querySelector('.app') as HTMLElement).backgroundColor)
    await page.screenshot({ path: join(SCREENSHOTS, 'wide-light.png') })

    // 2) narrow-light (1024px <= 1080px breakpoint -> right panel closes, sidebar stays)
    const narrow = await resizeTo(1024)
    expect(narrow).toBeLessThanOrEqual(1080)
    await expect(page.getByRole('button', { name: '展开活动面板' })).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('button', { name: '收起侧栏' })).toHaveAttribute('aria-pressed', 'true')
    // The collapsed right column (0px grid track) must not leave a clickable
    // drag overlay behind: its strip has no box, and points below the topbar on
    // the far right never hit a drag region or a hidden-column element.
    const rightCol = await page.locator('.app-col-right').boundingBox()
    expect(rightCol === null || rightCol.width === 0).toBe(true)
    const rightStripBox = await page.locator('.app-col-right .drag-strip').boundingBox()
    // The strip's border-box may still measure 1px (its border-left) even though
    // the 0px-wide column clips it fully off-screen: it must never be reachable.
    expect(rightStripBox === null || rightStripBox.x >= narrow || rightStripBox.width === 0).toBe(true)
    // Strips never overlap content: only the sidebar + center strips are on-screen
    // (their box starts inside the viewport) and the topbar still starts below them.
    const narrowStripInfo = await page.locator('.drag-strip').evaluateAll((els) =>
      els.map((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect()
        return { left: rect.left, width: rect.width, bottom: rect.top + rect.height }
      }),
    )
    const visibleStrips = narrowStripInfo.filter((s) => s.width > 0 && s.left < narrow)
    expect(visibleStrips).toHaveLength(2)
    const narrowTopbarY = (await page.locator('.topbar').boundingBox())?.y ?? 0
    for (const s of visibleStrips) expect(narrowTopbarY).toBeGreaterThanOrEqual(s.bottom - 1)
    const hits = await page.evaluate(
      ([x, y]) =>
        document.elementsFromPoint(x, y).map((el) => ({
          cls: typeof el.className === 'string' ? el.className : '',
          region: getComputedStyle(el).getPropertyValue('-webkit-app-region').trim(),
        })),
      [narrow - 4, 120] as const,
    )
    for (const hit of hits) {
      expect(hit.region).not.toBe('drag')
      expect(hit.cls).not.toContain('app-col-right')
    }
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SCREENSHOTS, 'narrow-light.png') })

    // compact breakpoint (<= 780px) only if the window min width allows it
    const compact = await resizeTo(760)
    if (compact < 780) {
      await expect(page.getByRole('button', { name: '展开侧栏' })).toHaveAttribute('aria-pressed', 'false')
    }

    // 3) wide-dark via emulated color scheme (must actually take effect)
    await page.emulateMedia({ colorScheme: 'dark' })
    const darkMatches = await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)
    expect(darkMatches).toBe(true)
    await resizeTo(1480)
    await ensurePanelsOpen()
    await page.waitForTimeout(400)
    const darkBg = await page.evaluate(() => getComputedStyle(document.querySelector('.app') as HTMLElement).backgroundColor)
    expect(darkBg).not.toBe(lightBg)
    await page.screenshot({ path: join(SCREENSHOTS, 'wide-dark.png') })

    expect(pageErrors).toEqual([])
  })

  test('macOS window shell: platform contract, 3 drag strips, no-drag surfaces, movable, shell screenshot', async () => {
    test.skip(process.platform !== 'darwin', 'window-shell layout is macOS-only; other platforms keep the native frame')

    await page.emulateMedia({ colorScheme: 'light' })
    await resizeTo(1480)
    await ensurePanelsOpen()
    await page.waitForTimeout(400)

    // Preload contract: host platform comes from process.platform, never UA.
    expect(await page.evaluate(() => window.desktop.platform)).toBe('darwin')
    // Root marker: data-platform attribute + platform class on the app shell.
    await expect(page.locator('.app')).toHaveAttribute('data-platform', 'darwin')
    await expect(page.locator('.app')).toHaveClass(/platform-darwin/)

    // Three drag strips (sidebar / main / right column), each ~44px and draggable.
    const strips = page.locator('.drag-strip')
    await expect(strips).toHaveCount(3)
    const stripInfo = await strips.evaluateAll((els) =>
      els.map((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect()
        return {
          top: rect.top, height: rect.height, width: rect.width,
          region: getComputedStyle(el).getPropertyValue('-webkit-app-region').trim(),
        }
      }),
    )
    for (const s of stripInfo) {
      expect(Math.abs(s.height - 44)).toBeLessThanOrEqual(1)
      expect(s.width).toBeGreaterThan(0)
      expect(s.region).toBe('drag')
    }

    // Interactive surfaces must never be swallowed by a drag region.
    const regionOf = async (locator: ReturnType<Page['locator']>): Promise<string> =>
      (await locator.evaluate((el) => getComputedStyle(el as HTMLElement).getPropertyValue('-webkit-app-region'))).trim()
    expect(await regionOf(page.locator('.sidebar-workspace'))).not.toBe('drag')
    expect(await regionOf(page.locator('.sidebar-actions .btn').first())).toBe('no-drag')
    expect(await regionOf(page.locator('.select-trigger').first())).toBe('no-drag')
    expect(await regionOf(page.locator('.composer-input'))).toBe('no-drag')

    // Content starts at/after the strip bottom (44px), clear of the traffic
    // lights (native lights sit at ~(18,18), i.e. inside the strip band).
    const topbarY = (await page.locator('.topbar').boundingBox())?.y ?? 0
    const workspaceY = (await page.locator('.sidebar-workspace').boundingBox())?.y ?? 0
    for (const s of stripInfo) {
      expect(topbarY).toBeGreaterThanOrEqual(s.top + s.height - 1)
      expect(workspaceY).toBeGreaterThanOrEqual(s.top + s.height - 1)
    }

    // Key buttons remain clickable and focusable.
    const toggle = page.getByRole('button', { name: '收起侧栏' })
    await toggle.click()
    await expect(page.getByRole('button', { name: '展开侧栏' })).toHaveAttribute('aria-pressed', 'false')
    await page.getByRole('button', { name: '展开侧栏' }).click()
    await expect(page.getByRole('button', { name: '收起侧栏' })).toHaveAttribute('aria-pressed', 'true')
    const selectTrigger = page.locator('.select-trigger').first()
    await selectTrigger.focus()
    expect(await page.evaluate(() => document.activeElement?.className)).toContain('select-trigger')

    // BrowserWindow must be user-movable on macOS.
    const movable = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMovable() ?? false)
    expect(movable).toBe(true)

    // NOTE: page.screenshot() captures only the web contents — the native
    // traffic lights live in the window frame and are not part of the page.
    // The 44px drag strip visible at the top of the shot demonstrates the
    // safety band where the traffic lights float.
    await page.screenshot({ path: join(SCREENSHOTS, 'macos-window-shell.png') })

    expect(pageErrors).toEqual([])
  })

  function existsMain(): boolean {
    return existsSync(join(PROJECT_ROOT, 'out', 'main', 'index.js'))
  }
})

test.describe.serial('Managed mode (tool approval) — isolated, no LLM', () => {
  let app: ElectronApplication
  let page: Page
  let tempRoot: string
  let tempHome: string
  let tempAgent: string
  let tempWorkspace: string
  const pageErrors: string[] = []

  async function launch(): Promise<void> {
    const env = { ...process.env, HOME: tempHome, PI_CODING_AGENT_DIR: tempAgent } as Record<string, string>
    delete env.ELECTRON_RENDERER_URL
    app = await _electron.launch({ args: [PROJECT_ROOT], cwd: tempWorkspace, env })
    page = await app.firstWindow()
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await page.waitForSelector('.app', { timeout: 60_000 })
  }

  /** Control the native ask→managed confirmation inside main. */
  async function stubNativeConfirm(accept: boolean): Promise<void> {
    // app.evaluate serializes the function into main: a closure variable is
    // not defined there, so the flag must be passed as an explicit argument.
    await app.evaluate(({ dialog }, ok) => {
      dialog.showMessageBox = async () =>
        ({ response: ok ? 0 : 1, checkboxChecked: false }) as Awaited<ReturnType<typeof dialog.showMessageBox>>
    }, accept)
  }

  async function openApprovalSection() {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()
    const section = dialog.locator('[data-sett-approval]')
    await section.scrollIntoViewIfNeeded()
    await expect(dialog.getByRole('heading', { name: /工具审批/ })).toBeVisible()
    return dialog
  }

  test.beforeAll(async () => {
    if (!existsSync(join(PROJECT_ROOT, 'out', 'main', 'index.js'))) {
      throw new Error('out/main/index.js missing — run `npm run build` first')
    }
    tempRoot = mkdtempSync(join(tmpdir(), 'pi-managed-e2e-'))
    tempHome = join(tempRoot, 'home')
    tempAgent = join(tempRoot, 'agent')
    tempWorkspace = join(tempRoot, 'workspace')
    for (const dir of [tempHome, tempAgent, tempWorkspace]) mkdirSync(dir)
    writeFileSync(join(tempWorkspace, 'README.md'), '# E2E managed-mode workspace\n')
    await launch()
  })

  test.afterAll(async () => {
    await app?.close().catch(() => undefined)
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  })

  test('isolated env defaults to ask: snapshot, neutral badge, switch off', async () => {
    const snap = await page.evaluate(() => window.pi.getSnapshot())
    expect(snap.toolApprovalMode).toBe('ask')
    const badge = page.getByRole('button', { name: /工具审批/ })
    await expect(badge).toBeVisible()
    await expect(badge).toHaveClass(/approval-badge-ask/)
    await expect(badge).toContainText('逐次确认')

    const dialog = await openApprovalSection()
    await expect(dialog.getByRole('switch')).not.toBeChecked()
    await expect(dialog.getByText(/每次执行 bash \/ edit \/ write 前都会向你确认/)).toBeVisible()
    await page.getByRole('button', { name: '关闭设置' }).click()

    // never ran the agent: no messages, idle, zero usage
    expect(snap.messages).toEqual([])
    expect(snap.runState).toBe('idle')
    expect(snap.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })
    expect(pageErrors).toEqual([])
  })

  test('cancelled native confirmation: stays ask, switch stays off, 已取消 shown', async () => {
    await stubNativeConfirm(false)
    const dialog = await openApprovalSection()
    await dialog.getByRole('switch').click()
    await expect(dialog.getByText(/已取消：未开启全托管模式/)).toBeVisible()
    await expect(dialog.getByRole('switch')).not.toBeChecked()
    const snap = await page.evaluate(() => window.pi.getSnapshot())
    expect(snap.toolApprovalMode).toBe('ask')
    await expect(page.getByRole('button', { name: /工具审批/ })).toHaveClass(/approval-badge-ask/)
    await page.getByRole('button', { name: '关闭设置' }).click()
    expect(pageErrors).toEqual([])
  })

  test('confirmed enable: badge flips to managed, switch on, snapshot managed', async () => {
    await stubNativeConfirm(true)
    const dialog = await openApprovalSection()
    await dialog.getByRole('switch').click()
    await expect(dialog.getByRole('switch')).toBeChecked()
    await expect(dialog.getByText('已开启全托管模式')).toBeVisible()
    await expect(dialog.getByText(/不再逐次确认；使用当前用户权限；不是沙箱/)).toBeVisible()
    const snap = await page.evaluate(() => window.pi.getSnapshot())
    expect(snap.toolApprovalMode).toBe('managed')
    const badge = page.getByRole('button', { name: /工具审批/ })
    await expect(badge).toHaveClass(/approval-badge-managed/)
    await expect(badge).toContainText('全托管 · 非沙箱')
    await page.getByRole('button', { name: '关闭设置' }).click()
    expect(pageErrors).toEqual([])
  })

  test('restart with the same userData restores managed mode', async () => {
    await app.close().catch(() => undefined)
    await launch()
    const snap = await page.evaluate(() => window.pi.getSnapshot())
    expect(snap.toolApprovalMode).toBe('managed')
    const badge = page.getByRole('button', { name: /工具审批/ })
    await expect(badge).toHaveClass(/approval-badge-managed/)
    await expect(badge).toContainText('全托管 · 非沙箱')
    expect(pageErrors).toEqual([])
  })

  test('disabling is immediate (no native confirm) and survives a restart as ask', async () => {
    const dialog = await openApprovalSection()
    await dialog.getByRole('switch').click()
    await expect(dialog.getByRole('switch')).not.toBeChecked()
    await expect(dialog.getByText('已关闭全托管模式')).toBeVisible()
    const snap = await page.evaluate(() => window.pi.getSnapshot())
    expect(snap.toolApprovalMode).toBe('ask')
    await page.getByRole('button', { name: '关闭设置' }).click()

    await app.close().catch(() => undefined)
    await launch()
    const after = await page.evaluate(() => window.pi.getSnapshot())
    expect(after.toolApprovalMode).toBe('ask')
    await expect(page.getByRole('button', { name: /工具审批/ })).toHaveClass(/approval-badge-ask/)
    expect(pageErrors).toEqual([])
  })

  test('managed-mode.png: danger partition in settings plus the managed topbar badge', async () => {
    // The previous test left the store at ask — re-enable managed for the shot.
    await stubNativeConfirm(true)
    const dialog = await openApprovalSection()
    await dialog.getByRole('switch').click()
    await expect(dialog.getByRole('switch')).toBeChecked()
    await expect(dialog.getByText('已开启全托管模式')).toBeVisible()
    await page.getByRole('button', { name: '关闭设置' }).click()
    await expect(page.getByRole('button', { name: /工具审批/ })).toHaveClass(/approval-badge-managed/)

    // (1) Topbar strip with the managed badge (sheet closed so it is not
    // covered by the overlay; measured so the 44px macOS drag strip above the
    // topbar is excluded).
    const topbarBox = await page.locator('.topbar').boundingBox()
    expect(topbarBox).not.toBeNull()
    const topShot = await page.screenshot({
      clip: { x: topbarBox!.x, y: topbarBox!.y, width: topbarBox!.width, height: topbarBox!.height },
    })

    // (2) Full window with the settings sheet open on the danger partition.
    const dialog2 = await openApprovalSection()
    const partition = dialog2.locator('[data-sett-approval]')
    await partition.scrollIntoViewIfNeeded()
    await expect(partition).toBeVisible()
    const sheetShot = await page.screenshot()

    // (3) Composite the two genuine UI shots into managed-mode.png using a
    // canvas in the renderer — no image tooling, no UI altered for capture.
    const dataUrl = await page.evaluate(async (frames) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = () => reject(new Error('image decode failed'))
          img.src = src
        })
      const imgs = await Promise.all(frames.map(load))
      const width = Math.max(...imgs.map((i) => i.naturalWidth))
      const height = imgs.reduce((sum, i) => sum + i.naturalHeight, 0)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      let y = 0
      for (const img of imgs) {
        ctx.drawImage(img, 0, y)
        y += img.naturalHeight
      }
      return canvas.toDataURL('image/png')
    }, [topShot.toString('base64'), sheetShot.toString('base64')].map((b) => `data:image/png;base64,${b}`))

    mkdirSync(SCREENSHOTS, { recursive: true })
    const outPath = join(SCREENSHOTS, 'managed-mode.png')
    writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1]!, 'base64'))
    // Artifact sanity: written, decodes as a PNG, and carries real content.
    expect(readFileSync(outPath).subarray(1, 4).toString()).toBe('PNG')
    expect(statSync(outPath).size).toBeGreaterThan(10_000)
    expect(pageErrors).toEqual([])
  })
})
