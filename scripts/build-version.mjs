#!/usr/bin/env node
/**
 * Build version for packaging: `0.1.0-<short-git-hash>`.
 *
 * Every packaged artifact gets the current commit hash as a semver
 * prerelease suffix, so successive builds are distinguishable without
 * bumping package.json. Falls back to the plain package version when git is
 * unavailable (e.g. a source tarball without .git).
 *
 * Usage:
 *   node scripts/build-version.mjs     # prints the version
 *   import { buildVersion } from ...
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function buildVersion() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const base = typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0'
  try {
    const hash = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8', timeout: 5_000 })
      .trim()
      .replace(/[^A-Za-z0-9-]/g, '')
    if (hash.length === 0) return base
    return `${base}-${hash}`
  } catch {
    return base
  }
}

// CLI entry: prints the version when run directly.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(buildVersion())
}
