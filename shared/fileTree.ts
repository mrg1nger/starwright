import type { FileChange } from './types'

/** A folder (with children) or a file in the Files pane's tree. */
export interface FileNode {
  name: string
  /** Project-relative, forward slashes. */
  path: string
  children?: FileNode[]
  /** A file's change since the last checkpoint. */
  change?: FileChange
  /** A folder: how many files inside it changed. */
  changedInside?: number
}

const byName = (a: FileNode, b: FileNode): number =>
  !!b.children === !!a.children ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.children ? -1 : 1

/** The listed paths as a tree: folders first, then files, by name; folders count the changes inside. */
export function buildTree(files: string[], changed: Record<string, FileChange> = {}): FileNode[] {
  const root: FileNode = { name: '', path: '', children: [] }
  const dirs = new Map<string, FileNode>([['', root]])
  for (const file of files) {
    const parts = file.split('/')
    let parent = root
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let dir = dirs.get(path)
      if (!dir) {
        dir = { name: parts[i], path, children: [] }
        dirs.set(path, dir)
        parent.children!.push(dir)
      }
      parent = dir
    }
    const change = changed[file]
    parent.children!.push(change ? { name: parts[parts.length - 1], path: file, change } : { name: parts[parts.length - 1], path: file })
    if (change) {
      for (let i = 1; i < parts.length; i++) {
        const dir = dirs.get(parts.slice(0, i).join('/'))!
        dir.changedInside = (dir.changedInside ?? 0) + 1
      }
    }
  }
  const sort = (nodes: FileNode[]): void => {
    nodes.sort(byName)
    for (const n of nodes) if (n.children) sort(n.children)
  }
  sort(root.children!)
  return root.children!
}

/**
 * Files whose path has every word typed (any case), names that match first, then shorter paths.
 * At most `limit`.
 */
export function filterFiles(files: string[], query: string, limit = 200): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const name = (f: string): string => f.slice(f.lastIndexOf('/') + 1).toLowerCase()
  return files
    .filter((f) => {
      const p = f.toLowerCase()
      return words.every((w) => p.includes(w))
    })
    .map((f) => ({ f, named: words.every((w) => name(f).includes(w)) }))
    .sort((a, b) => Number(b.named) - Number(a.named) || a.f.length - b.f.length || a.f.localeCompare(b.f))
    .slice(0, limit)
    .map((m) => m.f)
}

const LANGUAGES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  svelte: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  bat: 'dos',
  cmd: 'dos',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  sql: 'sql',
  swift: 'swift',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  vb: 'vbnet',
  graphql: 'graphql',
  gql: 'graphql',
  diff: 'diff',
  patch: 'diff'
}

/** The highlighting language for a file, by its name; undefined for plain text. */
export function languageFor(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'dockerfile' || name.endsWith('.dockerfile')) return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  if (name.startsWith('.env')) return 'ini'
  const dot = name.lastIndexOf('.')
  return dot > 0 || (dot === 0 && name.length > 1) ? LANGUAGES[name.slice(dot + 1)] : undefined
}

export const isMarkdownFile = (path: string): boolean => /\.(md|markdown|mdx)$/i.test(path)

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Words for a change, for the marker's tooltip. */
export const CHANGE_WORDS: Record<FileChange, string> = {
  modified: 'Changed since the last checkpoint',
  added: 'New since the last checkpoint',
  untracked: 'New since the last checkpoint',
  renamed: 'Renamed since the last checkpoint',
  deleted: 'Deleted since the last checkpoint'
}
