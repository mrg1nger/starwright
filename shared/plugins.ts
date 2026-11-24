// Plugins: small add-ons that give Starwright things it doesn't have, written by you, Claude or
// Codex. A plugin is a folder with a plugin.json (this file checks it) and the files it names:
// panels (pages shown beside the chat, in a locked-down frame) and commands (programs run on this
// computer when you press a button, when something happens, or on a schedule). Nothing runs until
// you approve it, and what you approve is exactly what you saw. See docs/plugins.md.

/** What a plugin may ask for, in the words the approval screen uses. */
export const PLUGIN_PERMISSIONS = {
  'files:read': "Read this project's files (not files that usually hold passwords or keys, and nothing outside the project)",
  storage: 'Keep its own small store of data (up to 1 MB for each project)',
  'records:read': "Read Starwright's records for this project: your requests and how they went, tokens used, hand-offs to other agents, and scheduled runs",
  commands: 'Run programs on this computer, as you, from the project\'s folder: only the commands listed below, exactly as written',
  notify: 'Show you alerts (on this computer, and on your phone if phone alerts are on)',
  'chat:draft': "Put text in the chat's message box (you still choose whether to send it)"
} as const

export type PluginPermission = keyof typeof PLUGIN_PERMISSIONS

export interface PluginPanel {
  /** Short id, unique in the plugin. */
  id: string
  title: string
  /** The page, a path inside the plugin's folder ("panel.html"). */
  entry: string
}

/**
 * A program the plugin runs. `run` as a list is the program and its arguments, run without a
 * shell ("node" is Starwright's own Node); as text it's a command line for the shell (PowerShell
 * on Windows, sh elsewhere). {plugin} is the plugin's approved files, {project} the project's
 * folder and {data} a folder of the plugin's own.
 */
export interface PluginCommand {
  id: string
  title: string
  run: string | string[]
  /** Seconds before it's stopped (default 120, at most 3600). */
  timeout: number
}

/** A button in the Plugins pane that runs one of the plugin's commands. */
export interface PluginButton {
  title: string
  command: string
}

export const PLUGIN_EVENTS = {
  'request-end': 'When a request in the chat finishes',
  'files-changed': 'When a request changed files',
  'handoff-end': 'When a hand-off to another agent finishes',
  'deploy-end': 'When a Deploy finishes'
} as const

export type PluginEventName = keyof typeof PLUGIN_EVENTS

/** Runs a command when something happens in the project. */
export interface PluginHook {
  on: PluginEventName
  command: string
}

export type PluginWhen = { kind: 'daily'; time: string; days: number[] } | { kind: 'every'; minutes: number }

/** Runs a command at set times, while Starwright is running. */
export interface PluginSchedule {
  id: string
  command: string
  when: PluginWhen
}

export interface PluginManifest {
  /** The folder's name: lower case, digits and dashes. */
  name: string
  title: string
  version: string
  description: string
  permissions: PluginPermission[]
  panels: PluginPanel[]
  commands: PluginCommand[]
  buttons: PluginButton[]
  hooks: PluginHook[]
  schedules: PluginSchedule[]
}

export type PluginScope = 'project' | 'global'

/**
 * needs-approval: never approved. changed: its files or permissions changed since you approved it.
 * approved: ready. off: turned off (by you, or after its runs kept failing). broken: its
 * plugin.json has problems.
 */
export type PluginStatus = 'needs-approval' | 'changed' | 'approved' | 'off' | 'broken'

/** One run of a plugin's command. */
export interface PluginRun {
  at: string
  command: string
  /** What started it: a button, its panel, an event ("hook:request-end"), a schedule ("schedule:<id>"). */
  trigger: string
  ok: boolean
  /** null when it couldn't start or was stopped. */
  exitCode: number | null
  seconds: number
  /** The last of what it printed (secrets masked). */
  output: string
  /** Its "::status" line, if it printed one. */
  status?: string
  /** The JSON it printed after "::json", for its panel. */
  result?: unknown
}

export interface PluginInfo {
  /** "project:<name>" or "global:<name>". */
  key: string
  scope: PluginScope
  name: string
  folder: string
  manifest?: PluginManifest
  status: PluginStatus
  /** What's wrong with plugin.json, or with the folder (too big). */
  problems: string[]
  /** Things worth knowing that do not stop it (where a plugin for every project runs its schedules). */
  notes: string[]
  /** The fingerprint of its files now: approving sends it back, so what is approved is what you saw. */
  hash?: string
  /** Permissions asked for that weren't approved last time. */
  newPermissions: PluginPermission[]
  approvedAt?: string
  /** Why it was turned off, when Starwright did it. */
  offReason?: string
  /** Its latest run in this project. */
  lastRun?: PluginRun
  /** A command of it is running now. */
  running?: string
}

export interface PluginList {
  plugins: PluginInfo[]
  /** Where project plugins go, and where plugins for every project go. */
  projectFolder: string
  globalFolder: string
  /** The examples Starwright comes with that aren't in the plugins folder yet. */
  examples: { name: string; title: string }[]
  /** Every plugin is paused: by the setting, or because Starwright started in safe mode. */
  paused: false | 'setting' | 'safe-mode'
}

export interface OpenedPanel {
  /** Names this open panel in calls (the frame never sees it). */
  token: string
  /** On this computer. */
  url: string
  /** Over Remote: the same panel from Starwright's Remote address. */
  remotePath: string
  title: string
  pluginTitle: string
}

/** Something that happened, as a plugin's hooks and open panels hear it. */
export interface PluginEvent {
  type: PluginEventName
  at: string
  [field: string]: unknown
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const VERSION = /^\d+\.\d+\.\d+$/
/** Scheduled commands: no more often than this. */
export const MIN_PLUGIN_EVERY_MINUTES = 5
export const DEFAULT_COMMAND_TIMEOUT = 120
export const MAX_COMMAND_TIMEOUT = 3600

/** A path inside the plugin folder: no leading slash, no "..", no backslashes, ends in .html. */
export function isPanelEntry(path: string): boolean {
  return /^[\w.-]+(\/[\w.-]+)*\.html?$/i.test(path) && !path.split('/').some((p) => p === '..' || p === '.')
}

/** A command as the approval screen shows it. */
export function commandLine(command: Pick<PluginCommand, 'run'>): string {
  if (typeof command.run === 'string') return command.run
  return command.run.map((a) => (/[\s"]/.test(a) || !a ? JSON.stringify(a) : a)).join(' ')
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** A schedule's time in plain words. */
export function describePluginWhen(when: PluginWhen): string {
  if (when.kind === 'every') {
    return when.minutes % 60 === 0 ? (when.minutes === 60 ? 'Every hour' : `Every ${when.minutes / 60} hours`) : `Every ${when.minutes} minutes`
  }
  const days = [...when.days].sort()
  const which =
    days.length === 7 ? 'Every day' : days.join() === '1,2,3,4,5' ? 'Weekdays' : days.join() === '0,6' ? 'Weekends' : days.map((d) => DAY_NAMES[d]).join(', ')
  return `${which} at ${when.time}`
}

/** Checks a plugin.json. `folderName` is the folder it is in, which its name must match. */
export function parseManifest(raw: unknown, folderName: string): { manifest?: PluginManifest; problems: string[] } {
  const problems: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problems: ['plugin.json must be a JSON object.'] }
  const m = raw as Record<string, unknown>
  const text = (key: string, max: number): string => {
    const value = m[key]
    if (typeof value !== 'string' || !value.trim()) {
      problems.push(`"${key}" is missing.`)
      return ''
    }
    if (value.length > max) problems.push(`"${key}" is longer than ${max} characters.`)
    return value.trim()
  }
  const list = (key: string): Record<string, unknown>[] => {
    const value = m[key]
    if (value === undefined) return []
    if (!Array.isArray(value)) {
      problems.push(`"${key}" must be a list.`)
      return []
    }
    return value.map((v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}))
  }
  const name = text('name', 40)
  if (name && !NAME.test(name)) problems.push('"name" may only have lower-case letters, digits and dashes.')
  if (name && name !== folderName) problems.push(`"name" is "${name}" but the folder is called "${folderName}": they must match.`)
  const title = text('title', 60)
  const version = text('version', 20)
  if (version && !VERSION.test(version)) problems.push('"version" must look like 1.0.0.')
  const description = text('description', 300)

  const permissions: PluginPermission[] = []
  if (m.permissions !== undefined && !Array.isArray(m.permissions)) problems.push('"permissions" must be a list.')
  for (const p of Array.isArray(m.permissions) ? m.permissions : []) {
    if (typeof p === 'string' && p in PLUGIN_PERMISSIONS) {
      if (!permissions.includes(p as PluginPermission)) permissions.push(p as PluginPermission)
    } else problems.push(`Unknown permission ${JSON.stringify(p)} (known: ${Object.keys(PLUGIN_PERMISSIONS).join(', ')}).`)
  }

  const panels: PluginPanel[] = []
  for (const p of list('panels')) {
    const id = typeof p.id === 'string' ? p.id : ''
    const panelTitle = typeof p.title === 'string' ? p.title.trim() : ''
    const entry = typeof p.entry === 'string' ? p.entry.replace(/^\.\//, '') : ''
    if (!ID.test(id)) problems.push(`A panel's "id" must be lower-case letters, digits and dashes (got ${JSON.stringify(p.id)}).`)
    else if (panels.some((x) => x.id === id)) problems.push(`Two panels are called "${id}".`)
    if (!panelTitle || panelTitle.length > 40) problems.push(`Panel "${id}" needs a "title" of up to 40 characters.`)
    if (!isPanelEntry(entry)) problems.push(`Panel "${id}" needs an "entry": an .html file inside the plugin's folder, like "panel.html".`)
    panels.push({ id, title: panelTitle, entry })
  }
  if (panels.length > 8) problems.push('A plugin can have at most 8 panels.')

  const commands: PluginCommand[] = []
  for (const c of list('commands')) {
    const id = typeof c.id === 'string' ? c.id : ''
    const commandTitle = typeof c.title === 'string' ? c.title.trim() : ''
    if (!ID.test(id)) problems.push(`A command's "id" must be lower-case letters, digits and dashes (got ${JSON.stringify(c.id)}).`)
    else if (commands.some((x) => x.id === id)) problems.push(`Two commands are called "${id}".`)
    if (!commandTitle || commandTitle.length > 40) problems.push(`Command "${id}" needs a "title" of up to 40 characters.`)
    let run: string | string[] = ''
    if (typeof c.run === 'string' && c.run.trim() && c.run.length <= 2000) run = c.run.trim()
    else if (Array.isArray(c.run) && c.run.length && c.run.length <= 40 && c.run.every((a) => typeof a === 'string' && a.length <= 1000) && (c.run[0] as string).trim()) {
      run = c.run as string[]
    } else problems.push(`Command "${id}" needs a "run": a list like ["node", "{plugin}/check.js"], or a command line.`)
    let timeout = DEFAULT_COMMAND_TIMEOUT
    if (c.timeout !== undefined) {
      const t = Number(c.timeout)
      if (!Number.isInteger(t) || t < 1 || t > MAX_COMMAND_TIMEOUT) problems.push(`Command "${id}": "timeout" is seconds, 1 to ${MAX_COMMAND_TIMEOUT}.`)
      else timeout = t
    }
    commands.push({ id, title: commandTitle, run, timeout })
  }
  if (commands.length > 20) problems.push('A plugin can have at most 20 commands.')
  if (commands.length && !permissions.includes('commands')) problems.push('It has commands, so "permissions" must include "commands".')
  const known = (command: unknown, where: string): string => {
    const id = typeof command === 'string' ? command : ''
    if (!commands.some((c) => c.id === id)) problems.push(`${where} names the command ${JSON.stringify(command)}, which isn't in "commands".`)
    return id
  }

  const buttons: PluginButton[] = []
  for (const b of list('buttons')) {
    const buttonTitle = typeof b.title === 'string' ? b.title.trim() : ''
    if (!buttonTitle || buttonTitle.length > 30) problems.push('Each button needs a "title" of up to 30 characters.')
    buttons.push({ title: buttonTitle, command: known(b.command, `Button "${buttonTitle}"`) })
  }
  if (buttons.length > 6) problems.push('A plugin can have at most 6 buttons.')

  const hooks: PluginHook[] = []
  for (const h of list('hooks')) {
    const on = typeof h.on === 'string' && h.on in PLUGIN_EVENTS ? (h.on as PluginEventName) : undefined
    if (!on) problems.push(`A hook's "on" must be one of ${Object.keys(PLUGIN_EVENTS).join(', ')} (got ${JSON.stringify(h.on)}).`)
    const command = known(h.command, `The ${String(h.on)} hook`)
    if (on && hooks.some((x) => x.on === on && x.command === command)) problems.push(`The ${on} hook runs "${command}" twice.`)
    hooks.push({ on: on ?? 'request-end', command })
  }
  if (hooks.length > 8) problems.push('A plugin can have at most 8 hooks.')

  const schedules: PluginSchedule[] = []
  for (const s of list('schedules')) {
    const id = typeof s.id === 'string' ? s.id : ''
    if (!ID.test(id)) problems.push(`A schedule's "id" must be lower-case letters, digits and dashes (got ${JSON.stringify(s.id)}).`)
    else if (schedules.some((x) => x.id === id)) problems.push(`Two schedules are called "${id}".`)
    const command = known(s.command, `Schedule "${id}"`)
    const w = (s.when && typeof s.when === 'object' ? s.when : {}) as Record<string, unknown>
    let when: PluginWhen = { kind: 'every', minutes: 60 }
    if (w.kind === 'daily') {
      const time = String(w.time ?? '')
      const days = w.days === undefined ? [0, 1, 2, 3, 4, 5, 6] : Array.isArray(w.days) ? [...new Set(w.days.map(Number))].sort() : []
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) problems.push(`Schedule "${id}": "time" must be like "09:30" (24-hour).`)
      if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) problems.push(`Schedule "${id}": "days" are 0 (Sunday) to 6.`)
      when = { kind: 'daily', time, days }
    } else if (w.kind === 'every') {
      const minutes = Number(w.minutes)
      if (!Number.isInteger(minutes) || minutes < MIN_PLUGIN_EVERY_MINUTES || minutes > 7 * 24 * 60) {
        problems.push(`Schedule "${id}": "minutes" must be a whole number from ${MIN_PLUGIN_EVERY_MINUTES} to ${7 * 24 * 60}.`)
      }
      when = { kind: 'every', minutes }
    } else problems.push(`Schedule "${id}" needs a "when": { "kind": "daily", "time": "09:00" } or { "kind": "every", "minutes": 60 }.`)
    schedules.push({ id, command, when })
  }
  if (schedules.length > 6) problems.push('A plugin can have at most 6 schedules.')

  if (!panels.length && !commands.length) problems.push('A plugin needs at least one panel or command.')
  if (problems.length) return { problems }
  return { manifest: { name, title, version, description, permissions, panels, commands, buttons, hooks, schedules }, problems }
}
