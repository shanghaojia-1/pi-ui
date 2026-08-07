import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UNGROUPED, type SessionGroup, type SessionGroupsConfig } from '../shared/contracts'
import { canonicalizeEvenIfMissing } from './runtime'

/** Session-group configuration file, next to the session store. */
export const SESSION_GROUPS_FILENAME = 'session-groups.json'

const EMPTY: SessionGroupsConfig = { version: 1, groups: [], members: {} }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Best-effort load; a missing/corrupt file yields an empty config (never throws). */
export function loadSessionGroups(agentDir: string): SessionGroupsConfig {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir, SESSION_GROUPS_FILENAME), 'utf8')) as unknown
    if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.groups) || !isRecord(raw.members)) return structuredClone(EMPTY)
    const groups: SessionGroup[] = []
    for (const entry of raw.groups) {
      if (!isRecord(entry)) continue
      const id = typeof entry.id === 'string' ? entry.id : ''
      const name = typeof entry.name === 'string' ? entry.name : ''
      const dirs = Array.isArray(entry.dirs) ? entry.dirs.filter((d): d is string => typeof d === 'string') : []
      if (id === '' || name === '' || dirs.length === 0) continue
      groups.push({ id, name, dirs })
    }
    const members: Record<string, string> = {}
    for (const [path, groupId] of Object.entries(raw.members)) {
      if (typeof groupId === 'string' && (groupId === UNGROUPED || groups.some((g) => g.id === groupId))) {
        members[path] = groupId
      }
    }
    return { version: 1, groups, members }
  } catch {
    return structuredClone(EMPTY)
  }
}

/** Atomic save (temp + rename); a write failure leaves the old file intact. */
export function saveSessionGroups(agentDir: string, config: SessionGroupsConfig): void {
  const file = join(agentDir, SESSION_GROUPS_FILENAME)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2))
  renameSync(tmp, file)
}

/** New stable group id ('g' + 8 random hex chars). */
export function newGroupId(): string {
  return `g${randomBytes(4).toString('hex')}`
}

/** Canonical membership key for a session path. */
export function memberKey(sessionPath: string): string {
  return canonicalizeEvenIfMissing(sessionPath)
}

/**
 * Group a session belongs to:
 * 1. explicit membership map (drag pinning, incl. the UNGROUPED sentinel)
 * 2. first group whose bound dirs contain the session's workspace cwd
 * 3. null (ungrouped)
 */
export function groupIdOf(
  config: SessionGroupsConfig,
  sessionPath: string,
  workspacePath: string | null,
): string | null {
  const pinned = config.members[memberKey(sessionPath)]
  if (pinned !== undefined) return pinned === UNGROUPED ? null : pinned
  if (workspacePath === null) return null
  const canonical = canonicalizeEvenIfMissing(workspacePath)
  const hit = config.groups.find((group) => group.dirs.some((dir) => canonicalizeEvenIfMissing(dir) === canonical))
  return hit ? hit.id : null
}
