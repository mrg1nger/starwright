import { readdirSync, statSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'

/**
 * How much a hand-off will have to read, roughly, from the files and folders it names: so a task
 * that can't fit in the local model's context goes to an agent with room for it, instead of the
 * local model reading, losing what it read, and running out of time (on Lazarus, 2026-11-19: 20
 * files, about 70k tokens, into a 96k context; ten minutes, then Cline did it in 30 seconds).
 */

/** Folders that are never part of what a task reads. */
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', '.next', 'coverage'])
/** Most files counted in one folder named by the task: past this the estimate is big enough anyway. */
const MAX_FILES = 2_000
/** Characters per token, on the low side for code, so the estimate errs towards "doesn't fit". */
const CHARS_PER_TOKEN = 3.5

/** Path-like words in the task ("src/app.js", "server\\routes.ts", "README.md"). */
export function pathsIn(text: string): string[] {
  // Not web addresses or version numbers.
  const found = text.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, ' ').match(/(?:[\w.-]+[\\/])*[\w.-]+\.[A-Za-z][\w]{0,5}\b/g) ?? []
  return [...new Set(found.filter((p) => !/^(?:\d+\.)+\d+$/.test(p) && !/^www\./i.test(p)))]
}

/** Total size in bytes of a file, or of the files under a folder (capped). */
function sizeOf(path: string, budget: { files: number }): number {
  let info
  try {
    info = statSync(path)
  } catch {
    return 0
  }
  if (info.isFile()) {
    budget.files--
    return info.size
  }
  if (!info.isDirectory()) return 0
  let total = 0
  let entries: string[]
  try {
    entries = readdirSync(path)
  } catch {
    return 0
  }
  for (const name of entries) {
    if (budget.files <= 0) break
    if (SKIP.has(name) || name.startsWith('.')) continue
    total += sizeOf(join(path, name), budget)
  }
  return total
}

/**
 * Tokens the files and folders named (in `files`, or in the task's own words) come to. Paths outside
 * the project, or that don't exist, count for nothing. Each is counted once.
 */
export function estimateReadTokens(projectPath: string, prompt: string, files: string[] = []): { tokens: number; counted: string[] } {
  const root = resolve(projectPath)
  const seen = new Set<string>()
  const counted: string[] = []
  const budget = { files: MAX_FILES }
  let bytes = 0
  for (const raw of [...files, ...pathsIn(prompt)]) {
    const full = isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
    const rel = relative(root, full)
    if (rel.startsWith('..') || isAbsolute(rel) || seen.has(full.toLowerCase())) continue
    // A folder inside one already counted is in its total.
    if ([...seen].some((s) => full.toLowerCase().startsWith(`${s}\\`) || full.toLowerCase().startsWith(`${s}/`))) continue
    const size = sizeOf(full, budget)
    if (!size) continue
    seen.add(full.toLowerCase())
    counted.push(rel || '.')
    bytes += size
  }
  return { tokens: Math.ceil(bytes / CHARS_PER_TOKEN), counted }
}

/** Whether a task that reads this much fits the local model: it needs room to work as well as to read. */
export function fitsLocalContext(tokens: number, contextLength: number): boolean {
  return tokens <= contextLength * 0.5
}
