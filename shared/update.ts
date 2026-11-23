import type { ToolId, ToolVersion, ToolVersions, UpdateState } from './types'

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
      return `- ${name[t.tool]}: ${have}${t.installed ? out : ''}`
    })
  ]
}
