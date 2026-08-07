import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UNGROUPED, type SessionGroupsConfig } from '../../src/shared/contracts'
import { groupIdOf, loadSessionGroups, memberKey, newGroupId, saveSessionGroups, SESSION_GROUPS_FILENAME } from '../../src/main/session-groups'

const TMP = mkdtempSync(join(tmpdir(), 'pi-groups-'))
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); (global as Record<string, unknown>).__tmp = undefined })

function config(): SessionGroupsConfig {
  return {
    version: 1,
    groups: [
      { id: 'g1', name: 'AI 项目', dirs: [join(TMP, 'ai')] },
      { id: 'g2', name: 'Docs', dirs: [join(TMP, 'docs')] },
    ],
    members: {},
  }
}

describe('groupIdOf', () => {
  it('matches a session to the group whose dirs contain its workspace', () => {
    const cfg = config()
    expect(groupIdOf(cfg, join(TMP, 'ai', 's.jsonl'), join(TMP, 'ai'))).toBe('g1')
    expect(groupIdOf(cfg, join(TMP, 'docs', 's.jsonl'), join(TMP, 'docs'))).toBe('g2')
  })

  it('returns null for workspaces bound to no group', () => {
    expect(groupIdOf(config(), join(TMP, 'other', 's.jsonl'), join(TMP, 'other'))).toBeNull()
    expect(groupIdOf(config(), join(TMP, 'ai', 's.jsonl'), null)).toBeNull()
  })

  it('explicit membership wins over the dir rule', () => {
    const cfg = config()
    cfg.members[memberKey(join(TMP, 'docs', 's.jsonl'))] = 'g1'
    // Session under docs/ but pinned to g1 by drag.
    expect(groupIdOf(cfg, join(TMP, 'docs', 's.jsonl'), join(TMP, 'docs'))).toBe('g1')
  })

  it('the ungrouped sentinel pins a session out of every group', () => {
    const cfg = config()
    cfg.members[memberKey(join(TMP, 'ai', 's.jsonl'))] = UNGROUPED
    expect(groupIdOf(cfg, join(TMP, 'ai', 's.jsonl'), join(TMP, 'ai'))).toBeNull()
  })

  it('membership keys are canonicalized (case/symlink insensitive on win32)', () => {
    const cfg = config()
    const key = memberKey(join(TMP, 'docs', 's.jsonl'))
    expect(key).not.toContain('..')
    // Workspace matches no group: un-pinned sessions stay ungrouped.
    expect(groupIdOf(cfg, key, join(TMP, 'other'))).toBeNull()
    cfg.members[key] = 'g2'
    expect(groupIdOf(cfg, key, join(TMP, 'other'))).toBe('g2')
  })
})

describe('loadSessionGroups', () => {
  it('loads a valid file verbatim (dropping corrupt entries)', () => {
    const agent = join(TMP, 'agent')
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(agent, { recursive: true })
    writeFileSync(join(agent, SESSION_GROUPS_FILENAME), JSON.stringify({
      version: 1,
      groups: [
        { id: 'g1', name: 'ok', dirs: [join(TMP, 'ai')] },
        { id: '', name: 'bad id', dirs: [join(TMP, 'x')] },
        { id: 'g2', name: '', dirs: [join(TMP, 'x')] },
        { id: 'g3', name: 'no dirs', dirs: [] },
        'garbage',
      ],
      members: {
        [join(TMP, 'ai', 's.jsonl')]: 'g1',
        [join(TMP, 'x', 's.jsonl')]: 'ghost-group',
        [join(TMP, 'x', 's2.jsonl')]: UNGROUPED,
      },
    }))
    const cfg = loadSessionGroups(agent)
    expect(cfg.groups).toEqual([{ id: 'g1', name: 'ok', dirs: [join(TMP, 'ai')] }])
    expect(cfg.members).toEqual({ [join(TMP, 'ai', 's.jsonl')]: 'g1', [join(TMP, 'x', 's2.jsonl')]: UNGROUPED })
  })

  it('returns an empty config for a missing or corrupt file', () => {
    expect(loadSessionGroups(join(TMP, 'nope')).groups).toEqual([])
    const agent = join(TMP, 'agent2')
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(agent, { recursive: true })
    writeFileSync(join(agent, SESSION_GROUPS_FILENAME), 'not json')
    expect(loadSessionGroups(agent).groups).toEqual([])
    expect(loadSessionGroups(agent).members).toEqual({})
  })
})

describe('saveSessionGroups', () => {
  it('persists atomically and round-trips', () => {
    const agent = join(TMP, 'agent3')
    const { mkdirSync, readdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(agent, { recursive: true })
    const cfg = config()
    cfg.members[memberKey(join(TMP, 'ai', 's.jsonl'))] = 'g1'
    saveSessionGroups(agent, cfg)
    // No temp residue.
    expect(readdirSync(agent)).toEqual([SESSION_GROUPS_FILENAME])
    expect(loadSessionGroups(agent)).toEqual(cfg)
    // Second save overwrites.
    saveSessionGroups(agent, { ...cfg, groups: [] })
    expect(loadSessionGroups(agent).groups).toEqual([])
  })
})

describe('newGroupId', () => {
  it('generates unique short ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newGroupId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^g[0-9a-f]{8}$/)
  })
})
