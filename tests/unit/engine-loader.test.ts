import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Integration tests for the engine loader against the REAL filesystem and the
 * REAL builtin package (no module mocks). Each test gets a fresh loader with
 * its own userData dir via vi.resetModules + vi.doMock, so the module-level
 * engine cache cannot leak between tests.
 */
async function freshLoader(userData: string): Promise<typeof import('../../src/main/engine-loader')> {
  vi.resetModules()
  vi.doMock('electron', () => ({ app: { getPath: () => userData, getAppPath: () => process.cwd() } }))
  return await import('../../src/main/engine-loader')
}

/** Writes a fake external engine package (ESM, matching the real package shape). */
function writeFakeEngine(userData: string, version: string): string {
  const root = join(userData, 'engine', version, 'node_modules', '@earendil-works', 'pi-coding-agent')
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-coding-agent',
    version,
    type: 'module',
    main: './dist/index.js',
  }, null, 2))
  writeFileSync(join(root, 'dist', 'index.js'), `export const marker = 'external-${version}';\nexport const createAgentSession = () => 'fake';\n`)
  return root
}

function activate(userData: string, version: string): void {
  mkdirSync(join(userData, 'engine'), { recursive: true })
  writeFileSync(join(userData, 'engine', 'active.json'), JSON.stringify({ version }))
}

const TMP_ROOT = mkdtempSync(join(realpathSync(tmpdir()), 'engine-loader-test-'))

afterEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
  mkdirSync(TMP_ROOT, { recursive: true })
})

describe('engine-loader npm discovery', () => {
  it('finds nvm npm even when the GUI inherited a minimal PATH (Finder launch)', async () => {
    // Simulate a Finder-launched GUI: minimal PATH, no node/npm anywhere on it,
    // npm living only under a fake ~/.nvm with a `#!/usr/bin/env node` shebang.
    const home = join(TMP_ROOT, 'finder-home')
    const bin = join(home, '.nvm', 'versions', 'node', 'v24.5.0', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'node'), '#!/bin/sh\necho v24.5.0\n')
    writeFileSync(join(bin, 'npm'), '#!/usr/bin/env node\nconsole.log("9.0.0")\n')
    chmodSync(join(bin, 'node'), 0o755)
    chmodSync(join(bin, 'npm'), 0o755)

    const originalHome = process.env.HOME
    const originalPath = process.env.PATH
    try {
      process.env.HOME = home
      // Minimal PATH: /usr/bin /bin /usr/sbin /sbin (no node, no npm).
      process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
      const loader = await freshLoader(join(TMP_ROOT, 'finder-userdata'))
      const status = loader.getEngineStatus()
      expect(status.npm.available).toBe(true)
      expect(status.npm.path).toBe(join(bin, 'npm'))
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })
})

describe('engine-loader builtin path', () => {
  it('loads the REAL builtin engine via dynamic import (no createRequire)', async () => {
    const loader = await freshLoader(join(TMP_ROOT, 'a'))
    const api = await loader.loadEngineApi()
    expect(typeof api.createAgentSession).toBe('function')
    expect(typeof api.getAgentDir).toBe('function')
    expect(typeof api.ModelRuntime.create).toBe('function')
    expect(loader.getEngineStatus().active?.source).toBe('builtin')
    expect(loader.getEngineStatus().compatible).toBe(true)
    expect(loader.getEngineApi()).toBe(api)
  })

  it('falls back to the builtin when the activated version is not installed', async () => {
    const userData = join(TMP_ROOT, 'b')
    activate(userData, '0.99.0')
    const loader = await freshLoader(userData)
    const api = await loader.loadEngineApi()
    expect(typeof api.createAgentSession).toBe('function')
    expect(loader.getEngineStatus().active?.source).toBe('builtin')
    expect(loader.getEngineStatus().error).toMatch(/missing or corrupt/)
  })

  it('falls back to the builtin when the activated version is outside the supported range', async () => {
    const userData = join(TMP_ROOT, 'c')
    writeFakeEngine(userData, '0.99.0')
    activate(userData, '0.99.0')
    const loader = await freshLoader(userData)
    const api = await loader.loadEngineApi()
    expect(typeof api.createAgentSession).toBe('function')
    expect(loader.getEngineStatus().active?.source).toBe('builtin')
    expect(loader.getEngineStatus().error).toMatch(/outside the supported range/)
  })
})

describe('engine-loader external path', () => {
  it('loads an activated external engine from the userData directory', async () => {
    const userData = join(TMP_ROOT, 'd')
    writeFakeEngine(userData, '0.84.2')
    activate(userData, '0.84.2')
    const loader = await freshLoader(userData)
    const api = await loader.loadEngineApi()
    expect((api as { marker?: string }).marker).toBe('external-0.84.2')
    const status = loader.getEngineStatus()
    expect(status.active).toEqual({
      version: '0.84.2',
      source: 'userdata',
      path: join(userData, 'engine', '0.84.2', 'node_modules', '@earendil-works', 'pi-coding-agent'),
    })
    expect(status.compatible).toBe(true)
    expect(status.installed).toEqual(['0.84.2'])
  })

  it('lists installed versions newest-first and reports installDir', async () => {
    const userData = join(TMP_ROOT, 'e')
    writeFakeEngine(userData, '0.83.5')
    writeFakeEngine(userData, '0.84.0')
    const loader = await freshLoader(userData)
    const status = loader.getEngineStatus()
    expect(status.installed).toEqual(['0.84.0', '0.83.5'])
    expect(status.installDir).toBe(join(userData, 'engine'))
  })
})
