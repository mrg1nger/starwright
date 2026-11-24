// Plugins: small add-ons that give Starwright things it doesn't have, written by you, Claude or
// Codex. A plugin is a folder with a plugin.json (this file checks it) and the files it names.
// Release 1 has panels: pages shown beside the chat, in a locked-down frame, that reach
// Starwright only through the permissions you approved. See docs/plugins.md.

/** What a plugin may ask for, in the words the approval screen uses. */
export const PLUGIN_PERMISSIONS = {
  'files:read': "Read this project's files (not files that usually hold passwords or keys, and nothing outside the project)",
  storage: 'Keep its own small store of data (up to 1 MB for each project)',
  'records:read': "Read Starwright's records for this project: your requests and how they went, tokens used, hand-offs to other agents, and scheduled runs"
} as const

export type PluginPermission = keyof typeof PLUGIN_PERMISSIONS

export interface PluginPanel {
  /** Short id, unique in the plugin. */
  id: string
  title: string
  /** The page, a path inside the plugin's folder ("panel.html"). */
  entry: string
}

export interface PluginManifest {
  /** The folder's name: lower case, digits and dashes. */
  name: string
  title: string
  version: string
  description: string
  permissions: PluginPermission[]
  panels: PluginPanel[]
}

export type PluginScope = 'project' | 'global'

/**
 * needs-approval: never approved. changed: its files or permissions changed since you approved it.
 * approved: ready. off: turned off by you. broken: its plugin.json has problems.
 */
export type PluginStatus = 'needs-approval' | 'changed' | 'approved' | 'off' | 'broken'

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
  /** The fingerprint of its files now: approving sends it back, so what is approved is what you saw. */
  hash?: string
  /** Permissions asked for that weren't approved last time. */
  newPermissions: PluginPermission[]
  approvedAt?: string
}

export interface PluginList {
  plugins: PluginInfo[]
  /** Where project plugins go, and where plugins for every project go. */
  projectFolder: string
  globalFolder: string
  /** False when the bundled example is already there. */
  canAddExample: boolean
}

export interface OpenedPanel {
  /** Names this open panel in calls (the frame never sees it). */
  token: string
  url: string
  title: string
  pluginTitle: string
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
const PANEL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const VERSION = /^\d+\.\d+\.\d+$/

/** A path inside the plugin folder: no leading slash, no "..", no backslashes, ends in .html. */
export function isPanelEntry(path: string): boolean {
  return /^[\w.-]+(\/[\w.-]+)*\.html?$/i.test(path) && !path.split('/').some((p) => p === '..' || p === '.')
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
  if (!Array.isArray(m.panels) || !m.panels.length) problems.push('"panels" must list at least one panel (release 1 plugins are panels).')
  for (const raw of Array.isArray(m.panels) ? m.panels : []) {
    const p = (raw ?? {}) as Record<string, unknown>
    const id = typeof p.id === 'string' ? p.id : ''
    const panelTitle = typeof p.title === 'string' ? p.title.trim() : ''
    const entry = typeof p.entry === 'string' ? p.entry.replace(/^\.\//, '') : ''
    if (!PANEL_ID.test(id)) problems.push(`A panel's "id" must be lower-case letters, digits and dashes (got ${JSON.stringify(p.id)}).`)
    else if (panels.some((x) => x.id === id)) problems.push(`Two panels are called "${id}".`)
    if (!panelTitle || panelTitle.length > 40) problems.push(`Panel "${id}" needs a "title" of up to 40 characters.`)
    if (!isPanelEntry(entry)) problems.push(`Panel "${id}" needs an "entry": an .html file inside the plugin's folder, like "panel.html".`)
    panels.push({ id, title: panelTitle, entry })
  }
  if (panels.length > 8) problems.push('A plugin can have at most 8 panels.')
  if (problems.length) return { problems }
  return { manifest: { name, title, version, description, permissions, panels }, problems }
}
