import type { LiveTokens } from './types'

/** Claude's tokens so far this request: written in every turn, and the conversation's size now. */
export function liveSummary(turns: Record<number, LiveTokens>): { written: number; context: number } {
  const ids = Object.keys(turns)
    .map(Number)
    .sort((a, b) => a - b)
  const written = ids.reduce((sum, id) => sum + turns[id].written, 0)
  const latest = [...ids].reverse().find((id) => turns[id].read > 0)
  return { written, context: latest === undefined ? 0 : turns[latest].read }
}

/** "45s", "1m 05s". */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
