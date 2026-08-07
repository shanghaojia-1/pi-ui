import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import subagentExtension from '../../extensions/subagent/index'

type ToolDefinition = {
  execute(
    id: string,
    params: Record<string, any>,
    signal: AbortSignal,
    onUpdate: (result: any) => void,
    ctx: Record<string, any>,
  ): Promise<any>
}

describe('subagent extension live process integration', () => {
  let root: string
  let workspace: string
  let definition: ToolDefinition
  const previous = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    engine: process.env.PI_SUBAGENT_ENGINE,
    host: process.env.PI_STUDIO_HOST,
    anthropic: process.env.ANTHROPIC_API_KEY,
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-subagent-extension-'))
    workspace = join(root, 'workspace')
    const agentDir = join(root, 'agent')
    const engineDist = join(root, 'engine', 'dist')
    mkdirSync(workspace)
    mkdirSync(join(agentDir, 'agents'), { recursive: true })
    mkdirSync(engineDist, { recursive: true })
    writeFileSync(join(agentDir, 'agents', 'scout.md'), [
      '---',
      'name: scout',
      'description: test scout',
      '---',
      '',
    ].join('\n'))
    writeFileSync(join(engineDist, 'cli.js'), `
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', async () => {
  const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  if (prompt.includes('hang forever')) {
    setInterval(() => {}, 1000);
    return;
  }
  await wait(20);
  emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'checking files' }] }, assistantMessageEvent: { type: 'thinking_delta' } });
  await wait(20);
  emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'grep', args: { pattern: 'auth' } });
  await wait(20);
  emit({ type: 'tool_execution_update', toolCallId: 'tool-1', toolName: 'grep', args: { pattern: 'auth' }, partialResult: { content: [{ type: 'text', text: 'src/auth.ts' }] } });
  await wait(20);
  emit({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'grep', result: { content: [{ type: 'text', text: 'src/auth.ts' }] }, isError: false });
  await wait(20);
  const authState = String(process.env.OPENAI_API_KEY === 'selected-key') + ':' + String(Boolean(process.env.ANTHROPIC_API_KEY)) + ':' + String(Boolean(process.env.PI_STUDIO_HOST));
  emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'answer ' + authState }] }, assistantMessageEvent: { type: 'text_delta' } });
  await wait(100);
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'answer ' + authState }], model: 'test', stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } } } });
});
`)
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_SUBAGENT_ENGINE = join(root, 'engine')
    process.env.PI_STUDIO_HOST = '1'
    let captured: ToolDefinition | undefined
    subagentExtension({ registerTool: (tool: unknown) => { captured = tool as ToolDefinition } } as unknown as ExtensionAPI)
    if (!captured) throw new Error('subagent tool was not registered')
    definition = captured
  })

  afterAll(() => {
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous.agentDir
    if (previous.engine === undefined) delete process.env.PI_SUBAGENT_ENGINE
    else process.env.PI_SUBAGENT_ENGINE = previous.engine
    if (previous.host === undefined) delete process.env.PI_STUDIO_HOST
    else process.env.PI_STUDIO_HOST = previous.host
    if (previous.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previous.anthropic
    rmSync(root, { recursive: true, force: true })
  })

  const context = () => ({
    cwd: workspace,
    mode: 'rpc',
    ui: { confirm: async () => false },
    isProjectTrusted: () => false,
    model: { provider: 'openai', id: 'test' },
    thinkingLevel: 'off',
    modelRegistry: {
      getAvailable: () => [{ provider: 'openai', id: 'test' }],
      getProviderAuth: async () => ({ auth: { apiKey: 'selected-key' }, env: {} }),
      getApiKeyForProvider: async () => 'selected-key',
    },
  })

  it('streams real child lifecycle/tool events and finishes with a compact result', async () => {
    process.env.ANTHROPIC_API_KEY = 'must-not-leak'
    const updates: any[] = []
    const result = await definition.execute(
      'call-live',
      { agent: 'scout', task: 'find auth' },
      new AbortController().signal,
      (update) => updates.push(structuredClone(update.details)),
      context(),
    )
    delete process.env.ANTHROPIC_API_KEY

    const statuses = updates.flatMap((details) => details.results.map((item: any) => item.status))
    expect(statuses).toContain('thinking')
    expect(statuses).toContain('running_tool')
    expect(statuses).toContain('streaming')
    const liveTool = updates
      .flatMap((details) => details.results)
      .flatMap((item: any) => item.events ?? [])
      .find((event: any) => event.toolCallId === 'tool-1' && event.output)
    expect(liveTool.output).toContain('src/auth.ts')

    expect(result.isError).toBeUndefined()
    expect(result.details.version).toBe(2)
    expect(result.details.results[0]).toMatchObject({ status: 'completed', exitCode: 0, output: 'answer true:false:false' })
    expect(result.details.results[0].messages).toEqual([])
    expect(result.content[0].text).toBe('answer true:false:false')
  })

  it('rejects a child cwd outside the active workspace before spawning', async () => {
    const result = await definition.execute(
      'call-cwd',
      { agent: 'scout', task: 'escape', cwd: '..' },
      new AbortController().signal,
      () => undefined,
      context(),
    )
    expect(result.isError).toBe(true)
    expect(result.details.results[0].status).toBe('failed')
    expect(result.details.results[0].errorMessage).toContain('inside the workspace')
  })

  it('cancels a hung child and reports cancelled instead of throwing', async () => {
    const controller = new AbortController()
    const pending = definition.execute(
      'call-abort',
      { agent: 'scout', task: 'hang forever' },
      controller.signal,
      () => undefined,
      context(),
    )
    setTimeout(() => controller.abort(), 60)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.details.results[0]).toMatchObject({ status: 'cancelled', stopReason: 'aborted' })
  })

  it('exposes an independent task cancel handle for GUI hosts', async () => {
    const pending = definition.execute(
      'call-one',
      { agent: 'scout', task: 'hang forever' },
      new AbortController().signal,
      () => undefined,
      context(),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    const symbol = Symbol.for('pi-studio.subagent-control')
    const registry = (globalThis as typeof globalThis & Record<symbol, Map<string, () => void>>)[symbol]
    expect(registry?.has('call-one:0')).toBe(true)
    registry!.get('call-one:0')!()
    const result = await pending
    expect(result.details.results[0].status).toBe('cancelled')
    expect(registry?.has('call-one:0')).toBe(false)
  })
})
