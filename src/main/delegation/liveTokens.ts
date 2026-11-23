import { closeSync, openSync, readSync, statSync } from 'fs'
import type { LiveTokens } from '@shared/types'
import { listSessionFiles, sessionsDir } from '../cli/codexSessions'

// A hand-off's tokens while it runs. Codex's JSON events only give them when its turn ends, but
// its session file (~/.codex/sessions/.../rollout-*-<thread>.jsonl) gets a token_count line after
// every step, with running totals for the thread. Hosted Cline keeps running totals in its own
// session file. Both are read every couple of seconds; only a change is passed on.

const POLL_MS = 1500

/** Calls `read` every so often and passes on what changed, until stopped. */
export function pollTokens(read: () => LiveTokens | null, onTokens: (t: LiveTokens) => void, everyMs = POLL_MS): () => void {
  let last = ''
  const tick = (): void => {
    let now: LiveTokens | null = null
    try {
      now = read()
    } catch {
      return
    }
    if (!now) return
    const key = `${now.read}/${now.written}/${now.steps}`
    if (key === last) return
    last = key
    onTokens(now)
  }
  const timer = setInterval(tick, everyMs)
  return () => {
    clearInterval(timer)
    // One last look, so the card ends on the final figures.
    tick()
  }
}

interface TokenCountLine {
  timestamp?: string
  type?: string
  payload?: { type?: string; info?: { total_token_usage?: { input_tokens?: number; output_tokens?: number } } | null }
}

/**
 * Reads a Codex thread's session file as it grows: tokens since `startedAt` (a resumed thread's
 * file already holds earlier runs' totals, which are taken off).
 */
export function codexTokenReader(threadId: string, startedAt: Date, root = sessionsDir()): () => LiveTokens | null {
  let path: string | undefined
  let offset = 0
  let rest = ''
  let base = { input: 0, output: 0 }
  let total: { input: number; output: number } | undefined
  let steps = 0
  return () => {
    if (!path) {
      const now = new Date()
      path = listSessionFiles(new Date(now.getTime() - 2 * 86_400_000), now, root).find((f) => f.id === threadId)?.path
      if (!path) return null
    }
    const size = statSync(path).size
    if (size > offset) {
      const fd = openSync(path, 'r')
      try {
        const buf = Buffer.alloc(size - offset)
        readSync(fd, buf, 0, buf.length, offset)
        offset = size
        rest += buf.toString('utf8')
      } finally {
        closeSync(fd)
      }
      const lines = rest.split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.includes('"token_count"')) continue
        let e: TokenCountLine
        try {
          e = JSON.parse(line) as TokenCountLine
        } catch {
          continue
        }
        const t = e.payload?.type === 'token_count' ? e.payload.info?.total_token_usage : undefined
        if (!t) continue
        const now = { input: t.input_tokens ?? 0, output: t.output_tokens ?? 0 }
        if (e.timestamp && new Date(e.timestamp) < startedAt) {
          base = now
          continue
        }
        // The same totals can be repeated: a step is a change.
        if (total && total.input === now.input && total.output === now.output) continue
        total = now
        steps++
      }
    }
    if (!total) return null
    return { read: Math.max(0, total.input - base.input), written: Math.max(0, total.output - base.output), steps }
  }
}
