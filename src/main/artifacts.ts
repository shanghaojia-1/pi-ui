import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import type { ArtifactFile, ArtifactKind } from '../shared/contracts'
import { artifactKindOf } from '../shared/contracts'
import { canonicalizeEvenIfMissing } from './paths'

/**
 * Artifact discovery for the preview feature.
 *
 * A "product" of a task is a document or video file the agent produced:
 * - `write`/`edit` tool calls carry the file path in their arguments;
 * - any tool output (bash transcripts, subagent summaries) may mention a
 *   path to a produced file.
 *
 * Every candidate is verified on disk before it becomes an artifact: it must
 * be a regular file with a previewable extension (shared ARTIFACT_EXTENSIONS),
 * must exist, and its canonical path must stay inside the current workspace
 * (and outside .git / node_modules). Verification results are cached per
 * canonical path for the lifetime of a session so repeated serialization
 * flushes (tens per second while streaming) never re-stat the same file.
 */

/** Maximum number of output-text candidates scanned per tool result. */
const MAX_SCANNED_CANDIDATES = 40
/** Output text scanned for path mentions is bounded to keep serialization cheap. */
const SCAN_TEXT_LIMIT = 100_000
/** Maximum artifacts surfaced per tool block; keeps cards readable. */
const MAX_ARTIFACTS_PER_TOOL = 8

/** Directories whose contents never count as task products. */
const IGNORED_DIR_SEGMENTS = new Set(['.git', 'node_modules'])

/** Cache of canonical path -> artifact kind (null = verified not an artifact). */
export type ArtifactExistsCache = Map<string, ArtifactKind | null>

/**
 * Token-level path candidates in free text. Matches runs of path-ish
 * characters (slashes, dots, dashes, underscores, tildes) ending in an
 * extension. Quoted/braced/punctuated tokens are accepted — trailing
 * punctuation is stripped afterwards and every candidate is verified on
 * disk, so false positives (URLs, timestamps) never surface as artifacts.
 */
const PATH_TOKEN_RE = /(?:[A-Za-z]:[\\/])?[A-Za-z0-9_~./\\-]{2,512}\.([A-Za-z0-9]{1,8})/g

const stripTrailingPunctuation = (token: string): string => {
  const trimmed = token.trim()
  return trimmed.replace(/[),;:!?\]}>'"`）》，。；：！？、」』]+$/g, '')
}

export function isIgnoredArtifactPath(canonical: string): boolean {
  const segments = canonical.split(sep)
  return segments.some((segment) => IGNORED_DIR_SEGMENTS.has(segment))
}

/** Path candidates from a tool's arguments (write/edit `path` / legacy `file_path`). */
export function pathCandidatesFromArgs(args: unknown): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return []
  const record = args as Record<string, unknown>
  const candidates: string[] = []
  for (const key of ['path', 'file_path']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0 && value.length <= 4096) candidates.push(value)
  }
  return candidates
}

/** Token-level path candidates mentioned in free text, bounded and de-duplicated. */
export function pathCandidatesFromText(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of (text ?? '').slice(0, SCAN_TEXT_LIMIT).matchAll(PATH_TOKEN_RE)) {
    const token = stripTrailingPunctuation(match[0])
    // Network prefixes (https://…, //host/share, \\host\share) must never
    // reach the filesystem resolver — they would be treated as remote hosts.
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)) continue
    if (token.startsWith('//') || token.startsWith('\\\\') || token.startsWith('/\\') || token.startsWith('\\/')) continue
    if (token.length < 2 || token.length > 4096) continue
    if (seen.has(token)) continue
    seen.add(token)
    out.push(token)
    if (out.length >= MAX_SCANNED_CANDIDATES) break
  }
  return out
}

function candidateToCanonical(candidate: string, workspacePath: string): string | null {
  const target = isAbsolute(candidate) ? candidate : resolve(workspacePath, candidate)
  try {
    return canonicalizeEvenIfMissing(target)
  } catch {
    return null
  }
}

/**
 * Verifies one candidate path and returns its artifact kind — or null when
 * the file is missing, not a regular file, outside the workspace, inside an
 * ignored directory, or not a previewable extension. Results are cached so
 * repeated serialization only stats a path once per session.
 */
export function verifyArtifactCandidate(
  candidate: string,
  workspacePath: string,
  cache: ArtifactExistsCache,
): ArtifactFile | null {
  const canonical = candidateToCanonical(candidate, workspacePath)
  if (canonical === null) {
    cache.set(candidate, null)
    return null
  }
  const cached = cache.get(canonical)
  if (cached !== undefined) {
    if (cached === null) return null
    return { path: canonical, name: basename(canonical), kind: cached }
  }
  try {
    if (!existsSync(canonical) || !statSync(canonical).isFile()) {
      cache.set(canonical, null)
      return null
    }
  } catch {
    cache.set(canonical, null)
    return null
  }
  const kind = artifactKindOf(basename(canonical))
  if (kind === null) {
    cache.set(canonical, null)
    return null
  }
  const rel = relative(workspacePath, canonical)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    cache.set(canonical, null)
    return null
  }
  if (isIgnoredArtifactPath(canonical)) {
    cache.set(canonical, null)
    return null
  }
  cache.set(canonical, kind)
  return { path: canonical, name: basename(canonical), kind }
}

export interface ArtifactDiscoveryOptions {
  /** Tool name; write/edit also trust their `path`/`file_path` argument. */
  toolName: string
  /** Raw tool arguments (clipped live input may re-parse to JSON). */
  args?: unknown
  /** Tool output text (bounded scan for path mentions). */
  output: string
  /** Workspace root; candidates resolve relative to it. */
  workspacePath: string
  /** Per-session existence cache (canonical path -> kind or null). */
  cache: ArtifactExistsCache
}

/**
 * Discovers previewable artifacts produced by one tool result. Deduplicated
 * by canonical path and bounded per tool; returns [] when nothing verifies.
 */
export function discoverArtifacts(options: ArtifactDiscoveryOptions): ArtifactFile[] {
  const { toolName, args, output, workspacePath, cache } = options
  const candidates = new Set<string>()
  // write/edit carry the produced file path in their arguments.
  if (toolName === 'write' || toolName === 'edit') {
    for (const candidate of pathCandidatesFromArgs(args)) candidates.add(candidate)
  }
  // Every tool's output may mention produced files (bash, subagents).
  for (const candidate of pathCandidatesFromText(output)) candidates.add(candidate)
  const artifacts: ArtifactFile[] = []
  for (const candidate of candidates) {
    if (artifacts.length >= MAX_ARTIFACTS_PER_TOOL) break
    const verified = verifyArtifactCandidate(candidate, workspacePath, cache)
    if (verified !== null) artifacts.push(verified)
  }
  return artifacts
}