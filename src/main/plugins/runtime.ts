import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { VibeEvent } from '@shared/types'
import { nextRun } from '@shared/schedule'
import { describePluginWhen, PLUGIN_EVENTS, type PluginCommand, type PluginEvent, type PluginEventName, type PluginRun } from '@shared/plugins'
import { listProjects, getProject } from '../projects/store'
import { getSettings } from '../settings/store'
import { maskProjectSecrets } from '../secrets/vault'
import { killTree, trackChild } from '../cli/codexExec'
import { approvedCopy, findPlugins, openPanelsOf, pluginsPaused, readyPlugin, setPluginOff, setRunInfo, type ReadyPlugin } from './registry'

// Runs plugins' commands: when you press one of their buttons, when their panel asks, when
// something they listen for happens in the project (a request, a hand-off or a Deploy finishing),
// and on their schedules. A command is a program run on this computer as you, from the project's
// folder: only commands of an approved plugin that's on, exactly as plugin.json had them when you
// approved it, with the plugin's own scripts from the copy of its files you approved.
//
// What a command prints is kept with its run (the last of it, secrets masked). A few lines mean
// something to Starwright: "::status <text>" is what the run says in a line, "::note <text>" adds a
// line to the project's chat, "::notify <text>" sends you an alert (with the notify permission), and
// "::json <json>" hands data to the plugin's panel. A plugin whose runs from events or schedules
// fail 3 times in a row is turned off, saying why.

export interface PluginRuntimeDeps {
  /** Adds a line to the project's chat. */
  chatEvent: (projectId: string, event: VibeEvent) => void
  notify: (title: string, body: string) => void
  /** Sends an event to Starwright's screens (the desktop window and Remote). */
  send: (channel: string, ...args: unknown[]) => void
}

let deps: PluginRuntimeDeps | undefined

/** Runs kept for each plugin in each project. */
const KEEP_RUNS = 30
/** What's kept of a run's output. */
const OUTPUT_KEEP = 8000
/** The data a run hands its panel ("::json"). */
const MAX_RESULT = 200_000
/** Runs from events waiting behind a running one, for each plugin. */
const MAX_QUEUED = 3
/** Failed runs in a row (from events and schedules) that turn a plugin off. */
export const FAILS_TO_TURN_OFF = 3
/** A missed daily time is run late within this, and skipped after. */
const LATE_GRACE_MS = 3 * 60 * 60 * 1000
const TICK_MS = 60_000
/** A plugin for every project runs its schedules in projects opened this recently. */
export const RECENT_PROJECT_MS = 14 * 24 * 60 * 60 * 1000

const key2 = (projectId: string, key: string): string => `${projectId}\n${key}`

// ---- runs kept --------------------------------------------------------------------------------

function runsFile(projectId: string, key: string): string {
  const id = createHash('sha256').update(key2(projectId, key)).digest('hex').slice(0, 32)
  return join(app.getPath('userData'), 'plugin-runs', `${id}.json`)
}

export function pluginRuns(projectId: string, key: string): PluginRun[] {
  try {
    const list = JSON.parse(readFileSync(runsFile(projectId, key), 'utf-8')) as unknown
    return Array.isArray(list) ? (list as PluginRun[]) : []
  } catch {
    return []
  }
}

function keepRun(projectId: string, key: string, run: PluginRun): void {
  const file = runsFile(projectId, key)
  mkdirSync(join(file, '..'), { recursive: true })
  const list = [run, ...pluginRuns(projectId, key)].slice(0, KEEP_RUNS)
  writeFileSync(`${file}.tmp`, JSON.stringify(list))
  renameSync(`${file}.tmp`, file)
}

const running = new Map<string, { command: string; child?: ChildProcess }>()
const queues = new Map<string, (() => Promise<void>)[]>()

setRunInfo((projectId, key) => ({ lastRun: pluginRuns(projectId, key)[0], running: running.get(key2(projectId, key))?.command }))

/** A plugin's own folder for each project ({data}): what its commands keep between runs. */
export function pluginDataFolder(projectId: string, key: string): string {
  const id = createHash('sha256').update(key2(projectId, key)).digest('hex').slice(0, 32)
  return join(app.getPath('userData'), 'plugin-data', id)
}

// ---- running a command ------------------------------------------------------------------------

/** Quotes a path for the shell a text command runs in. */
function shellQuote(value: string): string {
  return process.platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`
}

/** cmd.exe's quoting, for a list command on Windows (so npm, git and the like are found). */
const cmdQuote = (arg: string): string => `"${arg.replace(/"/g, '""')}"`

interface Spawned {
  child: ChildProcess
}

function start(command: PluginCommand, places: Record<string, string>, env: NodeJS.ProcessEnv, cwd: string): Spawned {
  const fill = (text: string, quote: (v: string) => string = (v) => v): string => text.replace(/\{(plugin|project|data)\}/g, (_, name: string) => quote(places[name]))
  const options = { cwd, env, windowsHide: true }
  if (typeof command.run === 'string') {
    const line = fill(command.run, shellQuote)
    return { child: process.platform === 'win32' ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', line], options) : spawn('sh', ['-c', line], options) }
  }
  const [program, ...args] = command.run.map((a) => fill(a))
  // "node" is Starwright's own, so a plugin's scripts run without Node installed.
  if (program === 'node') return { child: spawn(process.execPath, args, { ...options, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }) }
  if (process.platform === 'win32') {
    return { child: spawn('cmd.exe', ['/d', '/s', '/c', `"${[program, ...args].map(cmdQuote).join(' ')}"`], { ...options, windowsVerbatimArguments: true }) }
  }
  return { child: spawn(program, args, options) }
}

interface RunOptions {
  trigger: string
  /** For STARWRIGHT_EVENT: what happened. */
  event?: PluginEvent
  /** For STARWRIGHT_INPUT: what the panel passed. */
  input?: unknown
}

/** Runs one command of a ready plugin and keeps the run. Never throws: a failure is a failed run. */
async function execute(projectId: string, plugin: ReadyPlugin, command: PluginCommand, options: RunOptions): Promise<PluginRun> {
  const project = getProject(projectId)
  const at = new Date().toISOString()
  const began = Date.now()
  const k = key2(projectId, plugin.info.key)
  const title = plugin.info.manifest.title
  const done = (run: Omit<PluginRun, 'at' | 'command' | 'trigger' | 'seconds'>): PluginRun => {
    const full: PluginRun = { at, command: command.id, trigger: options.trigger, seconds: Math.round((Date.now() - began) / 100) / 10, ...run }
    keepRun(projectId, plugin.info.key, full)
    return full
  }
  if (!project || !existsSync(project.path)) return done({ ok: false, exitCode: null, output: "The project's folder isn't on this computer." })

  running.set(k, { command: command.id })
  deps?.send('vibe:plugins:changed', projectId)
  try {
    const places = { plugin: approvedCopy(plugin), project: project.path, data: pluginDataFolder(projectId, plugin.info.key) }
    mkdirSync(places.data, { recursive: true })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      STARWRIGHT_PROJECT: project.path,
      STARWRIGHT_PROJECT_NAME: project.name,
      STARWRIGHT_PLUGIN_DIR: places.plugin,
      STARWRIGHT_DATA_DIR: places.data,
      STARWRIGHT_TRIGGER: options.trigger,
      STARWRIGHT_EVENT: options.event ? JSON.stringify(options.event) : '',
      STARWRIGHT_INPUT: options.input === undefined ? '' : JSON.stringify(options.input)
    }
    delete env.ELECTRON_RUN_AS_NODE

    const { child } = start(command, places, env, project.path)
    trackChild(child)
    running.set(k, { command: command.id, child })
    let output = ''
    let pending = ''
    let status: string | undefined
    let result: unknown
    const notes: string[] = []
    const alerts: string[] = []
    const line = (text: string): void => {
      const m = /^::(status|note|notify|json)\s(.*)$/.exec(text.replace(/\r$/, ''))
      if (!m) return
      const value = m[2].trim()
      if (m[1] === 'status') status = value.slice(0, 300)
      else if (m[1] === 'note' && notes.length < 5) notes.push(value.slice(0, 500))
      else if (m[1] === 'notify' && alerts.length < 3) alerts.push(value.slice(0, 300))
      else if (m[1] === 'json' && value.length <= MAX_RESULT) {
        try {
          result = JSON.parse(value)
        } catch {
          output += '\n(Starwright: a "::json" line wasn\'t valid JSON)\n'
        }
      }
    }
    const add = (chunk: Buffer): void => {
      const text = chunk.toString('utf-8')
      output = (output + text).slice(-OUTPUT_KEEP * 2)
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      if (pending.length > MAX_RESULT + 100) pending = ''
      for (const l of lines) line(l)
    }
    child.stdout?.on('data', add)
    child.stderr?.on('data', add)
    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        output += `\n(Starwright stopped it after ${command.timeout} seconds)\n`
        killTree(child)
      }, command.timeout * 1000)
      child.on('error', (err) => {
        clearTimeout(timer)
        output += `\n${err.message}`
        resolve(null)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    if (pending) line(pending)
    // The "::" lines are for Starwright; what's kept is the rest.
    const kept = maskProjectSecrets(projectId, output.replace(/^::(status|note|notify|json)\s.*$\n?/gm, '').trim().slice(-OUTPUT_KEEP))
    const ok = exitCode === 0
    for (const note of notes) deps?.chatEvent(projectId, { type: 'note', text: `🧩 ${title}: ${maskProjectSecrets(projectId, note)}` })
    if (alerts.length) {
      if (plugin.info.manifest.permissions.includes('notify')) for (const a of alerts) deps?.notify(`${project.name}: 🧩 ${title}`, maskProjectSecrets(projectId, a))
      else console.warn(`Plugin ${plugin.info.name} printed ::notify without the notify permission`)
    }
    return done({ ok, exitCode, output: kept, ...(status ? { status: maskProjectSecrets(projectId, status) } : {}), ...(result !== undefined ? { result } : {}) })
  } catch (err) {
    return done({ ok: false, exitCode: null, output: (err as Error).message })
  } finally {
    running.delete(k)
    deps?.send('vibe:plugins:changed', projectId)
  }
}

const describe = (run: PluginRun, command: PluginCommand): string =>
  run.ok
    ? `${command.title} finished in ${run.seconds} s${run.status ? `: ${run.status}` : '.'}`
    : `${command.title} failed${run.exitCode !== null ? ` (exit code ${run.exitCode})` : ''}${run.status ? `: ${run.status}` : run.output ? `: ${run.output.split('\n').filter(Boolean).at(-1)?.slice(0, 200)}` : '.'}`

/**
 * Runs a command you asked for: a button, its panel, or an agent. Waits for it and says how it
 * went in the chat. Throws when it can't run (not approved, already running).
 */
export async function runPluginCommand(projectId: string, key: string, commandId: string, trigger: 'button' | 'panel', input?: unknown): Promise<PluginRun> {
  const plugin = readyPlugin(projectId, key)
  const command = plugin.info.manifest.commands.find((c) => c.id === commandId)
  if (!command) throw new Error(`${plugin.info.manifest.title} has no command "${String(commandId).slice(0, 40)}".`)
  if (running.has(key2(projectId, key))) throw new Error(`${plugin.info.manifest.title} is already running ${running.get(key2(projectId, key))!.command}: wait for it to finish.`)
  if (input !== undefined && JSON.stringify(input).length > 100_000) throw new Error('That input is too big (100 KB at most).')
  const run = await execute(projectId, plugin, command, { trigger, input })
  if (trigger === 'button') deps?.chatEvent(projectId, { type: 'note', text: `🧩 ${plugin.info.manifest.title} · ${describe(run, command)}` })
  return run
}

/** Stops a plugin's running command. */
export function stopPluginCommand(projectId: string, key: string): boolean {
  const r = running.get(key2(projectId, key))
  if (!r?.child) return false
  killTree(r.child)
  return true
}

/** Runs from events and schedules: one at a time for each plugin, a few waiting at most. */
function inBackground(projectId: string, plugin: ReadyPlugin, command: PluginCommand, options: RunOptions): void {
  const k = key2(projectId, plugin.info.key)
  const queue = queues.get(k) ?? []
  if (queue.length >= MAX_QUEUED) return
  queue.push(async () => {
    // Approved and on still? It may have changed, been turned off, or plugins paused, meanwhile.
    let ready: ReadyPlugin
    try {
      ready = readyPlugin(projectId, plugin.info.key)
    } catch {
      return
    }
    if (ready.info.hash !== plugin.info.hash) return
    const run = await execute(projectId, ready, command, options)
    afterBackgroundRun(projectId, ready, command, run)
  })
  queues.set(k, queue)
  if (!draining.has(k)) void drain(k)
}

const draining = new Set<string>()

async function drain(k: string): Promise<void> {
  draining.add(k)
  try {
    const queue = queues.get(k)
    while (queue?.length) {
      // A run you started (a button, its panel) goes first.
      while (running.has(k)) await new Promise((r) => setTimeout(r, 250))
      try {
        await queue[0]()
      } catch (err) {
        console.warn('A plugin run failed:', (err as Error).message)
      }
      queue.shift()
    }
  } finally {
    queues.delete(k)
    draining.delete(k)
  }
}

/** Waits for a plugin's runs from events to finish (for tests). */
export async function pluginRunsSettled(): Promise<void> {
  while (queues.size || running.size) await new Promise((r) => setTimeout(r, 20))
}

function afterBackgroundRun(projectId: string, plugin: ReadyPlugin, command: PluginCommand, run: PluginRun): void {
  const title = plugin.info.manifest.title
  if (run.ok) return
  const background = pluginRuns(projectId, plugin.info.key).filter((r) => r.trigger.startsWith('hook:') || r.trigger.startsWith('schedule:'))
  const inARow = background.findIndex((r) => r.ok)
  const fails = inARow === -1 ? background.length : inARow
  if (fails >= FAILS_TO_TURN_OFF) {
    const reason = `its last ${FAILS_TO_TURN_OFF} runs from events or schedules failed; the last: ${describe(run, command)}`
    try {
      setPluginOff(projectId, plugin.info.key, true, reason)
    } catch {
      return
    }
    deps?.chatEvent(projectId, { type: 'note', text: `🧩 Turned ${title} off: ${reason} Turn it on again in Plugins once it's fixed.` })
    deps?.notify(`${getProject(projectId)?.name ?? 'A project'}: 🧩 ${title} turned off`, `Its last ${FAILS_TO_TURN_OFF} runs failed.`)
    deps?.send('vibe:plugins:changed', projectId)
  } else {
    deps?.chatEvent(projectId, { type: 'note', text: `🧩 ${title} · ${describe(run, command)}` })
  }
}

// ---- events -----------------------------------------------------------------------------------

/**
 * Something happened in a project: its plugins' hooks for it run, and its open panels that may
 * read the project's records hear about it.
 */
export function pluginEvent(projectId: string, type: PluginEventName, fields: Record<string, unknown>): void {
  if (pluginsPaused() || !getProject(projectId)) return
  const event: PluginEvent = { type, at: new Date().toISOString(), ...fields }
  for (const panel of openPanelsOf(projectId)) {
    if (panel.permissions.has('records:read')) deps?.send('vibe:plugins:event', panel.token, event)
  }
  let found
  try {
    found = findPlugins(projectId)
  } catch {
    return
  }
  for (const f of found) {
    if (f.info.status !== 'approved' || !f.info.manifest?.hooks.some((h) => h.on === type) || !f.files) continue
    const plugin = f as ReadyPlugin
    for (const hook of plugin.info.manifest.hooks.filter((h) => h.on === type)) {
      const command = plugin.info.manifest.commands.find((c) => c.id === hook.command)
      if (command) inBackground(projectId, plugin, command, { trigger: `hook:${type}`, event })
    }
  }
}

export const describeEvent = (type: PluginEventName): string => PLUGIN_EVENTS[type]

// ---- schedules --------------------------------------------------------------------------------

interface ScheduleState {
  /** By "<projectId>\n<key>\n<schedule id>\n<when>": when it's next due. */
  next: Record<string, string>
}

const stateFile = (): string => join(app.getPath('userData'), 'plugin-schedules.json')

function readState(): ScheduleState {
  try {
    const s = JSON.parse(readFileSync(stateFile(), 'utf-8')) as ScheduleState
    return s && typeof s.next === 'object' ? s : { next: {} }
  } catch {
    return { next: {} }
  }
}

function writeState(state: ScheduleState): void {
  mkdirSync(join(stateFile(), '..'), { recursive: true })
  writeFileSync(`${stateFile()}.tmp`, JSON.stringify(state))
  renameSync(`${stateFile()}.tmp`, stateFile())
}

/** When each of a project's plugin schedules is next due (for the Plugins pane). */
export function pluginScheduleTimes(projectId: string): Record<string, string> {
  const prefix = `${projectId}\n`
  const out: Record<string, string> = {}
  for (const [k, at] of Object.entries(readState().next)) if (k.startsWith(prefix)) out[k.slice(prefix.length).split('\n').slice(0, 2).join('/')] = at
  return out
}

/** Checks every project's plugin schedules once: runs what's due. */
export function tickPluginSchedules(now = new Date()): void {
  if (pluginsPaused()) return
  const state = readState()
  const seen = new Set<string>()
  const paused = getSettings().schedulesPaused
  for (const project of listProjects()) {
    if (!existsSync(project.path)) continue
    let found
    try {
      found = findPlugins(project.id)
    } catch {
      continue
    }
    // A plugin for every project runs its schedules only in projects in use: opened in the last two weeks.
    const recent = now.getTime() - Date.parse(project.lastOpened) < RECENT_PROJECT_MS
    for (const f of found.filter((x) => (x.info.scope === 'project' || recent) && x.info.status === 'approved' && x.files && x.info.manifest?.schedules.length)) {
      const plugin = f as ReadyPlugin
      for (const s of plugin.info.manifest.schedules) {
        const k = `${project.id}\n${plugin.info.key}\n${s.id}\n${JSON.stringify(s.when)}`
        seen.add(k)
        const due = state.next[k] ? Date.parse(state.next[k]) : NaN
        if (Number.isNaN(due)) {
          state.next[k] = nextRun(s.when, now)!.toISOString()
          continue
        }
        if (due > now.getTime()) continue
        state.next[k] = nextRun(s.when, now)!.toISOString()
        // Paused schedules, or a daily time missed by hours: nothing is made up for.
        if (paused || (s.when.kind === 'daily' && now.getTime() - due > LATE_GRACE_MS)) continue
        const command = plugin.info.manifest.commands.find((c) => c.id === s.command)
        if (command) inBackground(project.id, plugin, command, { trigger: `schedule:${s.id}`, event: undefined })
      }
    }
  }
  for (const k of Object.keys(state.next)) if (!seen.has(k)) delete state.next[k]
  writeState(state)
}

export const describeSchedule = describePluginWhen

let timer: NodeJS.Timeout | undefined

export function startPluginRuntime(d: PluginRuntimeDeps): void {
  deps = d
  if (timer) return
  const every = process.env.VIBEAPP_PLUGIN_TICK_MS ? Number(process.env.VIBEAPP_PLUGIN_TICK_MS) : TICK_MS
  timer = setInterval(() => {
    try {
      tickPluginSchedules()
    } catch (err) {
      console.warn('Checking plugin schedules failed:', (err as Error).message)
    }
  }, every)
  timer.unref()
}

/** For tests: where events and chat lines go. */
export function setPluginRuntimeDeps(d: PluginRuntimeDeps | undefined): void {
  deps = d
}

/** An alert from a plugin's panel (it has the notify permission). */
export function pluginNotify(projectId: string, title: string, text: string): void {
  deps?.notify(`${getProject(projectId)?.name ?? 'A project'}: 🧩 ${title}`, maskProjectSecrets(projectId, text))
}
