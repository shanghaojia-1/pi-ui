import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { seedConfiguredEngine } from './engine-fixture'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '../..')
const SESSION_ID = 'sess_subagent_seed'

const SUBAGENT_DETAILS = {
  version: 2,
  runId: 'seed-run',
  mode: 'parallel',
  agentScope: 'user',
  projectAgentsDir: null,
  total: 2,
  maxConcurrency: 2,
  results: [
    {
      id: 'seed-run:0',
      agent: 'scout',
      agentSource: 'user',
      task: 'map the auth module',
      status: 'completed',
      exitCode: 0,
      model: 'claude-haiku',
      usage: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0, cost: 0.0009, contextTokens: 1800, turns: 2 },
      output: 'Auth lives in **src/auth.ts** with 3 entry points.',
      events: [
        { id: 'grep-1', kind: 'tool', status: 'success', label: 'grep completed', timestamp: 1, toolName: 'grep', args: '{"pattern":"auth","path":"."}', output: 'src/auth.ts' },
      ],
      messages: [],
    },
    {
      id: 'seed-run:1',
      agent: 'scout',
      agentSource: 'user',
      task: 'map the model layer',
      status: 'failed',
      exitCode: 1,
      stopReason: 'error',
      errorMessage: 'model unavailable',
      events: [{ id: 'error-1', kind: 'error', status: 'error', label: 'Subagent failed', timestamp: 2, text: 'model unavailable' }],
      messages: [],
    },
  ],
}

/** JSONL v3 seed: a subagent tool call + structured result + final answer. */
function seedJsonl(cwd: string): string {
  const t0 = Date.now()
  const records: unknown[] = [
    { type: 'session', version: 3, id: SESSION_ID, cwd, timestamp: t0 },
    {
      type: 'message',
      id: 'm-q',
      parentId: SESSION_ID,
      timestamp: t0 + 1,
      message: { role: 'user', content: 'recon the codebase with two scouts', timestamp: t0 + 1 },
    },
    {
      type: 'message',
      id: 'm-tool',
      parentId: 'm-q',
      timestamp: t0 + 2,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'subagent',
            arguments: { tasks: [{ agent: 'scout', task: 'map the auth module' }, { agent: 'scout', task: 'map the model layer' }] },
          },
        ],
        provider: 'test',
        model: 'test',
        stopReason: 'tool_calls',
        timestamp: t0 + 2,
      },
    },
    {
      type: 'message',
      id: 'm-toolresult',
      parentId: 'm-tool',
      timestamp: t0 + 3,
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'subagent',
        content: [{ type: 'text', text: 'Parallel: 1/2 succeeded' }],
        details: SUBAGENT_DETAILS,
        isError: false,
        timestamp: t0 + 3,
      },
    },
    {
      type: 'message',
      id: 'm-answer',
      parentId: 'm-toolresult',
      timestamp: t0 + 4,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Scouts reported back.' }],
        provider: 'test',
        model: 'test',
        stopReason: 'stop',
        timestamp: t0 + 4,
      },
    },
  ]
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

test.describe.serial('Subagent extension + card (isolated, no LLM)', () => {
  let app: ElectronApplication
  let page: Page
  let tempRoot: string
  let tempAgent: string
  let tempWorkspace: string
  let wsReal: string
  const pageErrors: string[] = []

  test.beforeAll(async () => {
    if (!existsSync(join(PROJECT_ROOT, 'out', 'main', 'index.js'))) {
      throw new Error('out/main/index.js missing — run `npm run build` first')
    }

    tempRoot = mkdtempSync(join(tmpdir(), 'pi-subagent-e2e-'))
    const tempHome = join(tempRoot, 'home')
    tempAgent = join(tempRoot, 'agent')
    tempWorkspace = join(tempRoot, 'workspace')
    for (const dir of [tempHome, tempAgent, tempWorkspace]) mkdirSync(dir)
    writeFileSync(join(tempWorkspace, 'README.md'), '# E2E subagent workspace\n')
    wsReal = realpathSync(tempWorkspace)

    // Session dir keyed by realpath cwd, exactly like the other seeded specs.
    const encodedDir = '--' + wsReal.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'
    const dir = join(tempAgent, 'sessions', encodedDir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, SESSION_ID + '.jsonl'), seedJsonl(wsReal))

    // NOTE: the forked extension + agents are NOT pre-installed here — the
    // app must deploy them from its bundle into the isolated agent dir on
    // first initialize (the packaged-app path: read-only asar → copy).

    const tempUserData = join(tempRoot, 'user-data')
    mkdirSync(tempUserData)
    seedConfiguredEngine(tempUserData, PROJECT_ROOT)
    const env = { ...process.env, HOME: tempHome, PI_CODING_AGENT_DIR: tempAgent, PI_STUDIO_LANG: 'zh', PI_STUDIO_USER_DATA: tempUserData } as Record<string, string>
    delete env.ELECTRON_RENDERER_URL
    // Some CI/agent hosts run Electron as Node globally; an actual GUI launch
    // must not inherit that switch.
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

  test('first launch deploys the bundled extension + agents into the agent dir', async () => {
    // The app copied (never symlinked) the bundle into the isolated agent dir.
    expect(existsSync(join(tempAgent, 'extensions', 'subagent', 'index.ts'))).toBe(true)
    expect(existsSync(join(tempAgent, 'extensions', 'subagent', 'agents.ts'))).toBe(true)
    expect(existsSync(join(tempAgent, 'agents', 'scout.md'))).toBe(true)
    expect(existsSync(join(tempAgent, 'agents', 'worker.md'))).toBe(true)
    expect(existsSync(join(tempAgent, 'extensions', 'subagent', '.pi-studio-version'))).toBe(true)
  })

  test('forked subagent extension loads without errors and registers the tool', async () => {
    const extensions = await page.evaluate(() => window.pi.getExtensions())
    const subagent = extensions.extensions.find((e) => e.resolvedPath.includes('subagent'))
    expect(subagent).toBeTruthy()
    expect(subagent!.name).toBe('subagent')
    expect(extensions.errors).toEqual([])
    // registerTool contributes the tool.
    expect(subagent!.toolCount).toBeGreaterThanOrEqual(1)
  })

  test('main injects the configured PI_SUBAGENT_ENGINE and its CLI runs in Electron node mode', async () => {
    // The GUI points the extension at the active engine package.
    const engineDir = await app.evaluate(() => process.env.PI_SUBAGENT_ENGINE)
    expect(engineDir).toBeTruthy()
    const engine = engineDir as string

    // The engine package ships the pi CLI (bin: dist/cli.js); running it
    // through the Electron binary with ELECTRON_RUN_AS_NODE must behave as
    // plain node — this is exactly what the extension does per subagent.
    const electronBin = app.process().spawnargs[0]
    expect(electronBin).toBeTruthy()
    const bin = electronBin as string
    const result = spawnSync(bin, [join(engine, 'dist', 'cli.js'), '--version'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    })

    expect(result.status).toBe(0)
    expect((result.stdout ?? '').trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('structured subagent details render as a dedicated card', async () => {
    // The right panel also renders tool cards; scope to the message list.
    const card = page.locator('.messages .subagent-card')
    await expect(card).toBeVisible()
    await expect(card.getByText('并行 · 2 个任务')).toBeVisible()
    await expect(card.getByText('1/2 完成')).toBeVisible()
    // Aggregated usage in the card head.
    await expect(card.getByText(/↑1.2k/)).toBeVisible()

    // Expand the card: two scout rows, one failed.
    await card.getByText('subagent').click()
    await expect(card.getByText('失败')).toBeVisible()
    expect(await card.getByText('scout').count()).toBe(2)

    // Expand the successful row: task, structured timeline, markdown output.
    await card.getByText('scout').first().click()
    await expect(card.getByText('map the auth module')).toBeVisible()
    await expect(card.getByText('实时过程')).toBeVisible()
    await expect(card.locator('code').getByText('grep', { exact: true })).toBeVisible()
    await expect(card.getByText(/src\/auth\.ts/)).toBeVisible()
    expect(pageErrors).toEqual([])
  })

  test('settings: subagents partition lists deployed agents and creates a new one', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '子代理', exact: true }).click()
    await expect(dialog.getByRole('heading', { name: '子代理' })).toBeVisible()

    // The 4 auto-deployed agents are listed.
    await expect(dialog.getByText('scout')).toBeVisible()
    await expect(dialog.getByText('planner')).toBeVisible()
    await expect(dialog.getByText('reviewer')).toBeVisible()
    await expect(dialog.getByText('worker')).toBeVisible()

    // Create a new subagent through the inline editor.
    await dialog.getByRole('button', { name: '新建子代理' }).click()
    await dialog.locator('#subagent-name').fill('debugger')
    await dialog.locator('#subagent-desc').fill('Finds bugs')
    // Model picker has no catalog in the isolated env: keep "follow default".
    await dialog.getByRole('button', { name: 'read' }).click()
    await dialog.getByRole('button', { name: 'bash' }).click()
    await dialog.locator('#subagent-prompt').fill('Hunt bugs.')
    await dialog.getByRole('button', { name: '保存子代理' }).click()
    await expect(dialog.getByText('debugger')).toBeVisible()
    await expect(dialog.getByText('Finds bugs')).toBeVisible()

    // The definition landed as a real file in the agent dir.
    const saved = await page.evaluate(() => window.pi.listSubagents())
    const debuggerAgent = saved.find((a) => a.name === 'debugger')
    expect(debuggerAgent).toBeTruthy()
    expect(debuggerAgent!.tools).toEqual(['read', 'bash'])
    expect(debuggerAgent!.model).toBeUndefined() // follow default

    await page.getByRole('button', { name: '关闭设置' }).click()
    expect(pageErrors).toEqual([])
  })

  test('the final assistant answer follows the card', async () => {
    await expect(page.getByText('Scouts reported back.')).toBeVisible()
    const msgClasses = await page
      .locator('.messages .msg')
      .evaluateAll((els) => els.map((el) => el.className))
    // user → assistant(tool card) → assistant(final text)
    expect(msgClasses.filter((c) => c.includes('msg-')).length).toBe(3)
    expect(pageErrors).toEqual([])
  })
})
