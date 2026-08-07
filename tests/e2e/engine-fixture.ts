import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Gives an isolated Electron profile an explicitly configured development Pi.
 * The app itself has no builtin fallback; E2E tests opt in by linking the
 * repository's devDependency into the same user-data layout produced by the
 * first-run installer.
 */
export function seedConfiguredEngine(
  userData: string,
  projectRoot: string,
  options: { activate?: boolean } = {},
): string {
  const source = join(projectRoot, 'node_modules', '@earendil-works', 'pi-coding-agent')
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { version: string }
  const target = join(userData, 'engine', pkg.version, 'node_modules', '@earendil-works', 'pi-coding-agent')
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
  mkdirSync(join(userData, 'engine'), { recursive: true })
  if (options.activate !== false) {
    writeFileSync(join(userData, 'engine', 'active.json'), JSON.stringify({ version: pkg.version }))
  }
  return pkg.version
}
