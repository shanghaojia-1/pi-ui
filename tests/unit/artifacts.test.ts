import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverArtifacts,
  pathCandidatesFromArgs,
  pathCandidatesFromText,
  type ArtifactExistsCache,
} from '../../src/main/artifacts'

/**
 * Artifact discovery turns files the agent produced (documents/videos) into
 * clickable preview entries. Every candidate is verified on disk: existence,
 * regular file, previewable extension, containment in the workspace and
 * exclusion of .git / node_modules.
 */

describe('pathCandidatesFromArgs', () => {
  it('reads the path/file_path of write and edit tools', () => {
    expect(pathCandidatesFromArgs({ path: 'docs/report.md' })).toEqual(['docs/report.md'])
    expect(pathCandidatesFromArgs({ file_path: 'out/video.mp4' })).toEqual(['out/video.mp4'])
    expect(pathCandidatesFromArgs({ path: 42 })).toEqual([])
    expect(pathCandidatesFromArgs(null)).toEqual([])
  })
})

describe('pathCandidatesFromText', () => {
  it('extracts bounded tokens ending in an extension', () => {
    const candidates = pathCandidatesFromText('done: docs/report.md and out/演示.mp4 + README.md')
    expect(candidates).toContain('docs/report.md')
    expect(candidates).toContain('README.md')
  })

  it('strips trailing punctuation and skips network prefixes', () => {
    expect(pathCandidatesFromText('see (docs/report.md), ok')).toContain('docs/report.md')
    expect(pathCandidatesFromText('visit https://x.example/video.mp4 now').some((p) => p.includes('https'))).toBe(false)
    expect(pathCandidatesFromText('\\\\server\\share\\notes.md here').some((p) => p.startsWith('\\\\'))).toBe(false)
    expect(pathCandidatesFromText('//server/share/notes.md').some((p) => p.startsWith('//'))).toBe(false)
  })
})

describe('discoverArtifacts', () => {
  let dir: string
  let outside: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    if (outside) rmSync(outside, { recursive: true, force: true })
  })

  const freshCache = (): ArtifactExistsCache => new Map()

  function setupWorkspace(): string {
    dir = mkdtempSync(join(tmpdir(), 'pi-artifacts-'))
    mkdirSync(join(dir, 'docs'), { recursive: true })
    mkdirSync(join(dir, 'out'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'report.md'), '# report')
    writeFileSync(join(dir, 'out', 'demo.mp4'), 'video')
    writeFileSync(join(dir, 'README.md'), '# readme')
    writeFileSync(join(dir, 'out', 'data.json'), '{}')
    writeFileSync(join(dir, 'out', 'code.ts'), 'export {}')
    writeFileSync(join(dir, 'node_modules', 'pkg', 'readme.md'), 'pkg doc')
    writeFileSync(join(dir, '.git', 'secret.md'), 'secret')
    return dir
  }

  it('discovers files from the write tool path argument', () => {
    const workspace = setupWorkspace()
    const artifacts = discoverArtifacts({
      toolName: 'write',
      args: { path: 'docs/report.md' },
      output: 'ok',
      workspacePath: workspace,
      cache: freshCache(),
    })
    expect(artifacts).toEqual([
      { path: join(workspace, 'docs', 'report.md'), name: 'report.md', kind: 'text' },
    ])
  })

  it('discovers documents and videos mentioned in tool output', () => {
    const workspace = setupWorkspace()
    const artifacts = discoverArtifacts({
      toolName: 'bash',
      output: `wrote docs/report.md\nrendered out/demo.mp4\nsee out/data.json\ncompiled out/code.ts`,
      workspacePath: workspace,
      cache: freshCache(),
    })
    expect(artifacts.map((a) => a.name).sort()).toEqual(['data.json', 'demo.mp4', 'report.md'])
  })

  it('excludes missing, non-artifact, outside-workspace and ignored-dir files', () => {
    const workspace = setupWorkspace()
    // A real sibling workspace file the agent must never reach.
    outside = mkdtempSync(join(tmpdir(), 'pi-artifacts-outside-'))
    writeFileSync(join(outside, 'outside.md'), 'outside')
    const artifacts = discoverArtifacts({
      toolName: 'bash',
      output: [
        join(workspace, 'docs', 'report.md'), // inside: kept
        join(workspace, 'docs', 'missing.md'), // missing: dropped
        join(workspace, 'out', 'code.ts'), // not an artifact extension: dropped
        join(outside, 'outside.md'), // outside the workspace: dropped
        join(workspace, 'node_modules', 'pkg', 'readme.md'), // ignored dir: dropped
        join(workspace, '.git', 'secret.md'), // ignored dir: dropped
      ].join('\n'),
      workspacePath: workspace,
      cache: freshCache(),
    })
    expect(artifacts.map((a) => a.name)).toEqual(['report.md'])
  })

  it('dedupes by canonical path and caches verification results', () => {
    const workspace = setupWorkspace()
    const cache: ArtifactExistsCache = freshCache()
    const twice = discoverArtifacts({
      toolName: 'bash',
      output: 'docs/report.md and docs/report.md again; compiled out/code.ts',
      workspacePath: workspace,
      cache,
    })
    expect(twice).toHaveLength(1)
    expect(cache.get(join(workspace, 'docs', 'report.md'))).toBe('text')
    // Non-artifact extensions are cached as a verified null, so they are
    // never re-statted on later flushes.
    expect(cache.get(join(workspace, 'out', 'code.ts'))).toBeNull()
  })

  it('does not verify the parent of an absolute artifact path', () => {
    const workspace = setupWorkspace()
    const artifacts = discoverArtifacts({
      toolName: 'write',
      args: { path: join(workspace, 'out', 'demo.mp4') },
      output: '',
      workspacePath: workspace,
      cache: freshCache(),
    })
    expect(artifacts.map((a) => a.kind)).toEqual(['video'])
  })
})