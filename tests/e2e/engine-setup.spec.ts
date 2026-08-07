import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, test } from '@playwright/test'
import { seedConfiguredEngine } from './engine-fixture'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '../..')

test('first launch requires a user-selected Pi and initializes it without a bundled fallback', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-engine-setup-e2e-'))
  const tempHome = join(tempRoot, 'home')
  const tempAgent = join(tempRoot, 'agent')
  const tempWorkspace = join(tempRoot, 'workspace')
  const tempUserData = join(tempRoot, 'user-data')
  for (const dir of [tempHome, tempAgent, tempWorkspace, tempUserData]) mkdirSync(dir)
  const version = seedConfiguredEngine(tempUserData, PROJECT_ROOT, { activate: false })
  const env = {
    ...process.env,
    HOME: tempHome,
    PI_CODING_AGENT_DIR: tempAgent,
    PI_STUDIO_LANG: 'zh',
    PI_STUDIO_USER_DATA: tempUserData,
  } as Record<string, string>
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_RUN_AS_NODE

  const app = await _electron.launch({ args: [PROJECT_ROOT], cwd: tempWorkspace, env })
  try {
    const page = await app.firstWindow()
    const setup = page.locator('.engine-setup')
    await expect(setup).toBeVisible({ timeout: 60_000 })
    await expect(setup.getByRole('heading', { name: '先配置你的 Pi' })).toBeVisible()
    await expect(setup).toContainText('Pi Studio 不再携带另一份 Pi')
    expect((await page.evaluate(() => window.pi.getEngineStatus())).active).toBeNull()

    await setup.getByRole('button', { name: `使用 ${version}` }).click()
    await expect(page.locator('.app')).toBeVisible({ timeout: 60_000 })
    const status = await page.evaluate(() => window.pi.getEngineStatus())
    expect(status.active).toMatchObject({ version, source: 'userdata' })
    const childEngine = await app.evaluate(() => process.env.PI_SUBAGENT_ENGINE)
    expect(childEngine).toBe(status.active!.path)
  } finally {
    await app.close().catch(() => undefined)
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
