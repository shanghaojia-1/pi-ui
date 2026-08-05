import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.describe.serial('new provider modal + connection test (isolated)', () => {
  let app: ElectronApplication
  let page: Page
  let tempRoot: string
  let tempAgent: string
  let tempWorkspace: string
  let server: Server
  let baseUrl: string

  test.beforeAll(async () => {
    // Local OpenAI-compatible stub: GET /models -> 200 with a model list.
    server = createServer((req, res) => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    baseUrl = `http://127.0.0.1:${address.port}/v1`

    tempRoot = mkdtempSync(join(tmpdir(), 'pi-modal-'))
    const tempHome = join(tempRoot, 'home')
    tempAgent = join(tempRoot, 'agent')
    tempWorkspace = join(tempRoot, 'workspace')
    for (const dir of [tempHome, tempAgent, tempWorkspace]) mkdirSync(dir)
    writeFileSync(join(tempWorkspace, 'README.md'), '# modal\n')
    const env = { ...process.env, HOME: tempHome, PI_CODING_AGENT_DIR: tempAgent, PI_STUDIO_LANG: 'zh' } as Record<string, string>
    delete env.ELECTRON_RENDERER_URL
    app = await _electron.launch({ args: ['/home/shj/桌面/pi-ui'], cwd: tempWorkspace, env })
    page = await app.firstWindow()
    await page.waitForSelector('.app', { timeout: 60000 })
  })

  test.afterAll(async () => {
    await app?.close().catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  })

  test('new provider opens a modal dialog; connection test succeeds against the stub', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()

    // No inline form block before opening the modal.
    await expect(dialog.locator('.sett-custom-modal')).toHaveCount(0)
    await dialog.getByRole('button', { name: '新建供应商' }).click()

    const modal = page.getByRole('dialog', { name: '添加自定义提供商' })
    await expect(modal).toBeVisible()

    // Provider type preset: picking Ollama fills the API flavor + a default URL.
    await modal.getByRole('radio', { name: 'Ollama' }).click()
    await expect(modal.locator('#custom-url')).toHaveValue('http://localhost:11434/v1')
    await expect(modal.locator('#custom-api')).toHaveValue('openai-completions')
    await modal.locator('#custom-url').fill('')

    // Test connection with an unreachable URL -> network failure message.
    await modal.locator('#custom-url').fill('http://127.0.0.1:1/v1')
    await modal.getByRole('button', { name: '测试连接' }).click()
    await expect(modal.getByText('无法连接到服务器')).toBeVisible()

    // Reachable stub -> success.
    await modal.locator('#custom-url').fill(baseUrl)
    await modal.getByRole('button', { name: '测试连接' }).click()
    await expect(modal.getByText('连接成功')).toBeVisible()

    // Fill the rest and add the provider: modal closes, provider appears.
    await modal.locator('#custom-id').fill('stub-provider')
    await modal.locator('#custom-name').fill('Stub Provider')
    // Models are added one by one via the model row.
    await modal.getByLabel('模型 ID').fill('stub-model')
    await modal.getByRole('button', { name: '添加模型' }).click()
    await expect(modal.locator('.sett-model-id', { hasText: 'stub-model' })).toBeVisible()
    await modal.getByRole('button', { name: '添加提供商' }).click()
    await expect(modal).not.toBeVisible()
    await expect(dialog.locator('.sett-provider-name', { hasText: 'Stub Provider' })).toBeVisible()
    await page.getByRole('button', { name: '关闭设置' }).click()
  })

  test('cancel closes the modal without side effects', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '新建供应商' }).click()
    const modal = page.getByRole('dialog', { name: '添加自定义提供商' })
    await expect(modal).toBeVisible()
    await modal.locator('#custom-id').fill('ghost')
    await modal.getByRole('button', { name: '取消' }).click()
    await expect(modal).not.toBeVisible()
    // Nothing was added.
    await expect(dialog.locator('.sett-provider-name', { hasText: 'ghost' })).toHaveCount(0)
    await page.getByRole('button', { name: '关闭设置' }).click()
  })
})
