import { app } from 'electron'
import { execFile } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { ToolUpdateState } from '@shared/types'
import { UPDATE_RUNNING } from '@shared/update'
import { execCli, type ExecCliError } from '../cli/execCli'
import { resolveClineLaunch, runCline } from '../cli/clineExec'
import { codexFailure, runCodexExec, toolProcessCount } from '../cli/codexExec'
import { stopIdleHostedCline } from '../cli/clineAcp'
import { getSettings, updateSettings } from '../settings/store'
import { clearToolGate, setToolGate } from './toolGate'
import { checkToolVersions, installedVersion, notifyScreens, npmGlobalRoot, npmGlobalVersion, publishToolUpdates, TOOL_PACKAGES, toolVersions } from './toolVersions'

// Updates Codex or Cline when the user asks (Update in the notice or in Settings), the way they'd
// do it in a terminal (npm install -g), then checks the new version still does what Starwright
// relies on, because an update can break that quietly: Cline 3.0.75 added a step at the end of
// every run that Starwright's safety hook refused, so every run stopped at its end.
//
// 1. waiting: new work goes to the other agents; runs under way finish (idle hosted Clines stop).
// 2. installing: nothing may start the tool (Windows can't replace a running program).
// 3. checking: the version is the new one, it still lists the options Starwright passes it, and a
//    short real run through Starwright's safety hook answers (for Cline a one-off run, as
//    background jobs use, and a hosted one, as hand-offs use).
// 4. done, or failed: the tool stays held back from work until the user puts the old version back
//    or keeps the new one. Kept across restarts (tool-updates.json).

export type UpdatableTool = 'codex' | 'cline'

const NAMES: Record<UpdatableTool, string> = { codex: 'Codex', cline: 'Cline' }
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/
const WAIT_LIMIT_MS = 15 * 60_000
const INSTALL_TIMEOUT_MS = 10 * 60_000

/**
 * The options Starwright passes each tool (codexExec.ts, clineExec.ts, clineAcp.ts). Checked
 * against the new version's --help (verified on codex-cli 0.158.0 and cline 3.0.76).
 */
export const REQUIRED_FLAGS: Record<UpdatableTool, string[]> = {
  codex: [
    '--json',
    '--sandbox',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '--output-last-message',
    '--cd',
    '--model',
    '--config',
    '--ephemeral',
    '--image',
    '--output-schema',
    '--approve-for-me',
    '--dangerously-bypass-hook-trust'
  ],
  cline: ['--version', '--plan', '--json', '--cwd', '--thinking', '--compaction', '--model', '--system', '--timeout', '--acp']
}

/** The options in `required` that a --help text doesn't list. */
export function missingFlags(tool: UpdatableTool, help: string): string[] {
  return REQUIRED_FLAGS[tool].filter((flag) => !new RegExp(`(^|[\\s,=\\[(])${flag}(?![\\w-])`).test(help))
}

export interface UpdateDeps {
  /** The version Starwright runs now (what --version says). */
  installed: (tool: UpdatableTool) => Promise<string | undefined>
  /** The version npm has installed globally (undefined: not installed with npm). */
  npmVersion: (pkg: string) => Promise<string | undefined>
  /** npm install -g pkg@version; throws with npm's own words. */
  install: (pkg: string, version: string) => Promise<void>
  /** The tool's --help (all of it that matters) and anything missing outright. */
  help: (tool: UpdatableTool) => Promise<{ text: string; problems: string[] }>
  /** A short real run (or two): what went wrong, if anything. */
  tryRuns: (tool: UpdatableTool) => Promise<string[]>
  /** How many of its processes Starwright has running. */
  busy: (tool: UpdatableTool) => number
  /** Copies of the tool running outside Starwright (a terminal, an editor): Windows can't replace them. */
  othersRunning: (tool: UpdatableTool) => Promise<number>
  /** Ends the ones with nothing to do (hosted Clines between requests). */
  stopIdle: (tool: UpdatableTool) => void
  sleep: (ms: number) => Promise<void>
  now: () => Date
  /** The version is skipped in the new-version notice (after putting the old one back). */
  skip: (tool: UpdatableTool, version: string) => void
  /** Look at the versions again, now that one changed. */
  refresh: () => void
}

// ---- state ----

let updates: Partial<Record<UpdatableTool, ToolUpdateState>> = {}
/** One update at a time: two npm installs at once can trip over each other. */
let active: UpdatableTool | undefined
let stateFile: string | undefined

function file(): string {
  return (stateFile ??= join(app.getPath('userData'), 'tool-updates.json'))
}

function set(tool: UpdatableTool, next: ToolUpdateState | undefined): ToolUpdateState | undefined {
  if (next) updates[tool] = next
  else delete updates[tool]
  persist()
  return next
}

function persist(): void {
  try {
    writeFileSync(file(), JSON.stringify(updates, null, 2), 'utf8')
  } catch {
    // Shown either way; only a restart would lose it.
  }
  publishToolUpdates({ ...updates })
}

export function toolUpdates(): Partial<Record<UpdatableTool, ToolUpdateState>> {
  return { ...updates }
}

function heldReason(tool: UpdatableTool, s: ToolUpdateState): string {
  return `${NAMES[tool]} ${s.to} failed Starwright's check after updating, so it's not given work until you choose: put ${s.from ?? 'the old version'} back, or keep it (Settings → Updates).`
}

/**
 * At start: what was under way when Starwright closed. A failed check holds the tool back again;
 * an update cut off part-way is treated as failed (its new version was never checked).
 */
export function restoreToolUpdates(path?: string): void {
  if (path) stateFile = path
  updates = {}
  try {
    if (existsSync(file())) updates = JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    updates = {}
  }
  for (const tool of Object.keys(updates) as UpdatableTool[]) {
    const s = updates[tool]
    if (!s || !(tool in NAMES)) {
      delete updates[tool]
      continue
    }
    if (s.phase === 'waiting') {
      delete updates[tool]
      continue
    }
    if (UPDATE_RUNNING.includes(s.phase)) {
      updates[tool] = { ...s, phase: 'failed', message: undefined, problems: ['Starwright closed before the update was finished and checked.'] }
    }
    if (updates[tool]?.phase === 'failed') setToolGate(tool, 'hold', heldReason(tool, updates[tool]!))
  }
  persist()
}

// ---- the check ----

/** Everything wrong with the version now installed, as far as Starwright can tell (none: it's fine). */
export async function checkUpdatedTool(tool: UpdatableTool, version: string, deps: UpdateDeps): Promise<string[]> {
  const name = NAMES[tool]
  const have = await deps.installed(tool).catch(() => undefined)
  if (!have) return [`Starwright can't find ${name} after the update.`]
  if (have !== version) return [`Starwright still finds ${name} ${have}, not ${version}: another copy may come first on the PATH.`]
  const problems: string[] = []
  const help = await deps.help(tool).catch((err: Error) => ({ text: '', problems: [`${name} --help didn't answer: ${err.message}`] }))
  problems.push(...help.problems)
  const missing = help.text ? missingFlags(tool, help.text) : []
  if (missing.length) problems.push(`${name} ${version} no longer lists options Starwright passes it: ${missing.join(', ')}.`)
  // A live run only if the basics hold (otherwise it would just fail the same way, and cost a run).
  if (!problems.length) problems.push(...(await deps.tryRuns(tool).catch((err: Error) => [`The test run didn't finish: ${err.message}`])))
  return problems
}

// ---- running an update ----

/** Waits until none of the tool's processes is running; false if that took too long. */
async function waitIdle(tool: UpdatableTool, deps: UpdateDeps, onWait: (n: number) => void): Promise<boolean> {
  deps.stopIdle(tool)
  const started = deps.now().getTime()
  for (;;) {
    const n = deps.busy(tool)
    if (n === 0) return true
    if (deps.now().getTime() - started > WAIT_LIMIT_MS) return false
    onWait(n)
    await deps.sleep(2_000)
  }
}

function at(deps: UpdateDeps): string {
  return deps.now().toISOString()
}

/** Installs one version and says whether it took (npm's words if not). */
async function install(tool: UpdatableTool, version: string, deps: UpdateDeps): Promise<string | undefined> {
  setToolGate(tool, 'install', `${NAMES[tool]} is being updated. Try again in a minute.`)
  try {
    await deps.install(TOOL_PACKAGES[tool], version)
    return undefined
  } catch (err) {
    return (err as Error).message || 'npm failed'
  } finally {
    setToolGate(tool, 'hold', `${NAMES[tool]} is being checked after its update.`)
  }
}

/** Checks the version now installed and settles the update: done (tool free again) or failed (held back). */
async function settle(tool: UpdatableTool, base: ToolUpdateState, deps: UpdateDeps): Promise<ToolUpdateState> {
  set(tool, { ...base, phase: 'checking', at: at(deps), message: `Checking ${NAMES[tool]} ${base.to} works with Starwright…`, problems: undefined })
  const problems = await checkUpdatedTool(tool, base.to, deps)
  if (problems.length) {
    const failed: ToolUpdateState = { ...base, phase: 'failed', at: at(deps), message: undefined, problems }
    setToolGate(tool, 'hold', heldReason(tool, failed))
    return set(tool, failed)!
  }
  clearToolGate(tool)
  deps.refresh()
  return set(tool, { ...base, phase: 'done', at: at(deps), problems: undefined, message: `${NAMES[tool]} is updated${base.from ? ` from ${base.from}` : ''} to ${base.to} and passed Starwright's check.` })!
}

/**
 * Updates the tool to `version` and checks it. Never throws: the result (and every step on the
 * way, through vibe:tools:changed) says what happened.
 */
export async function updateTool(tool: UpdatableTool, version: string, deps: UpdateDeps = defaultDeps()): Promise<ToolUpdateState> {
  const name = NAMES[tool]
  const error = (message: string, from?: string): ToolUpdateState => set(tool, { phase: 'error', from, to: version, at: at(deps), message })!
  if (!(tool in NAMES) || !VERSION.test(version)) return error(`That isn't a ${name ?? 'tool'} version Starwright can install.`)
  if (active) return error(`${NAMES[active]} is being updated now: one at a time.`)
  active = tool
  try {
    const from = await deps.installed(tool).catch(() => undefined)
    const viaNpm = await deps.npmVersion(TOOL_PACKAGES[tool]).catch(() => undefined)
    if (!from) return error(`${name} isn't installed here.`)
    if (!viaNpm || viaNpm !== from) {
      return error(`${name} ${from} wasn't installed with npm (or another copy comes first on the PATH), so update it the way it was installed.`, from)
    }
    if (from === version) return error(`${name} ${version} is already installed.`, from)

    const base: ToolUpdateState = { phase: 'waiting', from, to: version, at: at(deps) }
    setToolGate(tool, 'drain', `${name} is being updated.`)
    set(tool, { ...base, message: `Getting ready to update ${name}…` })
    const idle = await waitIdle(tool, deps, (n) =>
      set(tool, { ...base, message: `Waiting for ${n === 1 ? 'a' : n} ${name} run${n === 1 ? '' : 's'} to finish (new work goes to the other agents meanwhile)…` })
    )
    if (!idle) {
      clearToolGate(tool)
      return error(`${name} was still busy after 15 minutes, so it wasn't updated. Nothing changed.`, from)
    }

    // npm stopping part-way through a locked file can leave a broken install: don't start.
    const others = await deps.othersRunning(tool).catch(() => 0)
    if (others) {
      clearToolGate(tool)
      return error(`${name} is running outside Starwright (${others === 1 ? 'a copy' : `${others} copies`}: in a terminal, an editor, or left over; Task Manager shows ${tool}.exe), and Windows can't replace it while it runs. Close it, then press Update again. Nothing changed.`, from)
    }

    set(tool, { ...base, phase: 'installing', at: at(deps), message: `Installing ${name} ${version}…` })
    const failed = await install(tool, version, deps)
    if (failed) {
      // npm can stop part-way: what's there now decides whether anything changed.
      const now = await deps.installed(tool).catch(() => undefined)
      if (now === from) {
        clearToolGate(tool)
        return error(`npm couldn't install ${name} ${version}: ${failed} Nothing changed.`, from)
      }
      const broken: ToolUpdateState = { ...base, phase: 'failed', at: at(deps), problems: [`npm couldn't install ${name} ${version}: ${failed}`] }
      setToolGate(tool, 'hold', heldReason(tool, broken))
      return set(tool, broken)!
    }
    return await settle(tool, base, deps)
  } catch (err) {
    clearToolGate(tool)
    return error(`The update stopped: ${(err as Error).message}`)
  } finally {
    active = undefined
  }
}

/** Puts back the version from before the update (it then passes or fails the same check). */
export async function rollBackTool(tool: UpdatableTool, deps: UpdateDeps = defaultDeps()): Promise<ToolUpdateState | undefined> {
  const s = updates[tool]
  if (!s?.from || !VERSION.test(s.from) || active || UPDATE_RUNNING.includes(s.phase)) return s
  active = tool
  const name = NAMES[tool]
  const from = s.from
  const bad = s.to
  try {
    const base: ToolUpdateState = { phase: 'rolling-back', from, to: bad, at: at(deps), problems: s.problems }
    setToolGate(tool, 'drain', `${name} is being put back to ${from}.`)
    set(tool, { ...base, message: `Putting ${name} ${from} back…` })
    if (!(await waitIdle(tool, deps, () => undefined))) {
      setToolGate(tool, 'hold', heldReason(tool, s))
      return set(tool, { ...s, message: `${name} was still busy after 15 minutes, so ${from} wasn't put back.` })
    }
    if (await deps.othersRunning(tool).catch(() => 0)) {
      setToolGate(tool, 'hold', heldReason(tool, s))
      return set(tool, { ...s, message: `${name} is running outside Starwright (Task Manager shows ${tool}.exe): close it, then put ${from} back.` })
    }
    const failed = await install(tool, from, deps)
    const now = await deps.installed(tool).catch(() => undefined)
    if (failed || now !== from) {
      setToolGate(tool, 'hold', heldReason(tool, s))
      return set(tool, { ...s, phase: 'failed', at: at(deps), message: `${from} couldn't be put back: ${failed ?? `Starwright finds ${now ?? 'nothing'}`}. In a terminal: npm i -g ${TOOL_PACKAGES[tool]}@${from}` })
    }
    clearToolGate(tool)
    deps.skip(tool, bad)
    deps.refresh()
    return set(tool, { phase: 'rolled-back', from, to: bad, at: at(deps), message: `${name} is back to ${from}. ${bad} is skipped in the new-version notice.` })
  } finally {
    active = undefined
  }
}

/** Keeps the new version though it failed the check: the user's call (the problem may be their plan, not the update). */
export function keepTool(tool: UpdatableTool): ToolUpdateState | undefined {
  const s = updates[tool]
  if (!s || s.phase !== 'failed') return s
  clearToolGate(tool)
  return set(tool, { ...s, phase: 'kept', at: new Date().toISOString(), message: `Keeping ${NAMES[tool]} ${s.to}. It's given work again.` })
}

/** Runs the check again (after fixing a sign-in, say). */
export async function recheckTool(tool: UpdatableTool, deps: UpdateDeps = defaultDeps()): Promise<ToolUpdateState | undefined> {
  const s = updates[tool]
  if (!s || s.phase !== 'failed' || active) return s
  active = tool
  try {
    setToolGate(tool, 'hold', `${NAMES[tool]} is being checked after its update.`)
    return await settle(tool, { phase: 'checking', from: s.from, to: s.to, at: at(deps) }, deps)
  } finally {
    active = undefined
  }
}

/** Forgets a finished update's message (not one under way, or a failed one still waiting on the user). */
export function dismissToolUpdate(tool: UpdatableTool): void {
  const s = updates[tool]
  if (s && !UPDATE_RUNNING.includes(s.phase) && s.phase !== 'failed') set(tool, undefined)
}

/**
 * The Update button: checks it's the version the notice offered (so nothing else can be asked
 * for, from a Remote screen say), then runs the update in the background.
 */
export function startToolUpdate(tool: string, version: string): ToolUpdateState | undefined {
  if (tool !== 'codex' && tool !== 'cline') throw new Error('Only Codex and Cline can be updated from Starwright.')
  const row = toolVersions().tools.find((t) => t.tool === tool)
  if (!row?.latest || row.latest !== version) throw new Error(`${NAMES[tool]} ${version} isn't the newest version Starwright found.`)
  if (active) throw new Error(`${NAMES[active]} is being updated now: one at a time.`)
  void updateTool(tool, version, defaultDeps())
  return updates[tool]
}

// ---- the real thing ----

const execFileAsync = promisify(execFile)

/** npm's own error lines, short. */
export function npmProblem(err: ExecCliError): string {
  const text = `${err.stderr ?? ''}\n${err.stdout ?? ''}`
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^npm (error|ERR!)/i.test(l) && !/A complete log of this run|^npm (error|ERR!)\s*$/i.test(l))
    .map((l) => l.replace(/^npm (error|ERR!)\s*/i, ''))
  const said = (lines.length ? lines.slice(0, 3).join(' ') : err.message).replace(/\s+/g, ' ').trim()
  return said.length > 300 ? `${said.slice(0, 297)}…` : said
}

const READY = 'Reply with the single word READY and nothing else. Do not run any commands or use any other tools.'

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 80 ? `${t.slice(0, 77)}…` : t || '(nothing)'
}

/** Deletes a check's folder; a Cline that's still letting go of it gets a few seconds. */
async function removeDir(dir: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
}

async function codexRun(): Promise<string[]> {
  const cwd = mkdtempSync(join(tmpdir(), 'vibeapp-codex-check-'))
  try {
    const r = await runCodexExec({ prompt: READY, cwd, readOnly: true, ephemeral: true, timeoutMs: 180_000, updateCheck: true })
    const failure = codexFailure(r)
    if (r.exitCode !== 0 || failure) return [`A short Codex run through Starwright's safety check failed: ${failure ?? `it ended with code ${r.exitCode}`}.`]
    if (!/\bREADY\b/i.test(r.finalMessage)) return [`A short Codex run answered "${clip(r.finalMessage)}" instead of READY.`]
    return []
  } catch (err) {
    return [`A short Codex run failed: ${(err as Error).message}`]
  } finally {
    await removeDir(cwd)
  }
}

async function clineRuns(): Promise<string[]> {
  const problems: string[] = []
  const runs: { label: string; mode: 'helper' | 'build'; system?: string }[] = [
    // Background jobs: a one-off run with Starwright's system prompt.
    { label: 'A one-off Cline run (as background jobs use)', mode: 'helper', system: 'You are a connection check. Reply with exactly the word asked for.' },
    // Hand-offs: the Cline Starwright keeps running (ACP), when it's on ClinePass.
    { label: 'A hosted Cline run (as hand-offs use)', mode: 'build' }
  ]
  for (const run of runs) {
    const cwd = mkdtempSync(join(tmpdir(), 'vibeapp-cline-check-'))
    try {
      const r = await runCline({ prompt: READY, mode: run.mode, system: run.system, cwd, thinking: 'none', timeoutMs: 180_000, updateCheck: true })
      // The 3.0.75 kind of break: the hook refused something Cline now does on every run.
      if (r.blocked.length) problems.push(`${run.label}: Starwright's safety hook refused ${r.blocked.join('; ')}.`)
      else if (!r.ok) problems.push(`${run.label} failed: ${r.error ?? r.finishReason}.`)
      else if (!/\bREADY\b/i.test(r.text)) problems.push(`${run.label} answered "${clip(r.text)}" instead of READY.`)
    } catch (err) {
      problems.push(`${run.label} failed: ${(err as Error).message}`)
    } finally {
      // The hosted Cline keeps running in its folder: it's only for this check.
      if (run.mode === 'build') stopIdleHostedCline()
      await removeDir(cwd)
    }
  }
  return problems
}

async function helpText(tool: UpdatableTool): Promise<{ text: string; problems: string[] }> {
  const out = (r: { stdout: string; stderr: string }): string => `${r.stdout}\n${r.stderr}`
  if (tool === 'codex') {
    const text = out(await execCli('codex', ['exec', '--help'], { timeout: 30_000 }))
    const problems: string[] = []
    // Hand-offs carry on Codex's session (resume); the plan's usage comes from app-server.
    for (const [args, what] of [
      [['exec', 'resume', '--help'], 'codex exec resume (Starwright carries on a hand-off with it)'],
      [['app-server', '--help'], 'codex app-server (Starwright reads the Codex plan usage with it)']
    ] as const) {
      await execCli('codex', [...args], { timeout: 30_000 }).catch(() => problems.push(`${what} is gone.`))
    }
    return { text, problems }
  }
  const launch = await resolveClineLaunch(true)
  if (!launch) return { text: '', problems: ["Starwright can't find Cline after the update."] }
  const r = await execFileAsync(launch.file, [...launch.prefixArgs, '--help'], {
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, ...launch.env }
  })
  return { text: out(r), problems: [] }
}

/** npm install -g pkg@version, as the user would in a terminal; throws with npm's own words. */
export async function npmInstallGlobal(pkg: string, version: string): Promise<void> {
  if (!VERSION.test(version) || !Object.values(TOOL_PACKAGES).includes(pkg)) throw new Error('Not a package and version Starwright installs.')
  try {
    await execCli('npm', ['install', '-g', `${pkg}@${version}`, '--no-fund', '--no-audit'], { timeout: INSTALL_TIMEOUT_MS })
  } catch (err) {
    throw new Error(npmProblem(err as ExecCliError))
  }
}

/**
 * Copies of the tool's program running that Starwright didn't start (it has stopped its own by
 * now). Windows only: elsewhere a running program can be replaced.
 */
async function othersRunning(tool: UpdatableTool): Promise<number> {
  if (process.platform !== 'win32') return 0
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Get-Process -Name ${tool} -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }`],
    { timeout: 20_000, windowsHide: true }
  )
  const root = (await npmGlobalRoot().catch(() => undefined))?.toLowerCase()
  const paths = stdout.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean)
  // Only copies of the npm install count (another install of the tool isn't being replaced).
  return root ? paths.filter((p) => p.startsWith(root)).length : paths.length
}

const realDeps: UpdateDeps = {
  installed: (tool) => installedVersion(tool),
  npmVersion: npmGlobalVersion,
  install: npmInstallGlobal,
  help: helpText,
  tryRuns: (tool) => (tool === 'codex' ? codexRun() : clineRuns()),
  busy: (tool) => toolProcessCount(tool),
  othersRunning,
  stopIdle: (tool) => {
    if (tool === 'cline') stopIdleHostedCline()
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
  skip: (tool, version) => {
    notifyScreens('vibe:settings:changed', updateSettings({ skippedToolVersions: { ...getSettings().skippedToolVersions, [tool]: version } }))
  },
  refresh: () => void checkToolVersions().catch(() => undefined)
}

/** The check on the version installed now, for real (the smoke tests). */
export function checkToolNow(tool: UpdatableTool, version: string): Promise<string[]> {
  return checkUpdatedTool(tool, version, realDeps)
}

/**
 * The app tests' switch: test-tool-update.json in the data folder ({ installed: { codex: '0.158.0' },
 * fail: [problems the new version's check finds] }) stands in for npm and the tools, so the
 * screens can be driven through an update without installing anything.
 */
function testDeps(): UpdateDeps | undefined {
  if (process.env.VIBEAPP_TEST_HOOKS !== '1') return undefined
  let script: { installed?: Partial<Record<UpdatableTool, string>>; fail?: string[] }
  try {
    script = JSON.parse(readFileSync(join(app.getPath('userData'), 'test-tool-update.json'), 'utf8'))
  } catch {
    return undefined
  }
  const first = { ...script.installed }
  const now = { ...script.installed }
  const toolOf = (pkg: string): UpdatableTool => (pkg === TOOL_PACKAGES.cline ? 'cline' : 'codex')
  const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 700))
  return {
    ...realDeps,
    installed: async (tool) => now[tool],
    npmVersion: async (pkg) => now[toolOf(pkg)],
    install: async (pkg, version) => {
      await pause()
      now[toolOf(pkg)] = version
    },
    help: async (tool) => ({ text: REQUIRED_FLAGS[tool].join(' '), problems: [] }),
    tryRuns: async (tool) => {
      await pause()
      return now[tool] === first[tool] ? [] : (script.fail ?? [])
    },
    busy: () => 0,
    othersRunning: async () => 0,
    stopIdle: () => undefined
  }
}

function defaultDeps(): UpdateDeps {
  return testDeps() ?? realDeps
}
