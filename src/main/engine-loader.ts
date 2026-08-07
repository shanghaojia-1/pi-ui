/**
 * Swappable pi-engine loader and manager.
 *
 * The GUI ships with a builtin engine (@earendil-works/pi-coding-agent in
 * node_modules, bundled into the asar). The user can install additional
 * engine versions under <userData>/engine/<version>/ via npm; an active
 * version is recorded in <userData>/engine/active.json and takes precedence
 * over the builtin on the next launch. Any failure (missing install, version
 * outside the supported range, corrupt package) falls back to the builtin so
 * the app can never fail to start because of a bad external engine.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { get } from 'node:https'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'

/** Runtime shape of the pi-coding-agent module (builtin or external). */
type EngineModule = typeof import('@earendil-works/pi-coding-agent')
import {
  ENGINE_PACKAGE, ENGINE_SUPPORTED_RANGE, isEngineVersion, sortVersionsDescending, versionInRange,
} from './engine-version'

export type EngineSource = 'builtin' | 'userdata'

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
  /** Fixed-text reason when the external engine failed and builtin is used. */
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
 * Loads the builtin engine through the normal module graph (asar-transparent
 * in the packaged app, mocked by vitest in tests). The package is ESM-only
 * (its exports map has no require condition), so a dynamic import is
 * required — createRequire would throw ERR_PACKAGE_PATH_NOT_EXPORTED.
 */
async function loadBuiltin(): Promise<EngineModule> {
  return await import(ENGINE_PACKAGE) as EngineModule
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
 * lifetime. External engine failures are recorded (surfaced in the settings
 * UI) and always fall back to the builtin.
 */
export async function loadEngineApi(): Promise<EngineModule> {
  if (cached !== null) return cached
  const requested = readActiveVersion()
  if (requested !== null) {
    if (!isEngineVersion(requested)) {
      loadError = `Engine version entry is invalid: ${requested}`
    } else {
      const root = enginePackageRoot(requested)
      const pkg = packageJsonOf(root)
      if (pkg === null || typeof pkg.version !== 'string') {
        loadError = `Installed engine ${requested} is missing or corrupt; using the builtin engine`
      } else if (!versionInRange(pkg.version)) {
        loadError = `Engine ${pkg.version} is outside the supported range (${ENGINE_SUPPORTED_RANGE}); using the builtin engine`
      } else {
        try {
          const api = await loadUserDataEngine(root, requested)
          cached = api
          active = { version: pkg.version, source: 'userdata', path: root }
          loadError = null
          return api
        } catch (error) {
          loadError = `Failed to load engine ${pkg.version}: ${error instanceof Error ? error.message : 'unknown error'}`
        }
      }
    }
  }
  cached = await loadBuiltin()
  active = null
  try {
    const version = await readBuiltinVersion()
    active = { version, source: 'builtin', path: ENGINE_PACKAGE }
  } catch { /* version unknown; active stays null */ }
  return cached
}

async function readBuiltinVersion(): Promise<string> {
  // The builtin package lives under the app path (project node_modules in
  // dev, asar-transparent node_modules in the packaged app). package.json
  // subpaths are NOT importable here (vite's resolver enforces the exports
  // map strictly), so resolve the file directly instead.
  const candidates = [
    join(app.getAppPath(), 'node_modules', ...ENGINE_PACKAGE.split('/'), 'package.json'),
  ]
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown }
      if (typeof pkg.version === 'string') return pkg.version
    } catch { /* try next */ }
  }
  throw new Error('builtin engine has no version')
}

/**
 * Synchronous accessor for the loaded engine API (runtime + IPC handlers).
 * loadEngineApi() must have completed at startup (index.ts awaits it before
 * runtime.initialize), so the cache is populated by the time any consumer
 * runs; an unloaded engine is a programming error and fails loudly.
 */
export function getEngineApi(): EngineModule {
  if (cached === null) throw new Error('Engine API not loaded — call loadEngineApi() at startup first')
  return cached
}

export function getEngineStatus(): EngineStatus {
  const installed = listInstalledVersions()
  let npm: { available: boolean; path: string | null } = { available: false, path: null }
  try {
    const found = findNpm()
    npm = found === null ? { available: false, path: null } : { available: true, path: found }
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
 * Locates a usable npm CLI: PATH first, then the common nvm and Homebrew
 * locations (Finder-launched apps inherit a minimal PATH on macOS). On
 * Windows npm is a .cmd shim and must run through the shell.
 */
function findNpm(): string | null {
  const candidates: string[] = []
  const probe = (command: string): boolean => {
    try {
      const result = spawnSync(command, ['--version'], {
        timeout: 5_000, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true,
      })
      return result.status === 0 && (result.stdout ?? '').trim().length > 0
    } catch {
      return false
    }
  }
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  if (probe(command)) return command
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
    if (existsSync(candidate) && probe(candidate)) return candidate
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
      npm,
      ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error', `${ENGINE_PACKAGE}@${version}`],
      // npm.cmd on Windows is a batch shim: it must run through the shell.
      // The version is regex-validated and the prefix is an internal path, so
      // no attacker-controlled input reaches the command line.
      { timeout: ENGINE_NPM_TIMEOUT_MS, windowsHide: true, shell: process.platform === 'win32' },
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

/** Clears any external activation (back to the builtin engine). */
export function deactivateEngine(): void {
  try { rmSync(activeFilePath(), { force: true }) } catch { /* best-effort */ }
}
