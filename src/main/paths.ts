import { basename, dirname, resolve } from 'node:path'
import { realpathSync } from 'node:fs'

/**
 * Canonicalizes `path` even when trailing segments do not exist yet: the nearest
 * existing ancestor is realpath'd and the missing suffix is re-appended. Throws
 * only if no ancestor at all can be resolved.
 */
export const canonicalizeEvenIfMissing = (path: string): string => {
  let current = resolve(path)
  const missing: string[] = []
  for (;;) {
    try { return missing.length === 0 ? realpathSync(current) : resolve(realpathSync(current), ...missing) }
    catch {
      const parent = dirname(current)
      if (parent === current) throw new Error(`Cannot canonicalize path: ${path}`)
      missing.unshift(basename(current))
      current = parent
    }
  }
}
