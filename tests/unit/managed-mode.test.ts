import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createManagedModeStore, MANAGED_MODE_FILENAME, MANAGED_MODE_MAX_BYTES,
  parseManagedModeFile, readPersistedMode, serializeManagedModeFile,
} from '../../src/main/managed-mode'

// Only the failure points are mocked; everything else passes through to the
// real filesystem so permissions/modes/atomicity stay observable.
const mocks = vi.hoisted(() => ({
  actual: {} as Record<string, (...args: unknown[]) => unknown>,
  open: vi.fn(),
  rename: vi.fn(),
  readFile: vi.fn(),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  mocks.actual = actual as unknown as Record<string, (...args: unknown[]) => unknown>
  return { ...actual, open: mocks.open, rename: mocks.rename, readFile: mocks.readFile }
})

const TMP = realpathSync(tmpdir())
const VALID = JSON.stringify({ version: 1, mode: 'managed' })
const createdDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(TMP, prefix))
  createdDirs.push(dir)
  return dir
}

function fileOf(dir: string): string {
  return join(dir, MANAGED_MODE_FILENAME)
}

function exists(path: string): boolean {
  try { statSync(path); return true } catch { return false }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.open.mockImplementation(mocks.actual.open!)
  mocks.rename.mockImplementation(mocks.actual.rename!)
  mocks.readFile.mockImplementation(mocks.actual.readFile!)
})

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('strict parse and serialize', () => {
  it('parses the exact valid shape and round-trips both modes', () => {
    expect(parseManagedModeFile(serializeManagedModeFile('ask'))).toEqual({ version: 1, mode: 'ask' })
    expect(parseManagedModeFile(serializeManagedModeFile('managed'))).toEqual({ version: 1, mode: 'managed' })
    expect(parseManagedModeFile('  {"version":1,"mode":"managed"}  ')).toEqual({ version: 1, mode: 'managed' })
  })

  it('rejects malformed JSON and non-objects', () => {
    for (const bad of ['', '   ', 'nope', '{', '[1,2]', '"managed"', 'null', '42', 'true', 'undefined']) {
      expect(parseManagedModeFile(bad)).toBeNull()
    }
  })

  it('rejects extra keys, wrong versions and wrong types', () => {
    for (const bad of [
      '{"version":1,"mode":"managed","extra":true}',
      '{"version":1,"mode":"ask","x":1}',
      '{"version":1}',
      '{"mode":"managed"}',
      '{"version":2,"mode":"managed"}',
      '{"version":0,"mode":"managed"}',
      '{"version":"1","mode":"managed"}',
      '{"version":null,"mode":"managed"}',
      '{"version":1,"mode":"auto"}',
      '{"version":1,"mode":"MANAGED"}',
      '{"version":1,"mode":true}',
      '{"version":1,"mode":1}',
      '{"version":1,"mode":null}',
      '{"version":1,"mode":["managed"]}',
      '{"version":1,"mode":{"mode":"managed"}}',
    ]) {
      expect(parseManagedModeFile(bad)).toBeNull()
    }
  })
})

describe('readPersistedMode fail-safe', () => {
  it('returns ask for a missing file', async () => {
    await expect(readPersistedMode(fileOf(tempDir('pi-mm-')))).resolves.toBe('ask')
  })

  it('returns the strict value for a valid file', async () => {
    const dir = tempDir('pi-mm-')
    writeFileSync(fileOf(dir), VALID)
    await expect(readPersistedMode(fileOf(dir))).resolves.toBe('managed')
  })
})

describe('ManagedModeStore load', () => {
  it('defaults to ask before any load and when the file is missing', async () => {
    const store = createManagedModeStore(tempDir('pi-mm-'))
    expect(store.getMode()).toBe('ask')
    await expect(store.load()).resolves.toBe('ask')
    expect(store.getMode()).toBe('ask')
  })

  it('loads a legal managed or ask file', async () => {
    const dir1 = tempDir('pi-mm-')
    writeFileSync(fileOf(dir1), '{"version":1,"mode":"managed"}')
    const s1 = createManagedModeStore(dir1)
    await expect(s1.load()).resolves.toBe('managed')
    expect(s1.getMode()).toBe('managed')

    const dir2 = tempDir('pi-mm-')
    writeFileSync(fileOf(dir2), '{"version":1,"mode":"ask"}')
    const s2 = createManagedModeStore(dir2)
    await expect(s2.load()).resolves.toBe('ask')
    expect(s2.getMode()).toBe('ask')
  })

  it('restarts into the persisted mode', async () => {
    const dir = tempDir('pi-mm-')
    const store = createManagedModeStore(dir)
    await store.setMode('managed')
    const restarted = createManagedModeStore(dir)
    await expect(restarted.load()).resolves.toBe('managed')
    expect(restarted.getMode()).toBe('managed')
  })

  it('fails closed to ask for empty, corrupt, extra-key, wrong-version and wrong-type files', async () => {
    const cases = [
      '',
      'not json at all',
      '{"version":1,"mode":"managed","extra":true}',
      '{"version":1,"mode":"ask","x":1}',
      '{"version":2,"mode":"managed"}',
      '{"version":"1","mode":"managed"}',
      '{"version":1,"mode":"auto"}',
      '{"version":1,"mode":true}',
      '{"version":1,"mode":1}',
      '{"version":1,"mode":null}',
      '{"version":1,"mode":["managed"]}',
    ]
    for (const content of cases) {
      const dir = tempDir('pi-mm-')
      writeFileSync(fileOf(dir), content)
      const store = createManagedModeStore(dir)
      await expect(store.load(), `content: ${JSON.stringify(content)}`).resolves.toBe('ask')
      expect(store.getMode()).toBe('ask')
    }
  })

  it('fails closed to ask for oversized files without reading them', async () => {
    const dir = tempDir('pi-mm-')
    writeFileSync(fileOf(dir), `${VALID}${' '.repeat(MANAGED_MODE_MAX_BYTES)}`)
    const store = createManagedModeStore(dir)
    await expect(store.load()).resolves.toBe('ask')
    expect(store.getMode()).toBe('ask')
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it('fails closed to ask for symlinked files', async () => {
    const dir = tempDir('pi-mm-')
    const real = join(dir, 'real.json')
    writeFileSync(real, VALID)
    symlinkSync(real, fileOf(dir), 'file')
    const store = createManagedModeStore(dir)
    await expect(store.load()).resolves.toBe('ask')
    expect(store.getMode()).toBe('ask')
  })

  it('fails closed to ask when the path is a directory', async () => {
    const dir = tempDir('pi-mm-')
    mkdirSync(fileOf(dir))
    const store = createManagedModeStore(dir)
    await expect(store.load()).resolves.toBe('ask')
    expect(store.getMode()).toBe('ask')
  })

  it('fails closed to ask when reading is denied', async () => {
    const dir = tempDir('pi-mm-')
    writeFileSync(fileOf(dir), VALID)
    mocks.readFile.mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
    const store = createManagedModeStore(dir)
    await expect(store.load()).resolves.toBe('ask')
    expect(store.getMode()).toBe('ask')
  })
})

describe('ManagedModeStore setMode', () => {
  it('persists both modes with POSIX 0600 file, 0700 directory and no temp residue', async () => {
    const parent = tempDir('pi-mm-')
    chmodSync(parent, 0o755)
    const dir = join(parent, 'nested')
    const store = createManagedModeStore(dir)

    await store.setMode('managed')
    expect(store.getMode()).toBe('managed')
    expect(parseManagedModeFile(readFileSync(fileOf(dir), 'utf8'))).toEqual({ version: 1, mode: 'managed' })
    expect(statSync(fileOf(dir)).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)

    await store.setMode('ask')
    expect(store.getMode()).toBe('ask')
    expect(parseManagedModeFile(readFileSync(fileOf(dir), 'utf8'))).toEqual({ version: 1, mode: 'ask' })
    expect(statSync(fileOf(dir)).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual([MANAGED_MODE_FILENAME])
  })

  it('serializes concurrent writes and the last call wins', async () => {
    const dir = tempDir('pi-mm-')
    const store = createManagedModeStore(dir)
    const p1 = store.setMode('managed')
    const p2 = store.setMode('ask')
    const p3 = store.setMode('managed')
    await Promise.all([p1, p2, p3])
    expect(store.getMode()).toBe('managed')
    expect(parseManagedModeFile(readFileSync(fileOf(dir), 'utf8'))).toEqual({ version: 1, mode: 'managed' })
  })

  it('fails closed to ask when a managed write is denied (permission)', async () => {
    const dir = tempDir('pi-mm-')
    const store = createManagedModeStore(dir)
    mocks.open.mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
    await expect(store.setMode('managed')).resolves.toBeUndefined() // silent fail-closed
    expect(store.getMode()).toBe('ask')
    expect(exists(fileOf(dir))).toBe(false)
    expect(readdirSync(dir)).toEqual([]) // no temp residue
  })

  it('fails closed to ask when rename fails, and the write chain continues', async () => {
    const dir = tempDir('pi-mm-')
    const store = createManagedModeStore(dir)
    mocks.rename.mockRejectedValueOnce(new Error('EXDEV: cross-device link'))
    await expect(store.setMode('managed')).resolves.toBeUndefined() // silent fail-closed
    expect(store.getMode()).toBe('ask')
    expect(readdirSync(dir)).toEqual([]) // temp was cleaned up

    await store.setMode('managed') // the chain survived the failure
    expect(store.getMode()).toBe('managed')
    expect(parseManagedModeFile(readFileSync(fileOf(dir), 'utf8'))).toEqual({ version: 1, mode: 'managed' })
  })

  it('keeps memory ask and rejects when persisting ask fails, unlinking the stale managed file', async () => {
    const dir = tempDir('pi-mm-')
    const store = createManagedModeStore(dir)
    await store.setMode('managed')
    mocks.rename.mockRejectedValueOnce(new Error('EIO: i/o error'))
    await expect(store.setMode('ask')).rejects.toThrow('Failed to persist tool approval mode')
    expect(store.getMode()).toBe('ask')
    // The stale 'managed' record is removed so a restart cannot restore it.
    expect(exists(fileOf(dir))).toBe(false)
    expect(readdirSync(dir)).toEqual([])
    const restarted = createManagedModeStore(dir)
    await expect(restarted.load()).resolves.toBe('ask')
  })
})
