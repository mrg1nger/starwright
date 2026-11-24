import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { simpleGit } from 'simple-git'
import type { FileChange, ProjectFileContent, ProjectFileList } from '@shared/types'

/** At most this many files are listed (a project with more says so). */
export const MAX_FILES = 20_000
/** Text beyond this is not sent to the screen; the start of the file is shown. */
export const MAX_TEXT_BYTES = 512 * 1024
/** Pictures bigger than this are shown as a file size, not drawn. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Folders skipped when the project isn't a git repo (in a repo, .gitignore decides). */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', 'target', '.turbo'])

/** Files that usually hold secrets: listed by name, never shown. Example files are fine. */
const SECRET_NAME = /^(\.env(\..+)?|\.npmrc|\.netrc|\.pypirc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)|.+\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk))$/i
const NOT_SECRET = /^\.env\.(example|sample|template|dist|defaults)$/i

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
}

export function isSecretFile(path: string): boolean {
  const name = path.split('/').pop() ?? ''
  return SECRET_NAME.test(name) && !NOT_SECRET.test(name)
}

/**
 * A project-relative path (forward slashes) as a full path inside the project, or an error. Nothing
 * outside the project can be reached: no absolute paths, no "..", nothing in .git, and no link that
 * leads out of the folder.
 */
export function safeProjectPath(root: string, rel: unknown): string {
  if (typeof rel !== 'string' || !rel || rel.length > 1000 || rel.includes('\0')) throw new Error('Not a file in this project.')
  if (isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.startsWith('\\\\')) throw new Error('Not a file in this project.')
  const base = resolve(root)
  const full = resolve(base, rel)
  const inside = (parent: string, child: string): boolean => {
    const r = relative(parent, child)
    return !!r && !r.startsWith('..') && !isAbsolute(r)
  }
  if (!inside(base, full)) throw new Error('Not a file in this project.')
  if (relative(base, full).split(sep)[0].toLowerCase() === '.git') throw new Error('Not a file in this project.')
  if (existsSync(full) && !inside(realpathSync(base), realpathSync(full))) throw new Error('Not a file in this project.')
  return full
}

/** What changed since the last checkpoint, from `git status` (-z: raw paths, renames as two entries). */
export function parseStatus(raw: string): Record<string, FileChange> {
  const changed: Record<string, FileChange> = {}
  const parts = raw.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    if (code === '??') changed[path] = 'untracked'
    else if (code.includes('R') || code.includes('C')) {
      changed[path] = 'renamed'
      i++ // the old name follows
    } else if (code.includes('D')) changed[path] = 'deleted'
    else if (code.includes('A')) changed[path] = 'added'
    else changed[path] = 'modified'
  }
  return changed
}

function walk(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string, prefix: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (files.length > MAX_FILES) return
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(join(dir, e.name), `${prefix}${e.name}/`)
      } else if (e.isFile()) files.push(`${prefix}${e.name}`)
    }
  }
  visit(root, '')
  return files
}

/** The project's files (as .gitignore leaves them) and which changed since the last checkpoint. */
export async function listProjectFiles(root: string): Promise<ProjectFileList> {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error("The project's folder isn't there.")
  let files: string[]
  let changed: Record<string, FileChange> = {}
  if (existsSync(join(root, '.git'))) {
    const git = simpleGit(root)
    const [listed, status] = await Promise.all([
      git.raw(['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
      git.raw(['status', '--porcelain=v1', '-z', '--untracked-files=all']).catch(() => '')
    ])
    changed = parseStatus(status)
    // Deleted files are still in git's list but can't be opened; a nested repo shows as "folder/".
    files = [...new Set(listed.split('\0'))].filter((f) => f && !f.endsWith('/') && changed[f] !== 'deleted')
  } else {
    files = walk(root)
  }
  files.sort((a, b) => a.localeCompare(b))
  const truncated = files.length > MAX_FILES
  return { files: truncated ? files.slice(0, MAX_FILES) : files, changed, truncated }
}

/** One file to show: its text (the start of a big one), a picture, or only its size (binary or secret). */
export function readProjectFile(root: string, rel: string): ProjectFileContent {
  const full = safeProjectPath(root, rel)
  if (!existsSync(full)) throw new Error("That file isn't there any more.")
  const stat = statSync(full)
  if (!stat.isFile()) throw new Error('That is a folder, not a file.')
  const path = rel.replace(/\\/g, '/')
  const size = stat.size
  if (isSecretFile(path)) return { kind: 'secret', path, size }
  const mime = IMAGE_TYPES[extname(full).toLowerCase()]
  if (mime) {
    if (size > MAX_IMAGE_BYTES) return { kind: 'binary', path, size }
    const fd = openSync(full, 'r')
    try {
      const buf = Buffer.alloc(size)
      readSync(fd, buf, 0, size, 0)
      return { kind: 'image', path, size, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    } finally {
      closeSync(fd)
    }
  }
  const length = Math.min(size, MAX_TEXT_BYTES)
  const buf = Buffer.alloc(length)
  const fd = openSync(full, 'r')
  try {
    readSync(fd, buf, 0, length, 0)
  } finally {
    closeSync(fd)
  }
  if (buf.subarray(0, 8000).includes(0)) return { kind: 'binary', path, size }
  let text = buf.toString('utf-8').replace(/^﻿/, '')
  const truncated = size > MAX_TEXT_BYTES
  // A cut file ends on a whole line (and never in the middle of a character).
  if (truncated) text = text.slice(0, Math.max(0, text.lastIndexOf('\n')))
  return { kind: 'text', path, size, text, truncated }
}
