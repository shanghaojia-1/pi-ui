import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { canonicalizeEvenIfMissing, PiRuntime } from '../../src/main/runtime'

const mocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  getAgentDir: vi.fn(),
  ModelRuntime: { create: vi.fn() },
  SessionManager: { create: vi.fn(), open: vi.fn(), list: vi.fn(), listAll: vi.fn() },
  DefaultResourceLoader: vi.fn(),
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
}))

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {},
  dialog: mocks.dialog,
}))

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: mocks.createAgentSession,
  DefaultResourceLoader: mocks.DefaultResourceLoader,
  getAgentDir: mocks.getAgentDir,
  ModelRuntime: mocks.ModelRuntime,
  SessionManager: mocks.SessionManager,
}))

// The runtime now reaches the SDK through the engine loader; keep the mocked
// SDK surface in play by serving it from the mocked loader.
vi.mock('../../src/main/engine-loader', () => ({
  getEngineApi: () => ({
    createAgentSession: mocks.createAgentSession,
    DefaultResourceLoader: mocks.DefaultResourceLoader,
    getAgentDir: mocks.getAgentDir,
    ModelRuntime: mocks.ModelRuntime,
    SessionManager: mocks.SessionManager,
    DefaultPackageManager: class DefaultPackageManager {},
  }),
}))

const TMP = realpathSync(tmpdir())

/** Default session directory for a cwd, mirroring the SDK's `--<encoded>--` encoding. */
const sessionDirFor = (cwd: string): string =>
  join(agentDir, 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)

class FakeWindow {
  webContents = { send: vi.fn() }
  isDestroyed(): boolean { return false }
}

class FakeSession {
  sessionId = 'fake-session'
  sessionFile: string | null = null
  messages: unknown[] = []
  model: unknown = null
  thinkingLevel = 'medium'
  isStreaming = false
  disposed = false
  private subscriber: ((event: unknown) => void) | null = null
  prompt(): Promise<unknown> { return Promise.resolve() }
  clearQueue(): void {}
  async abort(): Promise<void> {}
  dispose(): void { this.disposed = true }
  subscribe(cb: (event: unknown) => void): () => void { this.subscriber = cb; return () => { this.subscriber = null } }
  async bindExtensions(): Promise<void> {}
  async setModel(): Promise<void> {}
  setThinkingLevel(): void {}
}

let agentDir: string
beforeAll(() => { agentDir = mkdtempSync(join(TMP, 'pi-agent-')) })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getAgentDir.mockReturnValue(agentDir)
  mocks.ModelRuntime.create.mockResolvedValue({ getAvailable: async () => [], getModel: () => null })
  mocks.SessionManager.listAll.mockResolvedValue([])
  mocks.SessionManager.create.mockImplementation((path: string) => ({ getSessionDir: () => path }))
  mocks.SessionManager.open.mockReturnValue({})
  mocks.createAgentSession.mockResolvedValue({ session: new FakeSession(), modelFallbackMessage: undefined })
  mocks.DefaultResourceLoader.mockImplementation((options: unknown) => ({ reload: async () => {}, options }))
})

async function initRuntime(workspace: string): Promise<PiRuntime> {
  const runtime = new PiRuntime()
  runtime.setWindow(new FakeWindow() as unknown as BrowserWindow)
  await runtime.initialize(workspace)
  return runtime
}

/** Seeds the cross-directory sidebar allowlist with sessions of `workspace`. */
async function initWithSessions(workspace: string, listed: string[]): Promise<PiRuntime> {
  mocks.SessionManager.listAll.mockResolvedValue(listed.map((path, i) => ({
    id: `s${i}`, path, name: '', firstMessage: 'first', modified: new Date(0), messageCount: 1,
    cwd: workspace,
  })))
  return initRuntime(workspace)
}

type WithValidator = { validateWorkspacePath(input: string): Promise<string> }
const validatorOf = (runtime: PiRuntime): WithValidator => runtime as unknown as WithValidator

describe('canonicalizeEvenIfMissing', () => {
  it('resolves paths whose trailing segments do not exist yet', () => {
    const root = mkdtempSync(join(TMP, 'pi-canon-'))
    expect(canonicalizeEvenIfMissing(join(root, 'a', 'b', 'c.txt'))).toBe(join(root, 'a', 'b', 'c.txt'))
  })

  it('resolves symlinks to their real target', () => {
    const root = mkdtempSync(join(TMP, 'pi-canon-'))
    const real = join(root, 'real')
    mkdirSync(real)
    const link = join(root, 'link')
    symlinkSync(real, link, 'dir')
    expect(canonicalizeEvenIfMissing(link)).toBe(real)
  })
})

describe('workspace validation', () => {
  it('refuses non-directory and Pi agent directory workspaces', async () => {
    const ws = mkdtempSync(join(TMP, 'pi-ws-'))
    const runtime = await initRuntime(ws)
    const validate = (input: string): Promise<string> => validatorOf(runtime).validateWorkspacePath(input)

    const file = join(ws, 'x.txt')
    writeFileSync(file, 'x')
    await expect(validate(file)).rejects.toThrow('Workspace must be a directory')
    await expect(validate(agentDir)).rejects.toThrow('Refusing to use the Pi config directory as a workspace')
    const nested = join(agentDir, 'nested')
    mkdirSync(nested)
    await expect(validate(nested)).rejects.toThrow('Refusing to use the Pi config directory as a workspace')
  })

  it('canonicalizes symlinked workspace directories', async () => {
    const root = mkdtempSync(join(TMP, 'pi-ws-'))
    const real = join(root, 'real')
    mkdirSync(real)
    const link = join(root, 'link')
    symlinkSync(real, link, 'dir')
    const runtime = await initRuntime(root)
    const snap = await runtime.openWorkspace(link)
    expect(snap.error).toBeNull()
    expect(snap.workspace?.path).toBe(real)
  })
})

describe('openSession path verification', () => {
  it('opens a regular, listed session file', async () => {
    const ws = mkdtempSync(join(TMP, 'pi-ws-'))
    const file = join(sessionDirFor(ws), 's1.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{}')
    const session = new FakeSession()
    session.sessionFile = file
    mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined })
    const runtime = await initWithSessions(ws, [file])
    const snap = await runtime.openSession(file)
    expect(snap.error).toBeNull()
    expect(snap.activeSessionPath).toBe(file)
    expect(session.disposed).toBe(false)
  })

  it('abandons the opened session when the SDK reports no sessionFile instead of succeeding', async () => {
    const ws = mkdtempSync(join(TMP, 'pi-ws-'))
    const file = join(sessionDirFor(ws), 's1.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{}')
    const runtime = await initRuntime(ws) // empty session active
    mocks.SessionManager.listAll.mockResolvedValue([
      { id: 's0', path: file, name: '', firstMessage: 'first', modified: new Date(1), messageCount: 1, cwd: ws },
    ])
    await runtime.newSession() // refreshes the sidebar allowlist with the file
    const session = new FakeSession() // sessionFile stays null/undefined
    mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined })
    const snap = await runtime.openSession(file)
    expect(mocks.SessionManager.open).toHaveBeenCalledWith(file, undefined, ws)
    expect(session.disposed).toBe(true) // the file-less candidate was abandoned
    expect(snap.error?.message).toBe('Failed to open session')
    expect(snap.error?.detail).toContain('does not match the requested file')
    expect(runtime.snapshot().activeSessionPath).toBeNull()
  })

  it('rejects symlinked or non-regular session files', async () => {
    const ws = mkdtempSync(join(TMP, 'pi-ws-'))
    const dir = sessionDirFor(ws)
    mkdirSync(dir, { recursive: true })
    const real = join(dir, 'real.jsonl')
    writeFileSync(real, '{}')
    const link = join(dir, 'link.jsonl')
    symlinkSync(real, link, 'file')
    const runtime = await initWithSessions(ws, [real, link])

    let snap = await runtime.openSession(link)
    expect(snap.error?.detail).toContain('Session must be a regular file')

    snap = await runtime.openSession(ws) // a directory, not a file
    expect(snap.error?.detail).toContain('Session must be a regular file')
  })

  it('rejects session files not listed in the workspace allowlist', async () => {
    const ws = mkdtempSync(join(TMP, 'pi-ws-'))
    const file = join(sessionDirFor(ws), 's.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{}')
    const runtime = await initWithSessions(ws, [])
    const snap = await runtime.openSession(file)
    expect(snap.error?.detail).toContain('Session does not belong to this workspace')
  })

  it('rejects files outside the agent sessions root even when listed', async () => {
    const ws = mkdtempSync(join(TMP, 'pi-ws-'))
    const outside = mkdtempSync(join(TMP, 'pi-out-'))
    const file = join(outside, 's.jsonl')
    writeFileSync(file, '{}')
    const runtime = await initWithSessions(ws, [file])
    const snap = await runtime.openSession(file)
    expect(snap.error?.detail).toContain('Session does not belong to this workspace')
  })
})

describe('workspace restore', () => {
  it('restores the most recent regular session through the same validation as openSession', async () => {
    const ws = mkdtempSync(join(TMP, 'pi-ws-'))
    const file = join(sessionDirFor(ws), 's1.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{}')
    mocks.SessionManager.listAll.mockResolvedValue([
      { id: 's0', path: file, name: '', firstMessage: 'first', modified: new Date(1), messageCount: 1, cwd: ws },
    ])
    const session = new FakeSession()
    session.sessionFile = file
    mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined })
    const runtime = new PiRuntime()
    runtime.setWindow(new FakeWindow() as unknown as BrowserWindow)
    const snap = await runtime.initialize(ws)
    expect(mocks.SessionManager.open).toHaveBeenCalledWith(file, undefined, ws)
    expect(snap.error).toBeNull()
    expect(snap.activeSessionPath).toBe(file)
    expect(session.disposed).toBe(false)
  })

  it('skips a symlinked first session on restore and starts a fresh session with a recoverable error', async () => {
    const ws = mkdtempSync(join(TMP, 'pi-ws-'))
    const dir = sessionDirFor(ws)
    mkdirSync(dir, { recursive: true })
    const real = join(dir, 'real.jsonl')
    writeFileSync(real, '{}')
    const link = join(dir, 'link.jsonl')
    symlinkSync(real, link, 'file')
    mocks.SessionManager.listAll.mockResolvedValue([
      { id: 's0', path: link, name: '', firstMessage: 'first', modified: new Date(1), messageCount: 1, cwd: ws },
    ])
    const runtime = new PiRuntime()
    runtime.setWindow(new FakeWindow() as unknown as BrowserWindow)
    const snap = await runtime.initialize(ws)
    expect(mocks.SessionManager.open).not.toHaveBeenCalled()
    expect(mocks.SessionManager.create).toHaveBeenCalledWith(ws)
    expect(snap.error?.message).toBe('Skipped unopenable session')
    expect(snap.error?.detail).toContain('Session must be a regular file')
    expect(snap.activeSessionPath).toBeNull()
  })

  it('skips a listed session outside the sessions root on restore', async () => {
    const ws = mkdtempSync(join(TMP, 'pi-ws-'))
    const outside = mkdtempSync(join(TMP, 'pi-out-'))
    const file = join(outside, 's.jsonl')
    writeFileSync(file, '{}')
    mocks.SessionManager.listAll.mockResolvedValue([
      { id: 's0', path: file, name: '', firstMessage: 'first', modified: new Date(1), messageCount: 1, cwd: ws },
    ])
    const runtime = new PiRuntime()
    runtime.setWindow(new FakeWindow() as unknown as BrowserWindow)
    const snap = await runtime.initialize(ws)
    expect(mocks.SessionManager.open).not.toHaveBeenCalled()
    expect(snap.error?.message).toBe('Skipped unopenable session')
    expect(snap.error?.detail).toContain('Session does not belong to this workspace')
    expect(snap.activeSessionPath).toBeNull()
  })

  it('skips a restored session whose sessionFile is undefined (fail closed)', async () => {
    const ws = mkdtempSync(join(TMP, 'pi-ws-'))
    const file = join(sessionDirFor(ws), 's1.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{}')
    mocks.SessionManager.listAll.mockResolvedValue([
      { id: 's0', path: file, name: '', firstMessage: 'first', modified: new Date(1), messageCount: 1, cwd: ws },
    ])
    const session = new FakeSession() // sessionFile stays null/undefined
    mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined })
    const runtime = new PiRuntime()
    runtime.setWindow(new FakeWindow() as unknown as BrowserWindow)
    const snap = await runtime.initialize(ws)
    expect(mocks.SessionManager.open).toHaveBeenCalledWith(file, undefined, ws)
    expect(mocks.SessionManager.create).toHaveBeenCalledWith(ws) // fresh empty session
    expect(session.disposed).toBe(true) // the file-less candidate was abandoned
    expect(snap.error?.message).toBe('Skipped unopenable session')
    expect(snap.error?.detail).toContain('does not match the requested file')
    expect(snap.activeSessionPath).toBeNull()
  })

  it('skips the restore when the opened session file does not match the verified path (file replaced)', async () => {
    const ws = mkdtempSync(join(TMP, 'pi-ws-'))
    const file = join(sessionDirFor(ws), 's1.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{}')
    mocks.SessionManager.listAll.mockResolvedValue([
      { id: 's0', path: file, name: '', firstMessage: 'first', modified: new Date(1), messageCount: 1, cwd: ws },
    ])
    // The file was swapped before the SDK opened it: the active sessionFile no
    // longer matches the verified canonical path.
    const session = new FakeSession()
    session.sessionFile = join(ws, 'replaced.jsonl')
    mocks.createAgentSession.mockResolvedValueOnce({ session, modelFallbackMessage: undefined })
    const runtime = new PiRuntime()
    runtime.setWindow(new FakeWindow() as unknown as BrowserWindow)
    const snap = await runtime.initialize(ws)
    expect(mocks.SessionManager.open).toHaveBeenCalledWith(file, undefined, ws)
    expect(mocks.SessionManager.create).toHaveBeenCalledWith(ws) // fresh empty session
    expect(session.disposed).toBe(true) // the mismatched candidate was abandoned
    expect(snap.error?.message).toBe('Skipped unopenable session')
    expect(snap.error?.detail).toContain('does not match the requested file')
    expect(snap.activeSessionPath).toBeNull()
  })

  it('skips the restore and starts fresh when opening a corrupted session fails', async () => {
    const ws = mkdtempSync(join(TMP, 'pi-ws-'))
    const file = join(sessionDirFor(ws), 's1.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'corrupt')
    mocks.SessionManager.listAll.mockResolvedValue([
      { id: 's0', path: file, name: '', firstMessage: 'first', modified: new Date(1), messageCount: 1, cwd: ws },
    ])
    mocks.createAgentSession.mockRejectedValueOnce(new Error('corrupt jsonl'))
    const runtime = new PiRuntime()
    runtime.setWindow(new FakeWindow() as unknown as BrowserWindow)
    const snap = await runtime.initialize(ws)
    expect(mocks.SessionManager.open).toHaveBeenCalledWith(file, undefined, ws)
    expect(mocks.SessionManager.create).toHaveBeenCalledWith(ws) // fresh empty session
    expect(snap.error?.message).toBe('Skipped unopenable session')
    expect(snap.error?.detail).toContain('corrupt jsonl')
    expect(snap.activeSessionPath).toBeNull()
  })
})

describe('cross-workspace sessions', () => {
  it('opens a session from another workspace and switches the working directory', async () => {
    const wsA = mkdtempSync(join(TMP, 'pi-wsA-'))
    const wsB = mkdtempSync(join(TMP, 'pi-wsB-'))
    const fileA = join(sessionDirFor(wsA), 'sA.jsonl')
    const fileB = join(sessionDirFor(wsB), 'sB.jsonl')
    mkdirSync(dirname(fileA), { recursive: true })
    mkdirSync(dirname(fileB), { recursive: true })
    writeFileSync(fileA, '{}')
    writeFileSync(fileB, '{}')
    // The sidebar is a cross-directory history: listAll returns both workspaces.
    mocks.SessionManager.listAll.mockResolvedValue([
      { id: 'sa', path: fileA, name: '', firstMessage: 'in A', modified: new Date(1), messageCount: 1, cwd: wsA },
      { id: 'sb', path: fileB, name: '', firstMessage: 'in B', modified: new Date(2), messageCount: 1, cwd: wsB },
    ])
    const sessionA = new FakeSession()
    sessionA.sessionFile = fileA
    const sessionB = new FakeSession()
    sessionB.sessionFile = fileB
    mocks.createAgentSession.mockResolvedValue({ session: sessionA, modelFallbackMessage: undefined })
    const runtime = await initRuntime(wsA)
    expect(runtime.snapshot().activeSessionPath).toBe(fileA) // restore picks the wsA session
    expect(runtime.snapshot().sessions.map((s) => s.workspace?.path)).toEqual([wsA, wsB])

    // Opening the wsB session must first switch the working directory.
    mocks.createAgentSession.mockResolvedValue({ session: sessionB, modelFallbackMessage: undefined })
    const snap = await runtime.openSession(fileB)
    expect(snap.error).toBeNull()
    expect(snap.workspace?.path).toBe(wsB)
    expect(snap.activeSessionPath).toBe(fileB)
    expect(sessionA.disposed).toBe(true) // the previous workspace's session is torn down
    expect(mocks.SessionManager.open).toHaveBeenCalledWith(fileB, undefined, wsB)
    expect(mocks.SessionManager.create).toHaveBeenCalledWith(wsB) // fresh session while switching
  })

  it('does not switch workspaces when opening a session of the current workspace', async () => {
    const ws = mkdtempSync(join(TMP, 'pi-ws-'))
    const file = join(sessionDirFor(ws), 's1.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{}')
    const session = new FakeSession()
    session.sessionFile = file
    mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined })
    const runtime = await initWithSessions(ws, [file])
    mocks.SessionManager.open.mockClear()
    const snap = await runtime.openSession(file)
    expect(snap.error).toBeNull()
    expect(snap.workspace?.path).toBe(ws)
    expect(snap.activeSessionPath).toBe(file)
    expect(mocks.SessionManager.open).not.toHaveBeenCalled() // active session: no-op
  })

  it('falls back to decoding the workspace from the session directory name for legacy sessions', async () => {
    const ws = mkdtempSync(join(TMP, 'piws')) // no literal `-` so the decode is unambiguous
    const file = join(sessionDirFor(ws), 'legacy.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{}')
    mocks.SessionManager.listAll.mockResolvedValue([
      { id: 's0', path: file, name: '', firstMessage: 'old', modified: new Date(0), messageCount: 1, cwd: '' },
    ])
    const runtime = await initRuntime(ws)
    const item = runtime.snapshot().sessions.find((s) => s.path === file)
    expect(item?.workspace?.path).toBe(ws) // decoded from `--<encoded-ws>--`
  })
})
