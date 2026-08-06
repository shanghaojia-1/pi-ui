import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.describe.serial('i18n + themes (isolated)', () => {
  let app: import('@playwright/test').ElectronApplication
  let page: Page
  let tempRoot: string
  let tempAgent: string
  let tempWorkspace: string

  test.beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pi-i18n-'))
    const tempHome = join(tempRoot, 'home')
    tempAgent = join(tempRoot, 'agent')
    tempWorkspace = join(tempRoot, 'workspace')
    for (const dir of [tempHome, tempAgent, tempWorkspace]) mkdirSync(dir)
    writeFileSync(join(tempWorkspace, 'README.md'), '# i18n\n')
    const env = { ...process.env, HOME: tempHome, PI_CODING_AGENT_DIR: tempAgent, PI_STUDIO_LANG: 'en' } as Record<string, string>
    delete env.ELECTRON_RENDERER_URL
    app = await _electron.launch({ args: ['/home/shj/桌面/pi-ui'], cwd: tempWorkspace, env })
    page = await app.firstWindow()
    await page.waitForSelector('.app', { timeout: 60000 })
  })

  test.afterAll(async () => {
    await app?.close().catch(() => undefined)
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  })

  test('PI_STUDIO_LANG=en boots the UI in English', async () => {
    await expect(page.getByRole('button', { name: 'New Task' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible()
    // The welcome heading (no workspace messages yet) is English too.
    await expect(page.getByText('Start a new task')).toBeVisible()
  })

  test('settings: switch language to zh instantly and persists in localStorage', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog).toBeVisible()
    // Appearance section with language + theme pickers.
    await expect(dialog.getByRole('heading', { name: 'Appearance' })).toBeVisible()
    await dialog.locator('#sett-lang').selectOption('zh')
    // The whole dialog flips to Chinese without reopening.
    await expect(page.getByRole('button', { name: '新任务' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '模型提供商' })).toBeVisible()
    // Persisted for the next launch.
    const stored = await page.evaluate(() => localStorage.getItem('pi-studio-lang'))
    expect(stored).toBe('zh')
    await page.getByRole('button', { name: '关闭设置' }).click()
  })

  test('themes: catalog pickers apply data-theme and CSS variables', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()
    const themeButtons = dialog.locator('.sett-theme')
    await expect(themeButtons).toHaveCount(9) // system + 8

    const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())
    const dataTheme = () => page.evaluate(() => document.documentElement.dataset.theme ?? null)

    await dialog.locator('.sett-theme', { hasText: '深海' }).click()
    expect(await dataTheme()).toBe('ocean')
    await expect.poll(bg).toBe('#0e1e2f')

    await dialog.locator('.sett-theme', { hasText: '森林' }).click()
    expect(await dataTheme()).toBe('forest')
    await expect.poll(bg).toBe('#eef3ea')

    await dialog.locator('.sett-theme', { hasText: '羊皮纸' }).click()
    expect(await dataTheme()).toBe('sepia')
    await expect.poll(bg).toBe('#f3ead8')

    await dialog.locator('.sett-theme', { hasText: '东北雨姐' }).click()
    expect(await dataTheme()).toBe('dongbei-yujie')
    await expect.poll(bg).toBe('#fff0f5')
    await expect(dialog.getByText('带派不老铁')).toBeVisible()

    await dialog.locator('.sett-theme', { hasText: '桥本有菜' }).click()
    expect(await dataTheme()).toBe('hashimoto-yuna')
    await expect.poll(bg).toBe('#120e11')
    await expect(dialog.getByText('黑樱桃 · 香槟金')).toBeVisible()

    await dialog.locator('.sett-theme', { hasText: '三上悠亚' }).click()
    expect(await dataTheme()).toBe('mikami-yua')
    await expect.poll(bg).toBe('#eaf8ff')
    await expect(dialog.getByText('爱琴海 · 珍珠白')).toBeVisible()

    // System mode clears the attribute and follows prefers-color-scheme.
    await page.emulateMedia({ colorScheme: 'dark' })
    await dialog.locator('.sett-theme', { hasText: '跟随系统' }).click()
    expect(await dataTheme()).toBeNull()
    await expect.poll(bg).toBe('#1d1c1a')

    // UI selection persists to localStorage.
    await dialog.locator('.sett-theme', { hasText: '深海' }).click()
    const stored = await page.evaluate(() => localStorage.getItem('pi-studio-theme'))
    expect(stored).toBe('ocean')
    await page.getByRole('button', { name: '关闭设置' }).click()
    expect(await dataTheme()).toBe('ocean')
  })
})
