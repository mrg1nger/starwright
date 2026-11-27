import type { ToolId, ToolUpdatePhase, ToolUpdateState, ToolVersion, ToolVersions, UpdateState } from './types'

/** a > b for plain x.y.z versions (a pre-release tag counts as older than its release). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string): [number[], string] => {
    const [main, pre = ''] = v.trim().replace(/^v/, '').split('-', 2)
    return [main.split('.').map((n) => Number(n) || 0), pre]
  }
  const [x, xPre] = parse(a)
  const [y, yPre] = parse(b)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return !xPre && !!yPre
}

/** The older version this one replaced since the last run, if it was updated (unknown before 0.4.1 recorded it). */
export function justUpdatedFrom(lastRun: string | null, current: string): string | undefined {
  return lastRun && isNewer(current, lastRun) ? lastRun : undefined
}

/** The update banner shows for a newer version the user hasn't skipped. */
export function bannerWanted(s: UpdateState, skipped: string | null): boolean {
  return (
    ['available', 'downloading', 'ready', 'error'].includes(s.status) &&
    !!s.version &&
    s.version !== skipped &&
    isNewer(s.version, s.current)
  )
}

/** Codex and Cline with a newer version out that the user hasn't skipped (the Claude SDK comes with Starwright). */
export function toolNotices(v: ToolVersions | null, skipped: Partial<Record<ToolId, string>> | undefined): ToolVersion[] {
  return (v?.tools ?? []).filter((t) => t.newer && !t.bundled && !!t.latest && skipped?.[t.tool] !== t.latest)
}

/**
 * The newest Codex and Cline this Starwright was tested with (the smoke tests, against the real
 * tool). A newer one may well work, but nobody has tried it with Starwright yet: Cline 3.0.75
 * added a step at the end of every run that Starwright's safety hook refused. Raise these when a
 * release has been tested against a newer version.
 */
export const TESTED_WITH: Record<'codex' | 'cline', string> = { codex: '0.172.0', cline: '3.0.76' }

/** Where to read what changed in a version (each tool's GitHub release). */
export function toolNotesUrl(tool: ToolId, version: string): string | undefined {
  if (tool === 'codex') return `https://github.com/openai/codex/releases/tag/rust-v${version}`
  if (tool === 'cline') return `https://github.com/cline/cline/releases/tag/cli-v${version}`
  return undefined
}

/** An update still under way (the tool is held back from new work meanwhile). */
export const UPDATE_RUNNING: ToolUpdatePhase[] = ['waiting', 'installing', 'checking', 'rolling-back']

/** Phases that need the user: the new version failed its check. */
export function updateNeedsChoice(s: ToolUpdateState | undefined): boolean {
  return s?.phase === 'failed'
}

/** How to update each tool, in a terminal on the computer running Starwright. */
export const TOOL_UPDATE_COMMANDS: Record<ToolId, string> = {
  codex: 'npm i -g @openai/codex@latest',
  cline: 'npm i -g cline@latest',
  claude: ''
}

/** For the usage report: a line per tool. */
export function toolVersionLines(v: ToolVersions): string[] {
  if (!v.tools.length) return []
  const name: Record<ToolId, string> = { codex: 'Codex', cline: 'Cline', claude: 'Claude Agent SDK (built in)' }
  return [
    `## Tools${v.checkedAt ? ` (checked ${v.checkedAt.slice(0, 16).replace('T', ' ')} UTC)` : ''}`,
    ...v.tools.map((t) => {
      const have = t.installed ?? (t.tool === 'claude' ? 'unknown' : 'not installed')
      const out = t.newer ? `, ${t.latest} is out` : t.latest ? ', the newest' : t.error ? ` (couldn't ask npm: ${t.error})` : ''
      const update = v.updates?.[t.tool]
      const after =
        update?.phase === 'failed'
          ? ` (updated from ${update.from ?? '?'} and failed Starwright's check: ${(update.problems ?? []).join('; ')})`
          : update && UPDATE_RUNNING.includes(update.phase)
            ? ` (being updated to ${update.to})`
            : ''
      const untested = t.untested && t.newer ? ` (not yet tested with Starwright, which was tested up to ${t.testedWith})` : ''
      return `- ${name[t.tool]}: ${have}${t.installed ? out + untested : ''}${after}`
    })
  ]
}
