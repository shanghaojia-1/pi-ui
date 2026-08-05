#!/usr/bin/env node
/**
 * Generates build/icon.icns, build/icon.ico and build/icon.png (1024) from
 * build/icon.svg. Reproducible: rasterization is done with @resvg/resvg-js
 * (deterministic, cross-platform); the .icns is assembled with macOS
 * `iconutil` when available (fallback: warn — electron-builder can synthesize
 * an icns from icon.png); the .ico is written by a small pure-Node encoder
 * using PNG-compressed entries (valid for Windows Vista+).
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
const svgPath = join(buildDir, 'icon.svg')
const svg = readFileSync(svgPath)

/** Renders the SVG at `size` (width in px) and returns a PNG buffer. */
function renderPng(size) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
  const png = resvg.render().asPng()
  if (!png || png.length === 0) throw new Error(`resvg produced no output at ${size}px`)
  return png
}

/** Writes a multi-size ICO (PNG-compressed entries) from PNG buffers. */
function writeIco(path, entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + 16 * entries.length
  const blobs = []
  entries.forEach(({ size, png }, i) => {
    dir.writeUInt8(size >= 256 ? 0 : size, i * 16) // 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, i * 16 + 1)
    dir.writeUInt8(0, i * 16 + 2)
    dir.writeUInt8(0, i * 16 + 3)
    dir.writeUInt16LE(1, i * 16 + 4) // color planes
    dir.writeUInt16LE(32, i * 16 + 6) // bits per pixel
    dir.writeUInt32LE(png.length, i * 16 + 8)
    dir.writeUInt32LE(offset, i * 16 + 12)
    offset += png.length
    blobs.push(png)
  })
  writeFileSync(path, Buffer.concat([header, dir, ...blobs]))
}

// --- build/icon.png (1024) and build/icon.ico -------------------------------
const png1024 = renderPng(1024)
writeFileSync(join(buildDir, 'icon.png'), png1024)
console.log(`build/icon.png        ${(png1024.length / 1024).toFixed(0)} KiB (1024x1024)`)

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
writeIco(join(buildDir, 'icon.ico'), icoSizes.map((size) => ({ size, png: renderPng(size) })))
const icoBytes = statSync(join(buildDir, 'icon.ico')).size
console.log(`build/icon.ico        ${(icoBytes / 1024).toFixed(0)} KiB (${icoSizes.join(',')}px)`)
console.log('  (16-bit fallback entries omitted: PNG-compressed 32-bit entries are supported by Windows Vista+)')

// --- build/icon.icns (macOS iconutil) ---------------------------------------
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]
const icnsPath = join(buildDir, 'icon.icns')
const iconsetDir = join(tmpdir(), `pi-studio-iconset-${process.pid}.iconset`)
try {
  mkdirSync(iconsetDir, { recursive: true })
  for (const [name, size] of ICONSET) writeFileSync(join(iconsetDir, name), renderPng(size))
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath], { stdio: 'pipe' })
  const icnsBytes = statSync(icnsPath).size
  console.log(`build/icon.icns       ${(icnsBytes / 1024).toFixed(0)} KiB (iconutil, 10 sizes)`)
} catch (error) {
  rmSync(icnsPath, { force: true })
  console.warn(`build/icon.icns       NOT generated (iconutil unavailable): ${error.message}`)
  console.warn('  electron-builder can synthesize an icns from build/icon.png on other hosts.')
  if (process.platform === 'darwin') throw error // iconutil must exist on macOS
} finally {
  rmSync(iconsetDir, { recursive: true, force: true })
}

console.log('Icons generated from build/icon.svg')
