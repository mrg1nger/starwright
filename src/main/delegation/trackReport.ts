import type { DatabaseSync } from 'node:sqlite'
import type { HelperRoute } from '@shared/balance'
import {
  codexHandoffsWithoutModel,
  fillHandoffModelsFromUsage,
  getMeta,
  latestHandoffModel,
  movedHandoffsSince,
  routeOf,
  setHandoffModel,
  setMeta,
  trackKindsSince,
  trackRows
} from '../memory/store'
import { matchCodexRuns } from '../cli/codexSessions'
import { FIXED_SINCE, TRACK_BAD, TRACK_DAYS, assess, movedDown, whoOf, type Track } from './trackRecord'

/** The track record as it stands, for the usage report. */
export interface TrackSummary {
  /** Moved down now, for a kind of task. */
  moved: Track[]
  /** Some bad results lately, not (yet) enough to move it. */
  watching: Track[]
  /** Hand-offs whose order the track record changed, and how the agent that took them did. */
  changed: { total: number; byAgent: Record<string, { done: number; failed: number }> }
}

export function trackSummary(db: DatabaseSync, projectId?: string): TrackSummary {
  const since = new Date(Date.now() - TRACK_DAYS * 86_400_000).toISOString()
  const moved: Track[] = []
  const watching: Track[] = []
  for (const { agent, kind } of trackKindsSince(db, since)) {
    const route = routeOf(agent)
    if (!route || route === 'claude') continue
    const t = assess(route as HelperRoute, kind, trackRows(db, agent, kind, since), latestHandoffModel(db, agent))
    if (movedDown(t)) moved.push(t)
    else if (t.bad > 0) watching.push(t)
  }
  const byAgent: Record<string, { done: number; failed: number }> = {}
  const rows = movedHandoffsSince(db, since, projectId)
  for (const r of rows) {
    const tally = (byAgent[r.agent] ??= { done: 0, failed: 0 })
    if (r.status === 'done') tally.done++
    else if (r.status === 'error') tally.failed++
  }
  const order = (a: Track, b: Track): number => b.bad - a.bad || a.route.localeCompare(b.route)
  return { moved: moved.sort(order), watching: watching.sort(order), changed: { total: rows.length, byAgent } }
}

const AGENT_LABELS: Record<string, string> = { codex: 'Codex', cline: 'Cline', local: 'Local model' }

/** The report's section. */
export function trackLines(t: TrackSummary): string[] {
  const fixes = Object.entries(FIXED_SINCE)
    .map(([r, v]) => `${AGENT_LABELS[r]} from ${v}`)
    .join(', ')
  const lines = [
    `## Track record (last ${TRACK_DAYS} days; ${TRACK_BAD} bad of an agent's last 5 hand-offs of a kind moves it down; counting since its last fix: ${fixes})`
  ]
  lines.push(
    t.moved.length
      ? `- Moved down now: ${t.moved.map((m) => `${whoOf(m)} for ${m.kind} (${m.bad} of ${m.of})`).join(' · ')}`
      : '- Moved down now: nobody'
  )
  if (t.watching.length) lines.push(`- Some bad lately: ${t.watching.map((m) => `${whoOf(m)} ${m.kind} ${m.bad} of ${m.of}`).join(' · ')}`)
  const went = Object.entries(t.changed.byAgent)
    .map(([a, v]) => `${AGENT_LABELS[a] ?? a} ${v.done} done, ${v.failed} failed`)
    .join(' · ')
  lines.push(`- Changed who got the task: ${t.changed.total} time${t.changed.total === 1 ? '' : 's'}${went ? `; those went to ${went}` : ''}`)
  return lines
}

/**
 * Once: fills in the model of hand-offs recorded before it was, from the token log (Cline and the
 * local model) and Codex's own session files (Codex). Codex runs it can't match stay without one.
 */
export async function fillHandoffModels(db: DatabaseSync): Promise<{ usage: number; codex: number }> {
  if (getMeta(db, 'filled_handoff_models')) return { usage: 0, codex: 0 }
  const usage = fillHandoffModelsFromUsage(db)
  const missing = codexHandoffsWithoutModel(db)
  const found = await matchCodexRuns(missing)
  for (const [id, run] of found) setHandoffModel(db, id, run.model, run.effort)
  setMeta(db, 'filled_handoff_models', new Date().toISOString())
  return { usage, codex: found.size }
}
