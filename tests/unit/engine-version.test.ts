import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  ENGINE_SUPPORTED_RANGE,
  isEngineVersion,
  parseVersion,
  sortVersionsDescending,
  versionInRange,
} from '../../src/main/engine-version'

describe('isEngineVersion', () => {
  it('accepts plain x.y.z versions', () => {
    expect(isEngineVersion('0.83.0')).toBe(true)
    expect(isEngineVersion('1.2.3')).toBe(true)
    expect(isEngineVersion('0.0.1')).toBe(true)
  })
  it('rejects prereleases, build metadata and garbage', () => {
    expect(isEngineVersion('0.83.0-beta.1')).toBe(false)
    expect(isEngineVersion('0.83')).toBe(false)
    expect(isEngineVersion('0.83.0+build5')).toBe(false)
    expect(isEngineVersion('v0.83.0')).toBe(false)
    expect(isEngineVersion('abc')).toBe(false)
    expect(isEngineVersion('0.83.0.1')).toBe(false)
    expect(isEngineVersion('')).toBe(false)
    expect(isEngineVersion(null)).toBe(false)
    expect(isEngineVersion(0.83)).toBe(false)
  })
})

describe('parseVersion / compareVersions', () => {
  it('parses three numeric parts', () => {
    expect(parseVersion('0.83.0')).toEqual([0, 83, 0])
    expect(parseVersion('2.0.10')).toEqual([2, 0, 10])
    expect(parseVersion('nope')).toBeNull()
  })
  it('compares major, then minor, then patch', () => {
    expect(compareVersions([0, 83, 0], [0, 83, 0])).toBe(0)
    expect(compareVersions([0, 83, 1], [0, 83, 0])).toBeGreaterThan(0)
    expect(compareVersions([0, 82, 99], [0, 83, 0])).toBeLessThan(0)
    expect(compareVersions([1, 0, 0], [0, 99, 99])).toBeGreaterThan(0)
  })
})

describe('versionInRange', () => {
  it('includes min, excludes max (default GUI window 0.83.x)', () => {
    expect(versionInRange('0.83.0')).toBe(true)
    expect(versionInRange('0.83.7')).toBe(true)
    expect(versionInRange('0.84.99')).toBe(true)
    expect(versionInRange('0.85.0')).toBe(false)
    expect(versionInRange('0.82.99')).toBe(false)
    expect(versionInRange('0.83.0-beta.1')).toBe(false)
  })
  it('honors custom windows', () => {
    const min = [1, 0, 0] as const
    const max = [1, 1, 0] as const
    expect(versionInRange('1.0.0', min, max)).toBe(true)
    expect(versionInRange('1.0.9', min, max)).toBe(true)
    expect(versionInRange('1.1.0', min, max)).toBe(false)
    expect(versionInRange('0.9.9', min, max)).toBe(false)
  })
  it('exposes a readable supported-range string', () => {
    expect(ENGINE_SUPPORTED_RANGE).toBe('>=0.83.0 <0.85.0')
  })
})

describe('sortVersionsDescending', () => {
  it('sorts newest first and drops prereleases', () => {
    expect(sortVersionsDescending(['0.83.0', '0.85.0', '0.84.2', '0.83.9', '0.85.0-beta.1', 'garbage']))
      .toEqual(['0.85.0', '0.84.2', '0.83.9', '0.83.0'])
  })
  it('handles empty input', () => {
    expect(sortVersionsDescending([])).toEqual([])
  })
})
