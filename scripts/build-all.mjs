#!/usr/bin/env node
/**
 * Serial builder for `npm run dist:all`. Runs mac, win and linux packaging one
 * after another on the current host, disabling automatic code-signing
 * discovery. A single host cannot guarantee success for all three platforms
 * (e.g. dmg signing/notarization, wine-free NSIS quirks, fpm availability) —
 * so each platform is attempted independently and the summary reports exactly
 * what succeeded. Exit code is nonzero if ANY platform failed.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildVersion } from './build-version.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'node_modules/electron-builder/cli.js')
if (!existsSync(cli)) {
  console.error(`electron-builder CLI not found at ${cli} — run npm install first`)
  process.exit(1)
}

process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'

// Every artifact carries the current commit hash as a version suffix.
const versionArg = `-c.extraMetadata.version=${buildVersion()}`

const platforms = [
  { name: 'mac', args: ['--mac', '--arm64', versionArg] },
  { name: 'win', args: ['--win', '--x64', versionArg] },
  { name: 'linux', args: ['--linux', '--x64', versionArg] },
]

const results = []
for (const platform of platforms) {
  console.log(`\n========== building ${platform.name} ==========`)
  const result = spawnSync(process.execPath, [cli, ...platform.args], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  })
  results.push({ name: platform.name, ok: result.status === 0 })
  if (!results.at(-1).ok) {
    console.error(`\n${platform.name} build FAILED (exit ${result.status ?? result.signal}). Continuing with the next platform.`)
  }
}

console.log('\n========== dist:all summary ==========')
for (const { name, ok } of results) console.log(`  ${name.padEnd(6)} ${ok ? 'OK' : 'FAILED'}`)
const failed = results.filter((r) => !r.ok)
console.log(failed.length === 0 ? 'All platforms built.' : `${failed.map((f) => f.name).join(', ')} failed on this host.`)

// Verify what did get produced.
const verify = spawnSync(process.execPath, [join(root, 'scripts/verify-artifacts.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})
process.exit(failed.length === 0 && verify.status === 0 ? 0 : 1)
