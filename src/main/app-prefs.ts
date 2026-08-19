import { randomBytes } from 'node:crypto'
import {
  chmod, lstat, mkdir, open, readFile, rename, unlink,
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { isPlainObject } from '../shared/contracts'

/** File name of the persisted app-level preferences inside the store directory. */
export const APP_PREFS_FILENAME = 'app-prefs.json'
/** Only accepted version; any other version fails back to the defaults. */
export const APP_PREFS_VERSION = 1
/**
 * Bounded file size: a legitimate file is a few dozen bytes; anything larger
 * is treated as corrupt and falls back to the defaults before reading.
 */
export const APP_PREFS_MAX_BYTES = 4096

/** Default preference values (feature on; users opt out in Settings). */
export interface AppPrefs {
  notifyOnCompletion: boolean
}

export const DEFAULT_APP_PREFS: AppPrefs = { notifyOnCompletion: true }

/** Strict on-disk shape: exactly `{version:1,notifyOnCompletion:boolean}`. */
export interface AppPrefsFile {
  version: typeof APP_PREFS_VERSION
  notifyOnCompletion: boolean
}

export function serializeAppPrefsFile(prefs: AppPrefs): string {
  return JSON.stringify({ version: APP_PREFS_VERSION, notifyOnCompletion: prefs.notifyOnCompletion })
}

/**
 * Strict parser: the file must be a JSON object with exactly the `version`
 * and `notifyOnCompletion` keys, version === 1 and a boolean value. Malformed
 * JSON, non-objects, extra keys, wrong versions and wrong types all return
 * null — a preference is never derived from loose truthiness.
 */
export function parseAppPrefsFile(text: string): AppPrefsFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  const keys = Object.keys(parsed)
  if (keys.length !== 2 || !keys.includes('version') || !keys.includes('notifyOnCompletion')) return null
  if (parsed.version !== APP_PREFS_VERSION) return null
  if (typeof parsed.notifyOnCompletion !== 'boolean') return null
  return { version: APP_PREFS_VERSION, notifyOnCompletion: parsed.notifyOnCompletion }
}

/**
 * Fail-safe read: missing, empty, corrupt, oversized, non-regular, symlinked
 * or unreadable files all yield the defaults (notifications on). Never throws
 * and never derives enabled/disabled from loose truthiness.
 */
export async function readPersistedPrefs(filePath: string): Promise<AppPrefs> {
  try {
    const info = await lstat(filePath)
    if (!info.isFile()) return { ...DEFAULT_APP_PREFS } // symlink, directory, fifo, ...
    if (info.size === 0 || info.size > APP_PREFS_MAX_BYTES) return { ...DEFAULT_APP_PREFS }
    const raw = await readFile(filePath, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > APP_PREFS_MAX_BYTES) return { ...DEFAULT_APP_PREFS }
    const parsed = parseAppPrefsFile(raw)
    if (parsed === null) return { ...DEFAULT_APP_PREFS }
    return { notifyOnCompletion: parsed.notifyOnCompletion }
  } catch {
    return { ...DEFAULT_APP_PREFS } // missing file, permission errors, races, ...
  }
}

/**
 * Persisted app-level preferences (currently: completion notifications) with
 * atomic, serialized writes. The file lives at `<dir>/app-prefs.json`; writes
 * go through a random temp file in the same directory (wx flag), fsync,
 * close, atomic rename and final chmod. A failed write keeps the previous
 * in-memory value and rejects with fixed text (no paths in errors).
 */
export class AppPrefsStore {
  private prefs: AppPrefs = { ...DEFAULT_APP_PREFS }
  private readonly dirPath: string
  private readonly filePath: string
  private writeChain: Promise<void> = Promise.resolve()

  constructor(dirPath: string) {
    this.dirPath = dirPath
    this.filePath = join(dirPath, APP_PREFS_FILENAME)
  }

  /** Current in-memory prefs; defaults until load(), and after any write failure. */
  get(): AppPrefs {
    return { ...this.prefs }
  }

  /** Loads the persisted prefs; every failure yields the defaults (never throws). */
  async load(): Promise<AppPrefs> {
    this.prefs = await readPersistedPrefs(this.filePath)
    return this.get()
  }

  /**
   * Serialized writes: concurrent calls run in call order and the last call's
   * value wins. A failed write keeps the previous value in memory but only
   * rejects with fixed text so the caller can surface an error to the UI.
   */
  setEnabled(notifyOnCompletion: boolean): Promise<void> {
    const run = this.writeChain.then(() => this.persist(notifyOnCompletion))
    // Swallow failures inside the chain so later calls still execute.
    this.writeChain = run.catch(() => {})
    return run
  }

  private async persist(notifyOnCompletion: boolean): Promise<void> {
    const tempPath = join(this.dirPath, `.${APP_PREFS_FILENAME}.${randomBytes(8).toString('hex')}.tmp`)
    try {
      await mkdir(this.dirPath, { recursive: true, mode: 0o700 })
      const handle = await open(tempPath, 'wx', 0o600)
      try {
        await handle.writeFile(serializeAppPrefsFile({ notifyOnCompletion }), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await chmod(tempPath, 0o600).catch(() => {})
      await rename(tempPath, this.filePath) // atomic replace
      await chmod(this.filePath, 0o600).catch(() => {}) // final chmod; best effort
      this.prefs = { notifyOnCompletion }
    } catch {
      throw new Error('Failed to persist app preferences')
    } finally {
      // Never leave temp files behind.
      await unlink(tempPath).catch(() => {})
    }
  }
}

/** Factory taking an explicit directory path (main passes app.getPath('userData')). */
export function createAppPrefsStore(dirPath: string): AppPrefsStore {
  return new AppPrefsStore(dirPath)
}