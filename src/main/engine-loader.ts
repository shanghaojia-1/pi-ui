/**
 * Swappable pi-engine loader and manager.
 *
 * Pi Studio deliberately does not ship a runtime engine. The user installs a
 * compatible version under <userData>/engine/<version>/ and the selected
 * version is recorded in <userData>/engine/active.json. A missing, corrupt or
 * incompatible selection leaves the engine unconfigured so the renderer can
 * show first-run setup; it never silently falls back to a different Pi.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { delimiter } from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { get } from 'node:https'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'

/** Runtime shape of the pi-coding-agent module (builtin or external). */
type EngineModule = typeof import('@earendil-works/pi-coding-agent')
import {
  ENGINE_PACKAGE, ENGINE_SUPPORTED_RANGE, isEngineVersion, sortVersionsDescending, versionInRange,
} from './engine-version'

export type EngineSource = 'userdata'

export interface ActiveEngine {
  version: string
  source: EngineSource
  path: string
}

export interface EngineStatus {
  active: ActiveEngine | null
  /** True when the active engine is inside the GUI's supported range. */
  compatible: boolean
  supportedRange: string
  /** Installed external versions (dir names under <userData>/engine/). */
  installed: string[]
  npm: { available: boolean; path: string | null }
  /** Directory external engines are installed into (for manual install hints). */
  installDir: string
  /** Fixed-text reason why the configured engine could not be loaded. */
  error: string | null
}

const ACTIVE_FILE = 'active.json'
const ENGINE_NPM_TIMEOUT_MS = 10 * 60 * 1000
const REGISTRY = 'https://registry.npmjs.org'

let cached: EngineModule | null = null
let active: ActiveEngine | null = null
let loadError: string | null = null

function engineRoot(): string {
  return join(app.getPath('userData'), 'engine')
}

function activeFilePath(): string {
  return join(engineRoot(), ACTIVE_FILE)
}

/** <userData>/engine/<version>/node_modules/@earendil-works/pi-coding-agent */
function enginePackageRoot(version: string): string {
  return join(engineRoot(), version, 'node_modules', ...ENGINE_PACKAGE.split('/'))
}

function packageJsonOf(root: string): { version?: unknown; main?: unknown } | null {
  const path = join(root, 'package.json')
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as { version?: unknown; main?: unknown }
  } catch {
    return null
  }
}

function readActiveVersion(): string | null {
  const path = activeFilePath()
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/**
 * Loads an externally installed engine package from disk. The package root is
 * the npm-installed @earendil-works/pi-coding-agent; its main entry is read
 * from package.json and imported as a file URL.
 */
async function loadUserDataEngine(root: string, version: string): Promise<EngineModule> {
  const pkg = packageJsonOf(root)
  const main = typeof pkg?.main === 'string' && pkg.main.length > 0 ? pkg.main : 'dist/index.js'
  return await import(pathToFileURL(join(root, main)).href) as EngineModule
}

/**
 * Loads and caches the engine API. Called once at startup before the runtime
 * initializes; the cached result is served by getEngineApi() for the app's
 * lifetime. `null` means first-run setup is required. A failed selection is
 * surfaced in the setup UI and never substituted with another engine.
 */
export async function loadEngineApi(): Promise<EngineModule | null> {
  if (cached !== null) return cached
  const requested = readActiveVersion()
  active = null
  if (requested === null) {
    loadError = null
    return null
  }
  if (!isEngineVersion(requested)) {
    loadError = `Engine version entry is invalid: ${requested}`
    return null
  }
  const root = enginePackageRoot(requested)
  const pkg = packageJsonOf(root)
  if (pkg === null || typeof pkg.version !== 'string') {
    loadError = `Installed engine ${requested} is missing or corrupt`
    return null
  }
  if (!versionInRange(pkg.version)) {
    loadError = `Engine ${pkg.version} is outside the supported range (${ENGINE_SUPPORTED_RANGE})`
    return null
  }
  try {
    const api = await loadUserDataEngine(root, requested)
    cached = api
    active = { version: pkg.version, source: 'userdata', path: root }
    loadError = null
    return api
  } catch (error) {
    loadError = `Failed to load engine ${pkg.version}: ${error instanceof Error ? error.message : 'unknown error'}`
    return null
  }
}

/**
 * Synchronous accessor for the loaded engine API (runtime + IPC handlers).
 * loadEngineApi() must have completed at startup (index.ts awaits it before
 * runtime.initialize), so the cache is populated by the time any consumer
 * runs; an unloaded engine is a programming error and fails loudly.
 */
export function getEngineApi(): EngineModule {
  if (cached === null) throw new Error('Pi engine is not configured')
  return cached
}

export function getEngineStatus(): EngineStatus {
  const installed = listInstalledVersions()
  let npm: { available: boolean; path: string | null } = { available: false, path: null }
  try {
    const found = findNpm()
    npm = found === null ? { available: false, path: null } : { available: true, path: found.command }
  } catch { /* npm probing is best-effort */ }
  return {
    active,
    compatible: active !== null && versionInRange(active.version),
    supportedRange: ENGINE_SUPPORTED_RANGE,
    installed,
    npm,
    installDir: engineRoot(),
    error: loadError,
  }
}

function listInstalledVersions(): string[] {
  const root = engineRoot()
  if (!existsSync(root)) return []
  let entries: string[]
  try { entries = readdirSync(root, { withFileTypes: true }).map((entry) => entry.name) } catch { return [] }
  const installed = entries.filter((name) => isEngineVersion(name) && packageJsonOf(enginePackageRoot(name)) !== null)
  return sortVersionsDescending(installed)
}

/** Fetch versions compatible with the GUI from the npm registry (newest first, capped). */
export async function listRegistryVersions(): Promise<string[]> {
  const versions = await new Promise<string[]>((resolve, reject) => {
    const request = get(`${REGISTRY}/${ENGINE_PACKAGE.replace('/', '%2F')}`, { timeout: 15_000 }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`Registry responded with ${response.statusCode ?? 'no status'}`))
        return
      }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(body)
          const versions = (parsed as { versions?: Record<string, unknown> } | null)?.versions
          if (typeof versions !== 'object' || versions === null) {
            reject(new Error('Registry returned no versions'))
            return
          }
          resolve(Object.keys(versions))
        } catch {
          reject(new Error('Registry response was not valid JSON'))
        }
      })
    })
    request.on('error', () => reject(new Error('Could not reach the npm registry')))
    request.on('timeout', () => { request.destroy(); reject(new Error('Registry request timed out')) })
  })
  return sortVersionsDescending(versions.filter((version) => versionInRange(version))).slice(0, 20)
}

/**
 * Resolved filesystem path of the configured engine package. Both the main
 * session SDK and the subagent CLI are loaded from this exact directory.
 */
export function getEnginePackagePath(): string {
  if (active === null) throw new Error('Pi engine is not configured')
  return active.path
}

/**
 * Locates a usable npm CLI: PATH first, then the common nvm and Homebrew
 * locations (Finder-launched apps inherit a minimal PATH on macOS). On
 * Windows npm is a .cmd shim and must run through the shell.
 */
interface ResolvedNpm {
  command: string
  /** PATH prefix (bin dir of the resolved npm) so its shebang can find node. */
  env: NodeJS.ProcessEnv
}

/**
 * Locates a usable npm CLI: PATH first, then the common nvm and Homebrew
 * locations (Finder-launched apps inherit a minimal PATH on macOS). npm is a
 * node script with a `#!/usr/bin/env node` shebang, so probing a candidate
 * MUST add its own bin dir to PATH — otherwise the shebang cannot resolve
 * `node` and the probe fails even though npm exists. On Windows npm is a
 * .cmd shim and must run through the shell.
 */
export function findNpm(): ResolvedNpm | null {
  const candidates: string[] = []
  const probe = (command: string, extraBinDir?: string): boolean => {
    try {
      const env = extraBinDir
        ? { ...process.env, PATH: `${extraBinDir}${delimiter}${process.env.PATH ?? ''}` }
        : undefined
      const result = spawnSync(command, ['--version'], {
        timeout: 5_000, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, env,
      })
      return result.status === 0 && (result.stdout ?? '').trim().length > 0
    } catch {
      return false
    }
  }
  const baseEnv = (binDir: string): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` })
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  if (probe(command)) return { command, env: process.env }
  if (process.platform !== 'win32') {
    const home = process.env.HOME ?? ''
    const nvmRoots: string[] = []
    try {
      const versions = readdirSync(join(home, '.nvm', 'versions', 'node')).sort()
      for (const version of versions) nvmRoots.push(join(home, '.nvm', 'versions', 'node', version, 'bin', 'npm'))
    } catch { /* no nvm */ }
    candidates.push(...nvmRoots, '/opt/homebrew/bin/npm', '/usr/local/bin/npm')
  }
  for (const candidate of candidates) {
    // Probe with the candidate's own bin dir on PATH so the npm shebang can
    // resolve `node` even when the GUI inherited a minimal PATH (Finder
    // launch on macOS).
    if (existsSync(candidate) && probe(candidate, dirname(candidate))) {
      return { command: candidate, env: baseEnv(dirname(candidate)) }
    }
  }
  return null
}

/**
 * Installs an engine version with npm into <userData>/engine/<version>/.
 * The full dependency tree is resolved by npm itself. Throws on failure.
 */
export async function installEngineVersion(version: string): Promise<void> {
  if (!isEngineVersion(version)) throw new Error('Invalid engine version')
  const npm = findNpm()
  if (npm === null) throw new Error('npm was not found on this system')
  const root = engineRoot()
  mkdirSync(root, { recursive: true })
  const prefix = join(root, version)
  if (existsSync(prefix)) rmSync(prefix, { recursive: true, force: true })
  await new Promise<void>((resolve, reject) => {
    execFile(
      npm.command,
      ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error', `${ENGINE_PACKAGE}@${version}`],
      // npm.cmd on Windows is a batch shim: it must run through the shell.
      // The version is regex-validated and the prefix is an internal path, so
      // no attacker-controlled input reaches the command line. The resolved
      // env keeps node resolvable for the npm shebang (minimal GUI PATH).
      { timeout: ENGINE_NPM_TIMEOUT_MS, windowsHide: true, shell: process.platform === 'win32', env: npm.env },
      (error) => {
        if (error) {
          try { rmSync(prefix, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
          reject(new Error(`npm install failed: ${error.message}`))
          return
        }
        if (packageJsonOf(enginePackageRoot(version)) === null) {
          try { rmSync(prefix, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
          reject(new Error('npm finished but the engine package is missing'))
          return
        }
        resolve()
      },
    )
  })
}

/** Activates an installed version for the NEXT launch (persisted to active.json). */
export function activateEngineVersion(version: string): void {
  if (!isEngineVersion(version)) throw new Error('Invalid engine version')
  if (packageJsonOf(enginePackageRoot(version)) === null) throw new Error('Engine is not installed')
  const root = engineRoot()
  mkdirSync(root, { recursive: true })
  writeFileSync(activeFilePath(), JSON.stringify({ version }, null, 2))
}

/** Removes an installed version; clears activation if it was active. */
export function uninstallEngineVersion(version: string): void {
  if (!isEngineVersion(version)) throw new Error('Invalid engine version')
  const path = join(engineRoot(), version)
  if (!existsSync(path)) return
  rmSync(path, { recursive: true, force: true })
  if (readActiveVersion() === version) {
    try { rmSync(activeFilePath(), { force: true }) } catch { /* best-effort */ }
  }
}

/** Clears the configured engine; the next launch returns to first-run setup. */
export function deactivateEngine(): void {
  try { rmSync(activeFilePath(), { force: true }) } catch { /* best-effort */ }
}
