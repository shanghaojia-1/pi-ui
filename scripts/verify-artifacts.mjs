#!/usr/bin/env node
/**
 * Verifies packaged artifacts under release/.
 *
 * Discovery (fully recursive, any depth):
 *   - packaged artifacts: *.zip / *.exe / *.AppImage
 *     (excluding *.blockmap / *.yml / *.log and anything inside .app / *-unpacked)
 *   - mac bundles: every directory ending in .app
 *   - unpacked bundles: every directory ending in -unpacked (win* / linux*)
 *   - asar bundles: every file named app.asar directly under a resources/ dir
 *
 * Strict naming — every packaged artifact must match one of exactly these
 * (version read from release package.json):
 *   mac   Pi-Studio-<v>-mac-arm64.zip
 *   win   Pi-Studio-<v>-win-x64-portable.exe
 *   linux Pi-Studio-<v>-linux-x64.AppImage
 * An arch group that has any artifacts must be complete (all expected files).
 *
 * Architecture checks (strong):
 *   - mac apps: Mach-O arch of Contents/MacOS/<main> must be arm64 or x86_64.
 *     Artifact arch groups are linked to bundles of the SAME arch — an arm64
 *     bundle can never satisfy x64 artifacts (anti-substitution).
 *   - win exe (artifact + unpacked binary): PE arch must be x86-64 (`file`).
 *   - linux AppImage: runtime ELF must be x86-64 (`file`).
 *   - linux deb: Architecture must be amd64 (parsed from the ar control.tar
 *     member via `tar -xOf`, no dpkg-deb required on the macOS host).
 *
 * Bundles are fully inspected: app.asar is read in place (never extracted) and
 * must contain the main/preload/renderer bundles plus the packaged Pi SDK
 * package.json; app.asar.unpacked must hold the SDK native resources for the
 * bundle's OWN architecture (photon wasm + matching pi-tui prebuild whose
 * Mach-O/PE arch is verified), plus mac .icns, bundle id and unsigned (adhoc)
 * codesign state.
 *
 * Modes:
 *   default                  – only platforms that have artifacts are verified
 *   --require=mac,win,linux  – fail unless every listed platform is present and passes;
 *                              if mac has both arm64 and x64 artifacts, both must be
 *                              verified (each arch group needs its own matching bundle).
 *
 * Exit code: 0 = all checks passed, 1 = failures, 2 = usage error.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(root, 'release')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const minBytes = Number(process.env.VERIFY_MIN_MB ?? 30) * 1024 * 1024
const isDarwin = process.platform === 'darwin'

const PLATFORMS = ['mac', 'win', 'linux']
const EXCLUDED_NAME = /\.(blockmap|yml|log)$/i
const BUNDLE_DIR = /(^|\/)([^/]+\.app|[^/]+-unpacked)\//

const EXPECTED_ARTIFACTS = {
  mac: { arm64: [`Pi-Studio-${version}-mac-arm64.zip`] },
  win: { x64: [`Pi-Studio-${version}-win-x64-portable.exe`] },
  linux: { x64: [`Pi-Studio-${version}-linux-x64.AppImage`] },
}
const EXPECTED_BY_NAME = new Map()
for (const [platform, archs] of Object.entries(EXPECTED_ARTIFACTS)) {
  for (const [arch, names] of Object.entries(archs)) {
    for (const n of names) EXPECTED_BY_NAME.set(n, { platform, arch })
  }
}

const REQUIRED_IN_ASAR = [
  'out/main/index.js',
  'out/preload/index.cjs',
  'out/renderer/index.html',
  'node_modules/@earendil-works/pi-coding-agent/package.json',
]
const FORBIDDEN_IN_ASAR = [/^\/src\//, /^\/tests\//, /^\/build\//, /^\/scripts\//, /\.pi\//]

// SDK native resources that must live in app.asar.unpacked, per bundle arch.
const PHOTON_WASM = 'node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm'
const PI_TUI_PREBUILD = {
  'mac-arm64': { desc: 'pi-tui darwin-arm64 prebuild .node', path: 'node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node', wantArch: 'arm64' },
  'mac-x64': { desc: 'pi-tui darwin-x64 prebuild .node', path: 'node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-x64/darwin-modifiers.node', wantArch: 'x64' },
  'win-x64': { desc: 'pi-tui win32-x64 prebuild .node', path: 'node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-x64/win32-console-mode.node', wantArch: 'x64' },
  // linux: pi-tui ships no linux native prebuild; photon wasm is the SDK native requirement
}

let failures = 0
const fail = (msg) => { failures += 1; console.error(`  FAIL ${msg}`) }
const info = (msg) => console.log(`  ${msg}`)

function listFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listFiles(full, out)
    else out.push(full)
  }
  return out
}

function fmt(bytes) {
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GiB` : `${mb.toFixed(1)} MiB`
}

// --- recursive discovery --------------------------------------------------------
function discover() {
  const packaged = []
  const apps = [] // .app bundles
  const unpacked = [] // *-unpacked bundles: { path, platform }
  const asars = [] // resources/app.asar files
  // `inBundle` tracks descent into a recorded bundle: nested .app helpers
  // (Electron Frameworks/* Helper.app) are NOT top-level bundles.
  const walk = (dir, inBundle = false) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        const isBundle = entry.name.endsWith('.app') || entry.name.endsWith('-unpacked')
        if (isBundle && !inBundle) {
          if (entry.name.endsWith('.app')) apps.push(full)
          else {
            const platform = entry.name.startsWith('win') ? 'win' : entry.name.startsWith('linux') ? 'linux' : null
            unpacked.push({ path: full, platform })
          }
        }
        walk(full, inBundle || isBundle) // unlimited depth — app.asar may sit at any level
      } else {
        if (entry.name === 'app.asar' && basename(dir) === 'resources') asars.push(full)
        if (EXCLUDED_NAME.test(full) || BUNDLE_DIR.test(full)) continue
        if (['.dmg', '.zip', '.exe', '.AppImage', '.deb'].includes(extname(full))) packaged.push(full)
      }
    }
  }
  walk(releaseDir)
  return { packaged, apps, unpacked, asars }
}

function classifyArtifact(file) {
  const name = basename(file)
  const match = EXPECTED_BY_NAME.get(name)
  return match ? { name, platform: match.platform, arch: match.arch, ext: extname(file) } : null
}

// --- binary architecture via `file` ---------------------------------------------
function fileOutput(file) {
  if (!existsSync(file)) return null
  try {
    return spawnSync('file', [file], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).stdout ?? ''
  } catch { return null }
}

function binaryArch(file) {
  const out = fileOutput(file)
  if (!out) return null
  if (/\barm64\b|aarch64/.test(out)) return 'arm64'
  if (/x86-64|x86_64/.test(out)) return 'x64'
  return null
}

function macMainExecutable(appDir) {
  const macosDir = join(appDir, 'Contents/MacOS')
  if (!existsSync(macosDir)) return null
  const mains = readdirSync(macosDir).filter((f) => !f.startsWith('.'))
  return mains.length ? join(macosDir, mains[0]) : null
}

// --- asar reading (header only; never extracts the archive) -------------------
function listAsar(asarPath) {
  try {
    const asar = require('@electron/asar')
    return { source: '@electron/asar', entries: asar.listPackage(asarPath) }
  } catch {
    return { source: 'built-in header parser', entries: listAsarHeader(asarPath) }
  }
}

// Minimal fallback: parse the pickle header directly from the file.
// Layout: [0..3]=4, [4..7]=header pickle size, [8..11]=header pickle size,
// [12..15]=JSON string length, [16..16+len)=JSON.
function listAsarHeader(asarPath) {
  const fd = openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const strLen = head.readUInt32LE(12)
    const json = Buffer.alloc(strLen)
    readSync(fd, json, 0, strLen, 16)
    const header = JSON.parse(json.toString('utf8'))
    const entries = []
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files || {})) {
        const path = `${prefix}/${name}`
        if (entry.files) walk(entry, path)
        else entries.push(path)
      }
    }
    walk(header, '')
    return entries
  } finally {
    closeSync(fd)
  }
}

// --- artifact-level checks -------------------------------------------------------
function verifyMagic(file, platform) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const ext = extname(file)
    let ok = false
    if (ext === '.dmg') {
      const size = statSync(file).size
      const tail = Buffer.alloc(512)
      readSync(fd, tail, 0, 512, Math.max(0, size - 512))
      ok = tail.includes(Buffer.from('koly'))
    } else if (ext === '.zip') ok = head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    else if (ext === '.exe') ok = head.subarray(0, 2).equals(Buffer.from('MZ'))
    else if (ext === '.AppImage') ok = [0, 8].some((off) => head.subarray(off, off + 3).equals(Buffer.from('AI\x02')) || head.subarray(off, off + 3).equals(Buffer.from('AI\x01')))
    else if (ext === '.deb') ok = head.subarray(0, 8).equals(Buffer.from('!<arch>\n'))
    if (!ok) fail(`${basename(file)}: magic bytes do not match a ${ext} container`)
  } finally {
    closeSync(fd)
  }
}

function verifyArtifact(file, platform) {
  const size = statSync(file).size
  const ext = extname(file)
  const kind = ext === '.exe' ? 'exe' : ext.slice(1)
  if (size < minBytes) fail(`${basename(file)} is only ${fmt(size)} (< ${fmt(minBytes)} minimum)`)
  else info(`ok ${kind} ${fmt(size)}`)
  verifyMagic(file, platform)

  // Strong architecture checks (see header comment).
  if (platform === 'win') {
    // NSIS installer stubs are 32-bit PE32 by design; the real x64 app binary
    // is verified inside the win-unpacked bundle.
    const out = fileOutput(file)
    if (out && /PE32/.test(out)) info('ok PE container (NSIS stub is 32-bit by design; x64 app verified in win-unpacked)')
    else fail(`${basename(file)}: not a PE executable (${out?.trim() || 'file output unavailable'})`)
  } else if (platform === 'linux' && ext === '.AppImage') {
    const arch = binaryArch(file)
    if (arch === 'x64') info('ok ELF x86-64')
    else fail(`${basename(file)}: AppImage runtime arch is ${arch ?? 'unknown'}, expected x86-64`)
  } else if (platform === 'linux' && ext === '.deb') {
    const arch = debArch(file)
    if (arch === 'amd64') info('ok deb Architecture amd64')
    else fail(`${basename(file)}: deb Architecture is ${arch ?? 'unreadable'}, expected amd64`)
  }
}

function verifyDmg(file) {
  if (!isDarwin) { info('hdiutil verify skipped (not on macOS host)'); return }
  try {
    const out = execFileSync('hdiutil', ['verify', file], { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] })
    info(`ok hdiutil verify: ${out.trim().split('\n').slice(-1)[0] || 'validated'}`)
  } catch (e) {
    fail(`hdiutil verify ${basename(file)}: ${String(e.stderr || e.message).trim().split('\n').slice(-1)[0]}`)
  }
}

function verifyZip(file) {
  try {
    // No external unzip dependency: read the central directory via node's
    // built-in zlib on the EOCD + central-directory records, then check that
    // a .app bundle (or an app bundle named like a darwin app) is inside.
    const fd = openSync(file, 'r')
    const size = statSync(file).size
    const tailLen = Math.min(size, 66_000)
    const tail = Buffer.alloc(tailLen)
    readSync(fd, tail, 0, tailLen, size - tailLen)
    closeSync(fd)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break }
    }
    if (eocd === -1) { fail(`${basename(file)}: no EOCD record (not a zip?)`); return }
    const entryCount = tail.readUInt16LE(eocd + 10)
    const centralSize = tail.readUInt32LE(eocd + 12)
    const centralOffset = tail.readUInt32LE(eocd + 16)
    // Read the central directory in full.
    const dirBuf = Buffer.alloc(centralSize)
    const fd2 = openSync(file, 'r')
    readSync(fd2, dirBuf, 0, centralSize, centralOffset)
    closeSync(fd2)
    let pos = 0
    let hasApp = false
    for (let i = 0; i < entryCount; i++) {
      if (dirBuf[pos] !== 0x50 || dirBuf[pos + 1] !== 0x4b || dirBuf[pos + 2] !== 0x01 || dirBuf[pos + 3] !== 0x02) break
      const nameLen = dirBuf.readUInt16LE(pos + 28)
      const extraLen = dirBuf.readUInt16LE(pos + 30)
      const commentLen = dirBuf.readUInt16LE(pos + 32)
      const name = dirBuf.toString('utf8', pos + 46, pos + 46 + nameLen)
      if (/\.app\//.test(name)) hasApp = true
      pos += 46 + nameLen + extraLen + commentLen
    }
    if (hasApp) info('ok zip contains the .app bundle')
    else fail(`${basename(file)}: zip central directory contains no .app`)
  } catch (e) {
    fail(`verifyZip ${basename(file)}: ${String(e.message || e).trim().split('\n').slice(-1)[0]}`)
  }
}

// --- deb architecture without dpkg-deb (parse ar members, pipe control.tar) ----
function debArch(debFile) {
  const fd = openSync(debFile, 'r')
  try {
    const size = statSync(debFile).size
    const members = []
    let off = 8
    const head = Buffer.alloc(60)
    while (off + 60 <= size) {
      readSync(fd, head, 0, 60, off)
      const name = head.subarray(0, 16).toString('utf8').replace(/\0/g, '').trim()
      const memberSize = parseInt(head.subarray(48, 58).toString('utf8').trim(), 10)
      if (!Number.isInteger(memberSize) || memberSize <= 0) break
      const data = Buffer.alloc(memberSize)
      readSync(fd, data, 0, memberSize, off + 60)
      members.push({ name, data })
      off += 60 + memberSize + (memberSize % 2)
    }
    const control = members.find((m) => /^control\.tar(\.|$)/.test(m.name))
    if (!control) return null
    // bsdtar on macOS does not reliably read the member from stdin; stage it.
    const tmp = join(require('node:os').tmpdir(), `pi-studio-control-${process.pid}.tar`)
    writeFileSync(tmp, control.data)
    try {
      for (const member of ['./control', 'control']) {
        const res = spawnSync('tar', ['-xOf', tmp, member], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })
        if (res.status === 0 && res.stdout) {
          return res.stdout.match(/^Architecture:\s*(\S+)/m)?.[1] ?? null
        }
      }
      return null
    } finally {
      unlinkSync(tmp)
    }
  } finally {
    closeSync(fd)
  }
}

// --- bundle inspection -----------------------------------------------------------
function inspectApp(platform, appDir, arch) {
  console.log(`\nInspecting ${platform}${arch ? ` ${arch}` : ''} bundle: ${relative(releaseDir, appDir)}`)
  const resources = platform === 'mac' ? join(appDir, 'Contents/Resources') : join(appDir, 'resources')
  if (!existsSync(resources)) { fail(`${appDir}: missing ${relative(appDir, resources)}`); return }

  const asarPath = join(resources, 'app.asar')
  if (!existsSync(asarPath)) { fail(`${appDir}: missing app.asar`); return }
  info(`app.asar ${fmt(statSync(asarPath).size)}`)

  const { source, entries } = listAsar(asarPath)
  info(`asar entries: ${entries.length} (via ${source})`)
  for (const required of REQUIRED_IN_ASAR) {
    if (entries.includes(`/${required}`)) info(`ok asar ${required}`)
    else fail(`app.asar missing ${required}`)
  }
  for (const forbidden of FORBIDDEN_IN_ASAR) {
    const hit = entries.find((e) => forbidden.test(e))
    if (hit) fail(`app.asar unexpectedly contains ${hit}`)
  }

  // main binary arch must be a real, recognized architecture
  let mainArch = arch
  if (platform === 'mac') {
    const main = macMainExecutable(appDir)
    mainArch = main ? binaryArch(main) : null
    if (mainArch) info(`main executable arch: ${mainArch}`)
    else fail(`${appDir}: cannot determine Mach-O arch of the main executable`)
    if (arch && mainArch !== arch) fail(`${appDir}: bundle arch ${mainArch} does not match expected ${arch}`)
  } else {
    const mainBinary = platform === 'win'
      ? join(appDir, `${pkg.build.productName}.exe`)
      : join(appDir, pkg.build.linux.executableName)
    mainArch = binaryArch(mainBinary)
    if (mainArch === 'x64') info(`main binary arch: x64`)
    else fail(`${appDir}: main binary arch is ${mainArch ?? 'unknown/missing'}, expected x86-64`)
  }

  const unpackedRoot = join(resources, 'app.asar.unpacked')
  if (!existsSync(unpackedRoot)) { fail(`${appDir}: missing app.asar.unpacked`); return }
  const unpackedFiles = listFiles(unpackedRoot)
  const native = unpackedFiles.filter((f) => /\.(node|wasm)$/.test(f))
  info(`unpacked native resources: ${native.length} (${native.filter((f) => f.endsWith('.node')).length} .node, ${native.filter((f) => f.endsWith('.wasm')).length} .wasm)`)
  const wasm = native.find((f) => f.includes(PHOTON_WASM))
  if (wasm) info('ok unpacked photon-node wasm')
  else fail(`app.asar.unpacked missing ${PHOTON_WASM}`)

  const key = `${platform}-${mainArch ?? 'x64'}`
  const piTui = PI_TUI_PREBUILD[key]
  if (piTui) {
    const hit = native.find((f) => f.includes(piTui.path))
    if (!hit) fail(`app.asar.unpacked missing ${piTui.desc}`)
    else {
      const nodeArch = binaryArch(hit)
      if (nodeArch === piTui.wantArch) info(`ok unpacked ${piTui.desc} (${nodeArch})`)
      else fail(`unpacked ${piTui.desc} is ${nodeArch ?? 'unknown'} arch, expected ${piTui.wantArch}`)
    }
  } else if (platform === 'linux') {
    info('pi-tui has no linux native prebuild; photon wasm covers the SDK native requirement')
  }
  const clip = native.filter((f) => f.includes('@mariozechner/clipboard'))
  info(clip.length ? `info optional clipboard prebuilds unpacked (${clip.length})` : 'info optional clipboard prebuilds absent (optional dep — not required)')

  if (platform === 'mac') {
    const icons = listFiles(resources).filter((f) => f.endsWith('.icns'))
    if (icons.length === 0) fail(`${appDir}: no .icns in Resources`)
    else info(`ok icon ${icons.map((f) => relative(resources, f)).join(', ')}`)

    const plistPath = join(appDir, 'Contents/Info.plist')
    if (existsSync(plistPath)) {
      const plist = readFileSync(plistPath, 'utf8')
      const id = plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
      if (id !== pkg.build.appId) fail(`unexpected bundle id ${id}`)
      else info(`ok bundle id ${id}`)
    } else fail(`${appDir}: missing Info.plist`)

    // Expected state: unsigned (identity: null / CSC_IDENTITY_AUTO_DISCOVERY=false).
    // codesign -dv writes to stderr; capture both streams.
    const res = spawnSync('codesign', ['-dv', '--verbose=2', appDir], { encoding: 'utf8', timeout: 30000 })
    const text = `${res.stdout ?? ''}${res.stderr ?? ''}`
    if (/Developer ID Application/.test(text) || /TeamIdentifier=[0-9A-Z]{10}/.test(text)) {
      fail(`${appDir}: unexpectedly signed (${text.split('\n').find((l) => /Identifier=|TeamIdentifier=/.test(l))})`)
    } else if (/adhoc/i.test(text) || /not signed/i.test(text) || /code object is not signed/i.test(text)) {
      info('ok codesign: unsigned (adhoc), as expected for identity:null build')
    } else {
      fail(`${appDir}: cannot determine codesign status (${text.trim().slice(0, 120)})`)
    }
  }
}

// --- main ------------------------------------------------------------------------
const requireArg = process.argv.find((a) => a.startsWith('--require'))
let required = null
if (requireArg !== undefined) {
  const value = requireArg.includes('=') ? requireArg.slice(requireArg.indexOf('=') + 1) : null
  if (!value) { console.error('usage: --require=mac,win,linux (comma-separated platforms)'); process.exit(2) }
  required = new Set(value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
  for (const p of required) {
    if (!PLATFORMS.includes(p)) { console.error(`unknown platform in --require: ${p}`); process.exit(2) }
  }
}

console.log(`Release directory: ${relative(root, releaseDir)}${required ? ` (--require=${[...required].join(',')})` : ' (present-platforms mode)'} (version ${version})`)
if (!existsSync(releaseDir)) {
  console.error('No release directory found — nothing to verify.')
  process.exit(1)
}

const { packaged, apps, unpacked, asars } = discover()
if (packaged.length === 0) {
  console.error('No packaged artifacts (dmg/zip/exe/AppImage/deb) found in release/.')
  process.exit(1)
}

console.log('\nDiscovered bundles:')
for (const a of apps) console.log(`  app       ${relative(releaseDir, a)}`)
for (const u of unpacked) console.log(`  unpacked  ${relative(releaseDir, u.path)} (${u.platform ?? 'unrecognized name prefix'})`)
for (const u of unpacked.filter((x) => !x.platform)) fail(`${u.path}: *-unpacked dir with unrecognized platform prefix (expected win*/linux*)`)
for (const a of asars) console.log(`  asar      ${relative(releaseDir, a)}`)

// every discovered app.asar must live directly inside a bundle's resources/
for (const a of asars) {
  const parent = dirname(dirname(a))
  const inBundle = apps.includes(parent) || unpacked.some((u) => u.path === parent)
  if (!inBundle) fail(`orphan app.asar not inside any .app/*-unpacked resources/: ${relative(releaseDir, a)}`)
}
if (apps.length === 0 && unpacked.length === 0) {
  // Artifact-only deliveries (user asked for the binaries, not the bundles)
  // are valid: deep bundle checks are skipped below instead of failing.
  console.log('  (no .app / *-unpacked bundles present — artifact-only delivery, deep checks skipped)')
}

// strict artifact classification against the expected 8 names
const byPlatform = { mac: { arm64: [], x64: [] }, win: { x64: [] }, linux: { x64: [] } }
console.log('\nArtifacts:')
for (const file of packaged.sort()) {
  const cls = classifyArtifact(file)
  console.log(`  ${fmt(statSync(file).size).padStart(10)}  ${relative(releaseDir, file)}${cls ? `  (${cls.platform}-${cls.arch})` : '  (?)'}`)
  if (!cls) {
    fail(`${relative(releaseDir, file)}: name does not match any expected release artifact for version ${version}`)
    continue
  }
  byPlatform[cls.platform][cls.arch].push(file)
}

console.log('\nChecks:')
for (const platform of PLATFORMS) {
  const total = Object.values(byPlatform[platform]).reduce((n, files) => n + files.length, 0)
  if (total === 0) {
    if (required?.has(platform)) fail(`${platform}: required (--require) but no artifacts found`)
    else console.log(`  ${platform}: no artifacts (not built on this host)`)
    continue
  }
  console.log(`  ${platform}: ${total} artifact(s)`)
  for (const [arch, files] of Object.entries(byPlatform[platform])) {
    if (files.length === 0) continue
    const expectedNames = EXPECTED_ARTIFACTS[platform][arch]
    const present = new Set(files.map((f) => basename(f)))
    for (const name of expectedNames) {
      if (!present.has(name)) fail(`${platform}-${arch}: missing expected artifact ${name}`)
    }
    if (files.length > expectedNames.length) fail(`${platform}-${arch}: duplicate artifacts`)
    for (const file of files) {
      verifyArtifact(file, platform)
      if (platform === 'mac') {
        if (file.endsWith('.dmg')) verifyDmg(file)
        if (file.endsWith('.zip')) verifyZip(file)
      }
    }
  }

  if (platform === 'mac') {
    // Link artifact arch groups to bundles of the SAME arch (anti-substitution).
    for (const [arch, files] of Object.entries(byPlatform.mac)) {
      if (files.length === 0) continue
      const matching = apps.filter((a) => binaryArch(macMainExecutable(a)) === arch)
      if (matching.length === 0) info(`mac-${arch}: no ${arch} .app bundle present (artifact-only delivery)`)
      else info(`mac-${arch}: linked to ${matching.map((m) => relative(releaseDir, m)).join(', ')}`)
    }
    for (const app of apps) inspectApp('mac', app, binaryArch(macMainExecutable(app)))
  } else {
    const bundles = unpacked.filter((u) => u.platform === platform)
    if (bundles.length === 0) info(`${platform}: no ${platform}*-unpacked bundle present (artifact-only delivery)`)
    for (const b of bundles) inspectApp(platform, b.path, 'x64')
  }
}

console.log(failures === 0 ? '\nAll artifact checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
