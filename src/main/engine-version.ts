/**
 * Engine-version helpers: pure functions shared by the engine loader and the
 * settings UI. No electron imports — unit-testable in plain node.
 */

/**
 * Compatibility window for externally installed pi engines. The GUI was
 * written against 0.83.0 and its message serialization / tool event handling
 * is sensitive to SDK internals, so the window is deliberately narrow. Widen
 * it only after testing a newer engine in dev.
 */
export const ENGINE_SUPPORTED_MIN = [0, 83, 0] as const
export const ENGINE_SUPPORTED_MAX = [0, 85, 0] as const

export const ENGINE_SUPPORTED_RANGE = `>=${ENGINE_SUPPORTED_MIN.join('.')} <${ENGINE_SUPPORTED_MAX.join('.')}`

export const ENGINE_PACKAGE = '@earendil-works/pi-coding-agent'

/** Strict x.y.z (no prerelease, no build metadata); prereleases are never allowed. */
const VERSION_RE = /^\d+\.\d+\.\d+$/

export type ParsedVersion = readonly [number, number, number]

export function isEngineVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_RE.test(value)
}

export function parseVersion(value: string): ParsedVersion | null {
  if (!VERSION_RE.test(value)) return null
  const parts = value.split('.').map((part) => Number.parseInt(part, 10))
  return [parts[0]!, parts[1]!, parts[2]!]
}

/** Lexicographic comparison of two parsed versions: <0, 0, >0. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! < b[i]!) return -1
    if (a[i]! > b[i]!) return 1
  }
  return 0
}

/** True when min <= version < max (both parsed). */
export function versionInRange(version: string, min: ParsedVersion = ENGINE_SUPPORTED_MIN, max: ParsedVersion = ENGINE_SUPPORTED_MAX): boolean {
  const parsed = parseVersion(version)
  if (parsed === null) return false
  return compareVersions(parsed, min) >= 0 && compareVersions(parsed, max) < 0
}

/** Sort newest-first; prereleases are dropped. */
export function sortVersionsDescending(versions: string[]): string[] {
  const parsed = new Map<string, ParsedVersion>()
  for (const version of versions) {
    const value = parseVersion(version)
    if (value !== null) parsed.set(version, value)
  }
  return [...parsed.entries()]
    .sort((a, b) => compareVersions(b[1], a[1]))
    .map(([version]) => version)
}
