import { describe, expect, it } from 'vitest'
import { windowOptionsForPlatform } from '../../src/main/window-options'

const BASE = {
  width: 1480, height: 920, minWidth: 980, minHeight: 680,
  title: 'Pi Studio', backgroundColor: '#f5f5f3',
}

/** Linux/other share the native default-frame appearance. */
function expectDefaultFrame(options: ReturnType<typeof windowOptionsForPlatform>): void {
  expect(options.titleBarStyle).toBe('default')
  expect(options.frame).toBe(true)
  expect(options.movable).toBe(true)
  expect(options.autoHideMenuBar).toBe(true)
  expect(options.trafficLightPosition).toBeUndefined()
  expect('trafficLightPosition' in options).toBe(false)
  expect('titleBarOverlay' in options).toBe(false)
}

describe('windowOptionsForPlatform', () => {
  it('darwin: hiddenInset + traffic lights + movable, menu bar never hidden', () => {
    const options = windowOptionsForPlatform('darwin')
    expect(options).toMatchObject(BASE)
    expect(options.titleBarStyle).toBe('hiddenInset')
    expect(options.frame).toBe(true)
    expect(options.movable).toBe(true)
    expect(options.autoHideMenuBar).toBe(false) // macOS keeps its menu bar
    expect(options.trafficLightPosition).toEqual({ x: 18, y: 18 }) // macOS-only inset
    expect('titleBarOverlay' in options).toBe(false)
  })

  it('win32: frameless custom title bar (theme-following renderer controls)', () => {
    const options = windowOptionsForPlatform('win32')
    expect(options).toMatchObject(BASE)
    expect(options.frame).toBe(false)
    expect(options.movable).toBe(true)
    expect(options.titleBarStyle).toBeUndefined() // renderer draws the bar
    expect('trafficLightPosition' in options).toBe(false)
    expect('titleBarOverlay' in options).toBe(false)
  })

  it('linux: default frame + movable + auto-hide menu bar, no traffic lights / overlay', () => {
    expectDefaultFrame(windowOptionsForPlatform('linux'))
  })

  it('other: safe fallback to the default native frame', () => {
    for (const platform of ['other', 'freebsd', 'sunos', 'aix', 'android']) {
      expectDefaultFrame(windowOptionsForPlatform(platform))
    }
  })

  it('is pure: same input yields an equal, freshly-built object', () => {
    for (const platform of ['darwin', 'win32', 'linux', 'other']) {
      const first = windowOptionsForPlatform(platform)
      const second = windowOptionsForPlatform(platform)
      expect(second).toEqual(first)
      expect(second).not.toBe(first)
    }
  })

  it('covers every platform BrowserWindow actually supports', () => {
    expect(windowOptionsForPlatform('darwin').titleBarStyle).toBe('hiddenInset')
    expect(windowOptionsForPlatform('win32').frame).toBe(false)
    expect(windowOptionsForPlatform('linux').titleBarStyle).toBe('default')
  })
})
