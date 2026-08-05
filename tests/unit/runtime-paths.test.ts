import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { canonicalizeEvenIfMissing, PiRuntime } from '../../src/main/runtime'

const mocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  getAgentDir: vi.fn(),
  ModelRuntime: { create: vi.fn() },
  SessionManager: { create: vi.fn(), open: vi.fn(), list: vi.fn() },
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

const TMP = realpathSync(tmpdir())

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
  mocks.SessionManager.list.mockResolvedValue([])
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
  async function initWithSessions(workspace: string, listed: string[]): Promise<PiRuntime> {
    mocks.SessionManager.list.mockResolvedValue(listed.map((path, i) => ({
      id: `s${i}`, path, name: '', firstMessage: 'first', modified: new Date(0), messageCount: 1,
    })))
    return initRuntime(workspace)
  }

  it('opens a regular, listed session file', async () => {
    const ws = mkdtempSync(join(TMP, 'pi-ws-'))
    const file = join(ws, 's1.jsonl')
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
    const file = join(ws, 's1.jsonl')
    writeFileSync(file, '{}')
    const runtime = await initRuntime(ws) // empty session active
    mocks.SessionManager.list.mockResolvedValue([
      { id: 's0', path: file, name: '', firstMessage: 'first', modified: new Date(1), messageCount: 1 },
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
    const real = join(ws, 'real.jsonl')
    writeFileSync(real, '{}')
    const link = join(ws, 'link.jsonl')
    symlinkSync(real, link, 'file')
    const runtime = await initWithSessions(ws, [real, link])

    let snap = await runtime.openSession(link)
    expect(snap.error?.detail).toContain('Session must be a regular file')

    snap = await runtime.openSession(ws) // a directory, not a file
    expect(snap.error?.detail).toContain('Session must be a regular file')
  })

  it('rejects session files not listed in the workspace allowlist', async () => {
    const ws = mkdtempSync(join(TMP, 'pi-ws-'))
    const file = join(ws, 's.jsonl')
    writeFileSync(file, '{}')
    const runtime = await initWithSessions(ws, [])
    const snap = await runtime.openSession(file)
    expect(snap.error?.detail).toContain('Session does not belong to this workspace')
  })

  it('rejects files outside the workspace session directory even when listed', async () => {
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
    const file = join(ws, 's1.jsonl')
    writeFileSync(file, '{}')
    mocks.SessionManager.list.mockResolvedValue([
      { id: 's0', path: file, name: '', firstMessage: 'first', modified: new Date(1), messageCount: 1 },
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
    const real = join(ws, 'real.jsonl')
    writeFileSync(real, '{}')
    const link = join(ws, 'link.jsonl')
    symlinkSync(real, link, 'file')
    mocks.SessionManager.list.mockResolvedValue([
      { id: 's0', path: link, name: '', firstMessage: 'first', modified: new Date(1), messageCount: 1 },
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

  it('skips a listed session outside the session directory on restore', async () => {
    const ws = mkdtempSync(join(TMP, 'pi-ws-'))
    const outside = mkdtempSync(join(TMP, 'pi-out-'))
    const file = join(outside, 's.jsonl')
    writeFileSync(file, '{}')
    mocks.SessionManager.list.mockResolvedValue([
      { id: 's0', path: file, name: '', firstMessage: 'first', modified: new Date(1), messageCount: 1 },
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
    const file = join(ws, 's1.jsonl')
    writeFileSync(file, '{}')
    mocks.SessionManager.list.mockResolvedValue([
      { id: 's0', path: file, name: '', firstMessage: 'first', modified: new Date(1), messageCount: 1 },
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
    const file = join(ws, 's1.jsonl')
    writeFileSync(file, '{}')
    mocks.SessionManager.list.mockResolvedValue([
      { id: 's0', path: file, name: '', firstMessage: 'first', modified: new Date(1), messageCount: 1 },
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
    const file = join(ws, 's1.jsonl')
    writeFileSync(file, 'corrupt')
    mocks.SessionManager.list.mockResolvedValue([
      { id: 's0', path: file, name: '', firstMessage: 'first', modified: new Date(1), messageCount: 1 },
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
