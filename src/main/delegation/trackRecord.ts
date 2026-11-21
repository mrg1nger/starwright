import type { HelperRoute } from '@shared/balance'

// How each agent (and the model it runs) has done on each kind of task lately, so one that keeps
// failing at a kind of task is tried later for it. A light touch: it moves behind the next agent
// rather than being left out, so it still gets the task when that one can't, and an agent asked
// for by name is never moved. Worked out from the hand-off records each time (nothing is stored
// but the records), on this computer only.

/** An agent's last this-many hand-offs of a kind are looked at… */
export const TRACK_WINDOW = 5
/** …and this many bad ones among them move it down. */
export const TRACK_BAD = 3
/** Only hand-offs this recent count. */
export const TRACK_DAYS = 30

/**
 * Failures before a fix that dealt with them don't count against the agent: hand-offs count from
 * this Starwright version on (older records, with no version, don't count at all).
 * - Cline, 0.19.2: an edit with no path stopped the whole run (2 of its failures on Lazarus).
 * - Local model, 0.20.1: its failures were running out of time, which 0.20.0 (only what fits,
 *   undoing before the next agent) and 0.20.1 (only slow reading hands over) dealt with.
 */
export const FIXED_SINCE: Partial<Record<HelperRoute, string>> = { cline: '0.19.2', local: '0.20.1' }

export interface TrackRow {
  status: string
  checksOk: number | null
  reworked: number
  report: string | null
  version: string | null
  model: string | null
}

export interface Track {
  route: HelperRoute
  kind: string
  /** The model it's judged on (its latest one); undefined when none is recorded. */
  model?: string
  bad: number
  of: number
  /** The version its record starts from, when a fix reset it. */
  since?: string
}

/** Numeric compare of versions like 0.19.2 (anything after a dash is ignored). */
export function versionAtLeast(version: string | null | undefined, floor: string): boolean {
  if (!version) return false
  const parts = (v: string): number[] => v.split('-')[0].split('.').map((n) => Number(n) || 0)
  const a = parts(version)
  const b = parts(floor)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

/**
 * Whether a finished hand-off counts against the agent ('bad'), for it ('good'), or not at all:
 * stopped by the user, or failed because Starwright refused something it needed.
 */
export function verdictOf(row: TrackRow): 'good' | 'bad' | null {
  if (row.status === 'running' || row.status === 'stopped') return null
  if (row.status === 'error') return /\[Starwright refused /.test(row.report ?? '') ? null : 'bad'
  return row.checksOk === 0 || row.reworked === 1 ? 'bad' : 'good'
}

/** An agent's record on one kind of task, from its hand-offs of that kind (newest first). */
export function assess(route: HelperRoute, kind: string, rows: TrackRow[], model?: string | null): Track {
  const since = FIXED_SINCE[route]
  const counted = rows
    .filter((r) => !since || versionAtLeast(r.version, since))
    // Judged on its current model: a new model starts with a clean record.
    .filter((r) => !model || r.model === model)
    .map(verdictOf)
    .filter((v): v is 'good' | 'bad' => v !== null)
    .slice(0, TRACK_WINDOW)
  return { route, kind, model: model ?? undefined, bad: counted.filter((v) => v === 'bad').length, of: counted.length, since }
}

export const movedDown = (t: Track | undefined): boolean => !!t && t.bad >= TRACK_BAD

/**
 * The routes with the ones that keep failing at this kind of task moved behind the next agent
 * that doesn't. One asked for by name stays where it is; with nobody behind it, nothing changes.
 */
export function applyTrackRecord(
  routes: HelperRoute[],
  tracks: Partial<Record<HelperRoute, Track>>,
  asked?: HelperRoute
): { routes: HelperRoute[]; moved: Track[] } {
  const down = (r: HelperRoute): boolean => r !== asked && movedDown(tracks[r])
  const moved: Track[] = []
  const score = routes.map((r, i) => {
    if (!down(r)) return i
    const behind = routes.findIndex((other, j) => j > i && !down(other))
    if (behind < 0) return i
    moved.push(tracks[r]!)
    return behind + 0.5 + i / 1000
  })
  const order = routes.map((r, i) => ({ r, s: score[i] })).sort((a, b) => a.s - b.s).map((x) => x.r)
  return { routes: order, moved }
}

const NAMES: Record<HelperRoute, string> = { codex: 'Codex', cline: 'Cline', local: 'the local model' }

/** "Cline (model-x)". */
export function whoOf(t: Pick<Track, 'route' | 'model'>, capital = true): string {
  const name = NAMES[t.route]
  const shown = capital ? name[0].toUpperCase() + name.slice(1) : name
  return t.model ? `${shown} (${t.model})` : shown
}

/** "3 of its last 5 feature hand-offs failed or were redone, since 0.19.2". */
export function recordText(t: Track): string {
  return `${t.bad} of its last ${t.of} ${t.kind} hand-offs failed or were redone${t.since ? `, since ${t.since}` : ''}`
}

/** For the hand-off row and the request row: "cline:model-x feature 3/5". */
export function moveTag(t: Track): string {
  return `${t.route}${t.model ? `:${t.model}` : ''} ${t.kind} ${t.bad}/${t.of}`
}

/** The order the agents were offered the task in, with the moved ones marked: "codex, cline↓ (feature 3/5), local". */
export function orderNote(routes: HelperRoute[], moved: Track[]): string {
  return routes
    .map((r) => {
      const t = moved.find((m) => m.route === r)
      return t ? `${r}↓ (${t.kind} ${t.bad}/${t.of})` : r
    })
    .join(', ')
}
