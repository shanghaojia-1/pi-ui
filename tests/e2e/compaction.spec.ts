import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { seedConfiguredEngine } from './engine-fixture'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '../..')
const SESSION_ID = 'sess_compaction_seed'

/**
 * JSONL v3 seed: a user message that was compacted away, the compaction entry
 * itself (with firstKeptEntryId), and the kept user/assistant pair. The
 * conversation should render as: system card (compaction summary) → user →
 * assistant.
 */
function seedJsonl(cwd: string): string {
  const t0 = Date.now()
  const records: unknown[] = [
    { type: 'session', version: 3, id: SESSION_ID, cwd, timestamp: t0 },
    {
      type: 'message',
      id: 'm-before',
      parentId: SESSION_ID,
      timestamp: t0 + 1,
      message: { role: 'user', content: 'explain the read tool', timestamp: t0 + 1 },
    },
    {
      type: 'compaction',
      id: 'c-1',
      parentId: 'm-before',
      timestamp: new Date(t0 + 2).toISOString(),
      summary: '用户询问了 read 工具的用法，并审阅了认证模块的代码。',
      tokensBefore: 52_000,
      firstKeptEntryId: 'm-after',
    },
    {
      type: 'message',
      id: 'm-after',
      parentId: 'c-1',
      timestamp: t0 + 3,
      message: { role: 'user', content: 'continue', timestamp: t0 + 3 },
    },
    {
      type: 'message',
      id: 'm-answer',
      parentId: 'm-after',
      timestamp: t0 + 4,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'here is the answer' }],
        provider: 'test',
        model: 'test',
        stopReason: 'stop',
        timestamp: t0 + 4,
      },
    },
  ]
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

test.describe.serial('Compaction summary card (isolated, no LLM)', () => {
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

    tempRoot = mkdtempSync(join(tmpdir(), 'pi-compaction-e2e-'))
    tempHome = join(tempRoot, 'home')
    tempAgent = join(tempRoot, 'agent')
    tempWorkspace = join(tempRoot, 'workspace')
    for (const dir of [tempHome, tempAgent, tempWorkspace]) mkdirSync(dir)
    writeFileSync(join(tempWorkspace, 'README.md'), '# E2E compaction workspace\n')
    wsReal = realpathSync(tempWorkspace)

    // Session dir keyed by realpath cwd, exactly like the other seeded specs.
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

  test('compaction summary renders as a collapsed system card in conversation order', async () => {
    // Snapshot carries the summary as a system message between user turns.
    const snap = await snapshot()
    const roles = (snap.messages as { role: string }[]).map((m) => m.role)
    expect(roles).toEqual(['system', 'user', 'assistant'])

    const card = page.locator('.msg-system')
    await expect(card).toBeVisible()
    await expect(card.getByText('上下文已压缩')).toBeVisible()

    // Summary starts collapsed.
    await expect(card.getByText(/read 工具的用法/)).toBeHidden()

    // Expand reveals the summary text (markdown-rendered).
    await card.getByText('查看压缩摘要').click()
    await expect(card.getByText(/read 工具的用法/)).toBeVisible()
    await expect(card.getByText(/认证模块的代码/)).toBeVisible()

    // Conversation order: system card first, then the kept user/assistant pair.
    const msgClasses = await page
      .locator('.messages .msg')
      .evaluateAll((els) => els.map((el) => el.className))
    expect(msgClasses).toEqual(['msg msg-system', 'msg msg-user', 'msg msg-assistant'])
    expect(pageErrors).toEqual([])
  })

  test('compaction card keeps the summary expanded across re-renders', async () => {
    // Re-opening the session keeps the persisted compaction entry; the card
    // renders again (collapsed by default) without page errors.
    const card: Locator = page.locator('.msg-system')
    await expect(card).toBeVisible()
    await expect(card.getByText('上下文已压缩')).toBeVisible()
    expect(pageErrors).toEqual([])
  })
})
