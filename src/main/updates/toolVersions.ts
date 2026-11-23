import { app } from 'electron'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import type { ToolId, ToolVersion, ToolVersions } from '@shared/types'
import { isNewer } from '@shared/update'
import { getSettings } from '../settings/store'
import { execCli } from '../cli/execCli'
import { clineStatus } from '../cli/clineExec'

// Whether there's a newer Codex, Cline or Claude Agent SDK than the one Starwright uses. Only says
// so: an update can change what Starwright reads from these tools, so it's for the user to choose.
// Codex and Cline are installed separately on each computer; the Claude Agent SDK is built into
// Starwright and comes with a Starwright update. The newest versions are asked of the npm registry
// (each tool's public package page, nothing about this computer sent).

const FIRST_CHECK_MS = 60_000
const CHECK_EVERY_MS = 12 * 60 * 60_000

export const TOOL_PACKAGES: Record<ToolId, string> = {
  codex: '@openai/codex',
  cline: 'cline',
  claude: '@anthropic-ai/claude-agent-sdk'
}

export interface ToolCheckDeps {
  installed: (tool: ToolId) => Promise<string | undefined>
  latest: (pkg: string) => Promise<string>
  now: () => Date
}

type Send = (channel: string, ...args: unknown[]) => void

let state: ToolVersions = { tools: [] }
let send: Send = () => undefined
let timer: ReturnType<typeof setInterval> | undefined
let running: Promise<ToolVersions> | undefined

/** The x.y.z in a --version line ("codex-cli 0.158.0", "3.0.74"). */
export function versionIn(text: string): string | undefined {
  return text.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0]
}

async function installedVersion(tool: ToolId): Promise<string | undefined> {
  if (tool === 'claude') {
    try {
      // The package doesn't export its package.json: find it next to the module.
      const main = require.resolve('@anthropic-ai/claude-agent-sdk')
      return (JSON.parse(readFileSync(join(dirname(main), 'package.json'), 'utf8')) as { version?: string }).version
    } catch {
      return undefined
    }
  }
  if (tool === 'cline') return (await clineStatus()).version
  try {
    const { stdout } = await execCli('codex', ['--version'], { timeout: 20_000 })
    return versionIn(stdout)
  } catch {
    return undefined
  }
}

async function latestVersion(pkg: string): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(`npm answered ${res.status}`)
  const version = ((await res.json()) as { version?: string }).version
  if (!version) throw new Error('npm gave no version')
  return version
}

/** The test switch: a JSON file of { tool: { installed, latest } } instead of the real tools and npm. */
function testDeps(): ToolCheckDeps | undefined {
  if (process.env.VIBEAPP_TEST_HOOKS !== '1') return undefined
  let fake: Partial<Record<ToolId, { installed?: string; latest?: string }>>
  try {
    fake = JSON.parse(readFileSync(join(app.getPath('userData'), 'test-tool-versions.json'), 'utf8'))
  } catch {
    return undefined
  }
  const byPkg = (pkg: string): ToolId | undefined => (Object.keys(TOOL_PACKAGES) as ToolId[]).find((t) => TOOL_PACKAGES[t] === pkg)
  return {
    installed: async (tool) => fake[tool]?.installed,
    latest: async (pkg) => {
      const v = fake[byPkg(pkg) ?? 'codex']?.latest
      if (!v) throw new Error('not in the test file')
      return v
    },
    now: () => new Date()
  }
}

const realDeps: ToolCheckDeps = { installed: installedVersion, latest: latestVersion, now: () => new Date() }

/** One look at each tool: what's in use here, the newest published, and whether that's newer. */
export async function checkTools(deps: ToolCheckDeps): Promise<ToolVersions> {
  const tools = await Promise.all(
    (Object.keys(TOOL_PACKAGES) as ToolId[]).map(async (tool): Promise<ToolVersion> => {
      const [installed, latest] = await Promise.all([
        deps.installed(tool).catch(() => undefined),
        deps.latest(TOOL_PACKAGES[tool]).then(
          (v) => ({ v }),
          (err: Error) => ({ err: err.message })
        )
      ])
      const row: ToolVersion = { tool, package: TOOL_PACKAGES[tool], bundled: tool === 'claude', newer: false }
      if (installed) row.installed = installed
      if ('v' in latest) row.latest = latest.v
      else row.error = latest.err
      row.newer = !!(row.installed && row.latest && isNewer(row.latest, row.installed))
      return row
    })
  )
  return { tools, checkedAt: deps.now().toISOString() }
}

export function toolVersions(): ToolVersions {
  return state
}

/** Looks now (one look at a time). */
export function checkToolVersions(deps: ToolCheckDeps = testDeps() ?? realDeps): Promise<ToolVersions> {
  running ??= checkTools(deps)
    .then((next) => {
      // A tool npm couldn't be asked about keeps what was known before.
      next.tools = next.tools.map((t) => {
        const before = state.tools.find((b) => b.tool === t.tool)
        return !t.latest && before?.latest
          ? { ...t, latest: before.latest, newer: !!(t.installed && isNewer(before.latest, t.installed)) }
          : t
      })
      state = next
      send('vibe:tools:changed', state)
      return state
    })
    .finally(() => {
      running = undefined
    })
  return running
}

/** Soon after start and twice a day, while "Look for new versions" is on. */
export function startToolVersionChecks(sendToScreens: Send): void {
  send = sendToScreens
  const due = (): void => {
    // The app tests only look when they've written the test file (no real notice in their way).
    if (process.env.VIBEAPP_TEST_HOOKS === '1' && !testDeps()) return
    if (getSettings().updateChecks) void checkToolVersions().catch(() => undefined)
  }
  setTimeout(due, process.env.VIBEAPP_TEST_HOOKS === '1' ? 3_000 : FIRST_CHECK_MS)
  timer = setInterval(due, CHECK_EVERY_MS)
}

export function stopToolVersionChecks(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
