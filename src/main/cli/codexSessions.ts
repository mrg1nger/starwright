import { createReadStream, existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createInterface } from 'readline'

// Which model Codex actually used for a run. Its events don't say, but it saves every run as
// ~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl, whose turn_context lines
// carry the model and reasoning effort (checked on codex-cli 0.158.0). Each run also has a side
// session for its own command reviewer (model "codex-auto-review"), which isn't the one that
// did the work.

export interface CodexRunModel {
  model: string
  effort?: string
}

const sessionsDir = (): string => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')

/** Codex's own reviewer of commands, not the model that did the work. */
const REVIEWER_MODELS = new Set(['codex-auto-review'])

export interface SessionFile {
  path: string
  /** When the run started, from the file name (Codex writes it in local time). */
  startedAt: Date
  id: string
}

const NAME = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/

export function parseSessionName(name: string): { startedAt: Date; id: string } | null {
  const m = NAME.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi, s, id] = m
  return { startedAt: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)), id }
}

/** Session files in the day folders from `from` to `to` (local dates), oldest first. */
export function listSessionFiles(from: Date, to: Date, root = sessionsDir()): SessionFile[] {
  const out: SessionFile[] = []
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate())
  for (; day <= end; day.setDate(day.getDate() + 1)) {
    const dir = join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    if (!existsSync(dir)) continue
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const parsed = parseSessionName(name)
      if (parsed) out.push({ path: join(dir, name), ...parsed })
    }
  }
  return out.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
}

/** The model and effort a session file records (its first turn_context), or null. Reads only as far as it needs. */
export async function readSessionModel(path: string): Promise<CodexRunModel | null> {
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    let read = 0
    for await (const line of lines) {
      if (++read > 400) break
      if (!line.includes('"turn_context"')) continue
      try {
        const entry = JSON.parse(line) as { type?: string; payload?: { model?: string; effort?: string; reasoning_effort?: string } }
        if (entry.type !== 'turn_context' || !entry.payload?.model) continue
        return { model: entry.payload.model, effort: entry.payload.effort ?? entry.payload.reasoning_effort }
      } catch {
        continue
      }
    }
    return null
  } finally {
    lines.close()
    stream.destroy()
  }
}

/** The model a Codex run used, from its session file (found by the thread id Codex reported). */
export async function codexRunModel(threadId: string | undefined, root = sessionsDir()): Promise<CodexRunModel | null> {
  if (!threadId) return null
  const now = new Date()
  const from = new Date(now.getTime() - 2 * 86_400_000)
  const file = listSessionFiles(from, now, root).find((f) => f.id === threadId)
  if (!file) return null
  const found = await readSessionModel(file.path).catch(() => null)
  return found && !REVIEWER_MODELS.has(found.model) ? found : null
}

/**
 * For hand-offs recorded before the model was: the run that started closest to each start time
 * (within two minutes after it, or a few seconds before), leaving out the command reviewer's.
 */
export async function matchCodexRuns(
  starts: { id: number; startedAt: string }[],
  root = sessionsDir()
): Promise<Map<number, CodexRunModel>> {
  const out = new Map<number, CodexRunModel>()
  if (!starts.length) return out
  const times = starts.map((s) => new Date(s.startedAt).getTime()).filter((t) => !Number.isNaN(t))
  const files = listSessionFiles(new Date(Math.min(...times) - 86_400_000), new Date(Math.max(...times) + 86_400_000), root)
  const models = new Map<string, CodexRunModel | null>()
  const modelOf = async (file: SessionFile): Promise<CodexRunModel | null> => {
    if (!models.has(file.path)) models.set(file.path, await readSessionModel(file.path).catch(() => null))
    return models.get(file.path) ?? null
  }
  const used = new Set<string>()
  for (const start of starts) {
    const at = new Date(start.startedAt).getTime()
    if (Number.isNaN(at)) continue
    const near = files
      .filter((f) => !used.has(f.path) && f.startedAt.getTime() >= at - 5_000 && f.startedAt.getTime() <= at + 120_000)
      .sort((a, b) => Math.abs(a.startedAt.getTime() - at) - Math.abs(b.startedAt.getTime() - at))
    for (const file of near) {
      const found = await modelOf(file)
      if (!found || REVIEWER_MODELS.has(found.model)) continue
      used.add(file.path)
      out.set(start.id, found)
      break
    }
  }
  return out
}
