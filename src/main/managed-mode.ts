import { randomBytes } from 'node:crypto'
import {
  chmod, lstat, mkdir, open, readFile, rename, unlink,
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { isPlainObject, isToolApprovalMode, type ToolApprovalMode } from '../shared/contracts'

/** File name of the persisted tool-approval mode inside the store directory. */
export const MANAGED_MODE_FILENAME = 'managed-mode.json'
/** Only accepted version; any other version fails closed to 'ask'. */
export const MANAGED_MODE_VERSION = 1
/**
 * Bounded file size: a legitimate file is a few dozen bytes; anything larger
 * is treated as corrupt and fails closed to 'ask' before reading.
 */
export const MANAGED_MODE_MAX_BYTES = 4096

/** Strict on-disk shape: exactly `{version:1,mode:'ask'|'managed'}`. */
export interface ManagedModeFile {
  version: typeof MANAGED_MODE_VERSION
  mode: ToolApprovalMode
}

export function serializeManagedModeFile(mode: ToolApprovalMode): string {
  return JSON.stringify({ version: MANAGED_MODE_VERSION, mode })
}

/**
 * Strict parser: the file must be a JSON object with exactly the `version`
 * and `mode` keys, version === 1 and mode one of 'ask' | 'managed'. Malformed
 * JSON, non-objects, extra keys, wrong versions and wrong types all return
 * null — a mode is never derived from loose truthiness.
 */
export function parseManagedModeFile(text: string): ManagedModeFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  const keys = Object.keys(parsed)
  if (keys.length !== 2 || !keys.includes('version') || !keys.includes('mode')) return null
  if (parsed.version !== MANAGED_MODE_VERSION) return null
  if (!isToolApprovalMode(parsed.mode)) return null
  return { version: MANAGED_MODE_VERSION, mode: parsed.mode }
}

/**
 * Fail-safe read: missing, empty, corrupt, oversized, non-regular, symlinked
 * or unreadable files all yield 'ask'. Never throws and never enables a mode
 * without a strict parse.
 */
export async function readPersistedMode(filePath: string): Promise<ToolApprovalMode> {
  try {
    const info = await lstat(filePath)
    if (!info.isFile()) return 'ask' // symlink, directory, fifo, ...
    if (info.size === 0 || info.size > MANAGED_MODE_MAX_BYTES) return 'ask'
    const raw = await readFile(filePath, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MANAGED_MODE_MAX_BYTES) return 'ask'
    return parseManagedModeFile(raw)?.mode ?? 'ask'
  } catch {
    return 'ask' // missing file, permission errors, races, ...
  }
}

/**
 * Persisted tool-approval mode with strict fail-closed semantics. The file
 * lives at `<dir>/managed-mode.json`; writes go through a random temp file in
 * the same directory (wx flag), fsync, close, atomic rename and final chmod.
 */
export class ManagedModeStore {
  private mode: ToolApprovalMode = 'ask'
  private readonly dirPath: string
  private readonly filePath: string
  private writeChain: Promise<void> = Promise.resolve()

  constructor(dirPath: string) {
    this.dirPath = dirPath
    this.filePath = join(dirPath, MANAGED_MODE_FILENAME)
  }

  /** Current in-memory mode; 'ask' until load(), and after any write failure. */
  getMode(): ToolApprovalMode {
    return this.mode
  }

  /** Loads the persisted mode; every failure yields 'ask' (never throws). */
  async load(): Promise<ToolApprovalMode> {
    this.mode = await readPersistedMode(this.filePath)
    return this.mode
  }

  /**
   * Serialized writes: concurrent calls run in call order and the last call's
   * mode wins. A failed 'managed' write fails closed to 'ask' in memory
   * (silent). A failed 'ask' write also fails closed immediately, removes any
   * stale managed-mode.json (best effort) so a restart cannot restore a
   * dangerous mode, and rejects with fixed text so the caller can surface an
   * error to the UI. Error text never includes the path or underlying detail.
   */
  setMode(mode: ToolApprovalMode): Promise<void> {
    const run = this.writeChain.then(() => this.persist(mode))
    // Swallow failures inside the chain so later calls still execute.
    this.writeChain = run.catch(() => {})
    return run
  }

  private async persist(mode: ToolApprovalMode): Promise<void> {
    const tempPath = join(this.dirPath, `.${MANAGED_MODE_FILENAME}.${randomBytes(8).toString('hex')}.tmp`)
    try {
      await mkdir(this.dirPath, { recursive: true, mode: 0o700 })
      const handle = await open(tempPath, 'wx', 0o600)
      try {
        await handle.writeFile(serializeManagedModeFile(mode), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      // The temp never keeps a broader mode than the final file; best effort.
      await chmod(tempPath, 0o600).catch(() => {})
      await rename(tempPath, this.filePath) // atomic replace
      await chmod(this.filePath, 0o600).catch(() => {}) // final chmod; best effort
      await this.fsyncDir() // best effort
      this.mode = mode
    } catch {
      // Fail closed: memory never claims 'managed' without a durable write.
      this.mode = 'ask'
      if (mode === 'ask') {
        // Without a durable 'ask' record a restart could restore the old
        // 'managed' file; remove it (best effort) and reject with fixed text.
        await unlink(this.filePath).catch(() => {})
        throw new Error('Failed to persist tool approval mode')
      }
      // A failed 'managed' write silently fails closed to 'ask'.
    } finally {
      // Never leave temp files behind.
      await unlink(tempPath).catch(() => {})
    }
  }

  /** Directory fsync makes the rename durable; best effort (unsupported on Windows). */
  private async fsyncDir(): Promise<void> {
    let handle: FileHandle | null = null
    try {
      handle = await open(this.dirPath, 'r')
      await handle.sync()
    } catch {
      // best effort
    } finally {
      if (handle) await handle.close().catch(() => {})
    }
  }
}

/** Factory taking an explicit directory path (main passes app.getPath('userData')). */
export function createManagedModeStore(dirPath: string): ManagedModeStore {
  return new ManagedModeStore(dirPath)
}
