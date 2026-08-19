import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APP_PREFS_FILENAME, DEFAULT_APP_PREFS, parseAppPrefsFile, readPersistedPrefs,
  serializeAppPrefsFile, AppPrefsStore,
} from '../../src/main/app-prefs'

const TMP = realpathSync(tmpdir())
let dirs: string[] = []
let mainDir: string
let mainFile: string

beforeAll(() => {
  mainDir = mkdtempSync(join(TMP, 'app-prefs-'))
  dirs.push(mainDir)
  mainFile = join(mainDir, APP_PREFS_FILENAME)
})

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function freshDir(): string {
  const d = mkdtempSync(join(TMP, 'app-prefs-'))
  dirs.push(d)
  return d
}

describe('serialize/parse', () => {
  it('round-trips the canonical shape', () => {
    const parsed = parseAppPrefsFile(serializeAppPrefsFile({ notifyOnCompletion: false }))
    expect(parsed).toEqual({ version: 1, notifyOnCompletion: false })
  })

  it('rejects malformed JSON, non-objects, extra keys, wrong versions and non-booleans', () => {
    expect(parseAppPrefsFile('')).toBeNull()
    expect(parseAppPrefsFile('[]')).toBeNull()
    expect(parseAppPrefsFile('"x"')).toBeNull()
    expect(parseAppPrefsFile('{ "version": 1, "notifyOnCompletion": true, "surprise": 1 }')).toBeNull()
    expect(parseAppPrefsFile('{ "version": 2, "notifyOnCompletion": true }')).toBeNull()
    expect(parseAppPrefsFile('{ "version": 1, "notifyOnCompletion": 1 }')).toBeNull()
    expect(parseAppPrefsFile('{ "notifyOnCompletion": true }')).toBeNull()
  })
})

describe('readPersistedPrefs', () => {
  it('returns the defaults for a missing file', async () => {
    expect(await readPersistedPrefs(join(freshDir(), 'nope.json'))).toEqual(DEFAULT_APP_PREFS)
  })

  it('returns the persisted value for a valid file', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, APP_PREFS_FILENAME), serializeAppPrefsFile({ notifyOnCompletion: false }))
    expect(await readPersistedPrefs(join(dir, APP_PREFS_FILENAME))).toEqual({ notifyOnCompletion: false })
  })

  it('returns the defaults for corrupt, oversized, empty and symlinked files', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, APP_PREFS_FILENAME), 'not json')
    expect(await readPersistedPrefs(join(dir, APP_PREFS_FILENAME))).toEqual(DEFAULT_APP_PREFS)
    writeFileSync(join(dir, APP_PREFS_FILENAME), '')
    expect(await readPersistedPrefs(join(dir, APP_PREFS_FILENAME))).toEqual(DEFAULT_APP_PREFS)
    writeFileSync(join(dir, APP_PREFS_FILENAME), 'x'.repeat(5000))
    expect(await readPersistedPrefs(join(dir, APP_PREFS_FILENAME))).toEqual(DEFAULT_APP_PREFS)
    const linkDir = freshDir() // freshDir already creates the directory
    if (process.platform !== 'win32') {
      symlinkSync(join(dir, APP_PREFS_FILENAME), join(linkDir, APP_PREFS_FILENAME))
      expect(await readPersistedPrefs(join(linkDir, APP_PREFS_FILENAME))).toEqual(DEFAULT_APP_PREFS)
    }
  })
})

describe('AppPrefsStore', () => {
  it('starts with the defaults, persists atomically and reloads the persisted value', async () => {
    const dir = freshDir()
    const store = new AppPrefsStore(dir)
    expect(store.get()).toEqual(DEFAULT_APP_PREFS)
    await store.load()
    expect(store.get()).toEqual(DEFAULT_APP_PREFS)
    await store.setEnabled(false)
    expect(store.get()).toEqual({ notifyOnCompletion: false })
    // Atomic write: the final file exists with the expected strict shape.
    expect(parseAppPrefsFile(readFileSync(join(dir, APP_PREFS_FILENAME), 'utf8'))).toEqual({ version: 1, notifyOnCompletion: false })
    // No temp residue after the write.
    expect(existsSync(join(dir, '.app-prefs.json.'))).toBe(false)

    const reloaded = new AppPrefsStore(dir)
    await reloaded.load()
    expect(reloaded.get()).toEqual({ notifyOnCompletion: false })
  })

  it('serializes concurrent setEnabled calls in order', async () => {
    const store = new AppPrefsStore(freshDir())
    await Promise.all([store.setEnabled(false), store.setEnabled(true), store.setEnabled(false)])
    expect(store.get()).toEqual({ notifyOnCompletion: false })
  })
})