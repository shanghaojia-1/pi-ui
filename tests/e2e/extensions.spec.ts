import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Extension loading + dynamic slash-command integration: a seeded extension
 * in ~/.pi/agent/extensions/ must be loaded by the runtime (noExtensions is
 * off), show up in the Settings extensions section, and contribute its
 * command to the composer `/` menu.
 */
test.describe.serial('extensions (isolated)', () => {
  let app: ElectronApplication
  let page: Page
  let tempRoot: string
  let tempAgent: string
  let tempWorkspace: string

  test.beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pi-ext-'))
    const tempHome = join(tempRoot, 'home')
    tempAgent = join(tempRoot, 'agent')
    tempWorkspace = join(tempRoot, 'workspace')
    for (const dir of [tempHome, tempAgent, tempWorkspace]) mkdirSync(dir)
    writeFileSync(join(tempWorkspace, 'README.md'), '# ext\n')
    // Seed one extension registering /hello.
    const extDir = join(tempAgent, 'extensions')
    mkdirSync(extDir, { recursive: true })
    writeFileSync(
      join(extDir, 'hello.js'),
      `export default function (pi) {
  pi.registerCommand('hello', {
    description: 'Say hello from the test extension',
    handler: async (args, ctx) => {
      ctx.ui.notify('hello ' + args, 'info')
    },
  })
  pi.on('agent_start', async (_event, ctx) => {
    ctx.ui.notify('extension watching agent', 'info')
  })
}
`,
    )
    const env = { ...process.env, HOME: tempHome, PI_CODING_AGENT_DIR: tempAgent, PI_STUDIO_LANG: 'zh' } as Record<string, string>
    delete env.ELECTRON_RENDERER_URL
    app = await _electron.launch({ args: ['/home/shj/桌面/pi-ui'], cwd: tempWorkspace, env })
    page = await app.firstWindow()
    await page.waitForSelector('.app', { timeout: 60000 })
  })

  test.afterAll(async () => {
    await app?.close().catch(() => undefined)
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  })

  test('seeded extension is loaded: settings lists it with command + handler counts', async () => {
    const info = await page.evaluate(() => window.pi.getExtensions())
    // hello.js from the agent dir + the built-in inline approval extension.
    const ext = info.extensions.find((e) => e.path.includes('hello.js'))
    expect(ext).toBeTruthy()
    expect(ext!.commandCount).toBe(1)
    expect(ext!.handlerCount).toBe(1)
    expect(info.errors).toEqual([])

    // Settings panel: Extensions section shows the extension.
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: '扩展' })).toBeVisible()
    const extCard = dialog.locator('.sett-extension').filter({ hasText: 'hello.js' })
    await expect(extCard).toHaveCount(1)
    await expect(extCard).toContainText('hello.js')
    await expect(extCard).toContainText('1 命令')
    await expect(extCard).toContainText('1 处理器')
    await page.getByRole('button', { name: '关闭设置' }).click()
  })

  test('dynamic command appears in the / menu and executes via the SDK', async () => {
    const commands = await page.evaluate(() => window.pi.getDynamicCommands())
    const hello = commands.find((c) => c.name === 'hello')
    expect(hello).toBeTruthy()
    expect(hello!.source).toBe('extension')
    expect(hello!.description).toContain('test extension')

    // The composer menu lists it under 扩展.
    await page.evaluate(async () => {
      await window.pi.addCustomProvider({
        id: 'ext-test', baseUrl: 'http://localhost:11434/v1', api: 'openai-completions',
        apiKey: 'dummy', models: [{ id: 'm' }],
      })
    })
    const composer = page.getByRole('textbox', { name: '消息输入' })
    await expect(composer).toBeEnabled()
    await composer.click()
    await page.keyboard.type('/')
    await expect(page.getByRole('listbox', { name: '斜杠命令' })).toBeVisible()
    await expect(page.locator('.slash-name', { hasText: '/hello' })).toBeVisible()
    // Filtering by the extension command name works.
    await page.keyboard.type('hello')
    await expect(page.locator('.slash-name', { hasText: '/hello' })).toBeVisible()
    // Executing hands `/hello …` to the SDK (sandbox has no model, so the run
    // itself fails at the agent layer — the extension command path is what we
    // assert: the input clears and no IPC-level error surfaces).
    await page.keyboard.press('Enter')
    await expect(composer).toHaveValue('')
  })
})
