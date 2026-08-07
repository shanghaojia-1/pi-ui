import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedConfiguredEngine } from './engine-fixture'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '../..')

test.describe.serial('new provider modal + connection test (isolated)', () => {
  let app: ElectronApplication
  let page: Page
  let tempRoot: string
  let tempAgent: string
  let tempWorkspace: string
  let server: Server
  let baseUrl: string

  test.beforeAll(async () => {
    // Local OpenAI-compatible stub: GET /models -> 401 without an API key
    // (exactly what the real gateway does), 200 with one.
    server = createServer((req, res) => {
      if (req.url?.endsWith('/models')) {
        if (!req.headers.authorization) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'missing key' } }))
          return
        }
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
    const tempUserData = join(tempRoot, 'user-data')
    mkdirSync(tempUserData)
    seedConfiguredEngine(tempUserData, PROJECT_ROOT)
    const env = { ...process.env, HOME: tempHome, PI_CODING_AGENT_DIR: tempAgent, PI_STUDIO_LANG: 'zh', PI_STUDIO_USER_DATA: tempUserData } as Record<string, string>
    delete env.ELECTRON_RENDERER_URL
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ args: [PROJECT_ROOT], cwd: tempWorkspace, env })
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
    await dialog.getByRole('button', { name: '模型提供商', exact: true }).click()
    await expect(dialog.getByRole('button', { name: '新建供应商' })).toBeVisible()
    await dialog.getByRole('button', { name: '新建供应商' }).click()

    const modal = page.getByRole('dialog', { name: '添加自定义提供商' })
    await expect(modal).toBeVisible()

    // Default type is Custom: the full form (ID/URL/API/models) is shown.
    await expect(modal.locator('#custom-url')).toBeVisible()
    await expect(modal.locator('#custom-api')).toHaveValue('openai-completions')

    // Test connection with an unreachable URL -> network failure message.
    await modal.locator('#custom-url').fill('http://127.0.0.1:1/v1')
    await modal.getByRole('button', { name: '测试连接' }).click()
    await expect(modal.getByText('无法连接到服务器')).toBeVisible()

    // Reachable stub, key not yet typed (new-provider mode, nothing to fall
    // back to) -> the gateway's 401 surfaces as an auth failure.
    await modal.locator('#custom-url').fill(baseUrl)
    await modal.getByRole('button', { name: '测试连接' }).click()
    await expect(modal.getByText('认证失败（HTTP 401）')).toBeVisible()

    // With a typed key the same endpoint succeeds.
    await modal.locator('#custom-key').fill('sk-stub')
    await modal.getByRole('button', { name: '测试连接' }).click()
    await expect(modal.getByText('连接成功')).toBeVisible()

    // Fill the rest and add the provider: modal closes, provider appears.
    await modal.locator('#custom-id').fill('stub-provider')
    await modal.locator('#custom-name').fill('Stub Provider')
    // Custom providers only surface models once auth is configured; the stub
    // server accepts any key, so a dummy one is fine here.
    // Models are added one by one, then configured per-model: display name,
    // context window and image input.
    await modal.getByLabel('模型 ID').fill('stub-model')
    await modal.getByRole('button', { name: '添加模型' }).click()
    const modelCard = modal.locator('.sett-model-card', { hasText: 'stub-model' })
    await expect(modelCard.locator('.sett-model-id', { hasText: 'stub-model' })).toBeVisible()
    await modelCard.getByLabel('模型显示名称（可选）').fill('Stub Model')
    await modelCard.getByLabel('上下文窗口').fill('128000')
    await expect(modelCard.getByText('≈ 128.0k')).toBeVisible()
    await modelCard.getByRole('button', { name: '图片' }).click()
    await modal.getByRole('button', { name: '添加提供商' }).click()
    await expect(modal).not.toBeVisible()
    // The new provider lands in models.json (with its per-model config) and
    // its model becomes selectable in the chat dialog — the settings page
    // itself lists no providers.
    const modelsPath = join(tempAgent, 'models.json')
    const onDisk = JSON.parse(readFileSync(modelsPath, 'utf8')) as { providers: Record<string, { models: unknown[] }> }
    expect(onDisk.providers['stub-provider']?.models).toEqual([
      { id: 'stub-model', name: 'Stub Model', input: ['text', 'image'], contextWindow: 128000 },
    ])
    const after = await page.evaluate(() => window.pi.getSettings())
    expect(after.providers.some((p) => p.id === 'stub-provider')).toBe(true)
    const snap = await page.evaluate(() => window.pi.getSnapshot())
    expect(snap.models.some((m) => m.provider === 'stub-provider' && m.id === 'stub-model')).toBe(true)
    await page.getByRole('button', { name: '关闭设置' }).click()
  })

  test('edit mode: connection test falls back to the saved models.json key', async () => {
    // Seed a provider with a stored key, exactly like the previous test left it.
    await page.evaluate(
      (base) =>
        window.pi.addCustomProvider({
          id: 'saved-provider',
          baseUrl: base,
          api: 'openai-completions',
          apiKey: 'sk-saved',
          models: [{ id: 'saved-model' }],
        }),
      baseUrl,
    )
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '模型提供商', exact: true }).click()
    // The provider card lists saved-provider; open its edit dialog.
    const card = dialog.locator('.sett-provider-card', { hasText: 'saved-provider' })
    await card.getByRole('button', { name: '编辑' }).click()
    const modal = page.getByRole('dialog', { name: '编辑供应商' })
    await expect(modal).toBeVisible()
    // Key field is intentionally blank (never echoed back) — the test must
    // still authenticate with the key persisted in models.json.
    await expect(modal.locator('#custom-key')).toHaveValue('')
    await expect(modal.getByText('未输入新 Key 时，测试将使用 models.json 中已保存的 Key。')).toBeVisible()
    await modal.getByRole('button', { name: '测试连接' }).click()
    await expect(modal.getByText('连接成功')).toBeVisible()
    // Close the edit modal first, then the settings sheet.
    await modal.getByRole('button', { name: '取消' }).click()
    await expect(modal).not.toBeVisible()
    await page.getByRole('button', { name: '关闭设置' }).click()
  })

  test('cancel closes the modal without side effects', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '模型提供商', exact: true }).click()
    await dialog.getByRole('button', { name: '新建供应商' }).click()
    const modal = page.getByRole('dialog', { name: '添加自定义提供商' })
    await expect(modal).toBeVisible()
    await modal.locator('#custom-id').fill('ghost')
    await modal.getByRole('button', { name: '取消' }).click()
    await expect(modal).not.toBeVisible()
    // Nothing was added.
    const after = await page.evaluate(() => window.pi.getSettings())
    expect(after.providers.some((p) => p.id === 'ghost')).toBe(false)
    await page.getByRole('button', { name: '关闭设置' }).click()
  })
})
