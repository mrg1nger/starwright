import { app } from 'electron'
import { randomBytes } from 'crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, extname, join } from 'path'
import { getProject } from '../projects/store'
import { getSettings } from '../settings/store'
import {
  PLUGIN_PERMISSIONS,
  type OpenedPanel,
  type PluginInfo,
  type PluginList,
  type PluginManifest,
  type PluginPermission,
  type PluginRun,
  type PluginScope
} from '@shared/plugins'
import { checkPluginFolder, PROJECT_PLUGINS_DIR } from './check'
import { PANEL_API_SCRIPT } from './panelApi'

export { MAX_PLUGIN_BYTES, MAX_PLUGIN_FILES, PROJECT_PLUGINS_DIR, readPluginFiles } from './check'

// Finds plugins, fingerprints their files, keeps your approvals, and serves an approved panel's
// files to its frame (starwright-plugin://<token>/..., or /plugin-panel/<token>/... over Remote).
// What a panel shows and what a command runs is a copy of the files taken when it opens or runs,
// checked against the fingerprint you approved: a file changed afterwards isn't used, and the
// plugin needs approving again first.

/** Open panels kept at once (the oldest is closed past this). */
const MAX_OPEN = 12

export const PANEL_SCHEME = 'starwright-plugin'
/** The panel's helper script, served at this path in every panel. */
export const API_PATH = '_starwright/api.js'
/** Over Remote, panels are served under this path. */
export const REMOTE_PANEL_PREFIX = '/plugin-panel/'

export const globalPluginsFolder = (): string => join(app.getPath('userData'), 'plugins')
export const approvalsFile = (): string => join(app.getPath('userData'), 'plugins-approved.json')

/** The plugins Starwright comes with, offered as examples. */
export function examplesFolder(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'plugins')
  for (let dir = __dirname; ; dir = dirname(dir)) {
    const candidate = join(dir, 'resources', 'plugins')
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) return join(process.cwd(), 'resources', 'plugins')
  }
}
export const EXAMPLE_PLUGIN = 'project-pulse'

// ---- paused: by the setting, or for this run (started in safe mode) ----------------------------

let safeMode = process.argv.includes('--safe-mode') || process.env.STARWRIGHT_SAFE_MODE === '1'

/** Whether plugins are paused, and why. Paused, nothing of any plugin runs or opens. */
export function pluginsPaused(): false | 'setting' | 'safe-mode' {
  if (safeMode) return 'safe-mode'
  return getSettings().pluginsPaused ? 'setting' : false
}

/** Leaves safe mode for the rest of this run (the setting is changed on its own). */
export function leaveSafeMode(): void {
  safeMode = false
}

export function setSafeModeForTests(on: boolean): void {
  safeMode = on
}

function refuseWhenPaused(): void {
  const paused = pluginsPaused()
  if (paused) throw new Error(paused === 'safe-mode' ? 'Starwright started in safe mode: plugins are paused until you resume them.' : 'Plugins are paused: resume them in the Plugins pane.')
}

// ---- approvals -------------------------------------------------------------------------------

interface Approval {
  hash: string
  permissions: PluginPermission[]
  approvedAt: string
  off?: boolean
  /** Why Starwright turned it off (its runs kept failing). */
  offReason?: string
}

/** Approvals by plugin: "global:<name>", or "<projectId>:<name>" for a project's own. */
type Approvals = Record<string, Approval>

function readApprovals(): Approvals {
  try {
    const data = JSON.parse(readFileSync(approvalsFile(), 'utf-8')) as unknown
    return data && typeof data === 'object' ? (data as Approvals) : {}
  } catch {
    return {}
  }
}

function writeApprovals(approvals: Approvals): void {
  const file = approvalsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(approvals, null, 2))
  renameSync(`${file}.tmp`, file)
}

export const approvalKey = (projectId: string, scope: PluginScope, name: string): string => (scope === 'global' ? `global:${name}` : `${projectId}:${name}`)

// ---- finding --------------------------------------------------------------------------------

/** A plugin as found on disk, with its files when they're sound. */
export interface Found {
  info: PluginInfo
  files?: Map<string, Buffer>
}

/** What the runtime adds to each plugin: its latest run here, and what's running now. */
let runInfo: (projectId: string, key: string) => { lastRun?: PluginRun; running?: string } = () => ({})
export function setRunInfo(fn: typeof runInfo): void {
  runInfo = fn
}

function folderPlugins(folder: string, scope: PluginScope, projectId: string, approvals: Approvals): Found[] {
  let names: string[]
  try {
    names = readdirSync(folder, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
  return names.map((name) => {
    const key = `${scope}:${name}`
    const base: PluginInfo = { key, scope, name, folder: join(folder, name), status: 'broken', problems: [], notes: [], newPermissions: [] }
    const checked = checkPluginFolder(base.folder, name)
    const { manifest } = checked
    if (!manifest || checked.problems.length || !checked.hash) return { info: { ...base, manifest, problems: checked.problems } }
    const approval = approvals[approvalKey(projectId, scope, name)]
    const newPermissions = manifest.permissions.filter((p) => !approval?.permissions.includes(p))
    const status = !approval ? 'needs-approval' : approval.hash !== checked.hash || newPermissions.length ? 'changed' : approval.off ? 'off' : 'approved'
    const notes: string[] = []
    if (scope === 'global' && manifest.schedules.length) notes.push("It's for every project, so its schedules run in each project you've opened in the last two weeks.")
    return {
      info: {
        ...base,
        manifest,
        status,
        notes,
        hash: checked.hash,
        newPermissions: approval ? newPermissions : manifest.permissions,
        approvedAt: approval?.approvedAt,
        offReason: approval?.off ? approval.offReason : undefined,
        ...runInfo(projectId, key)
      },
      files: checked.files
    }
  })
}

function projectPath(projectId: string): string {
  const project = getProject(projectId)
  if (!project) throw new Error('That project is no longer in the list.')
  return project.path
}

/** Every plugin a project has: its own, then those for every project. */
export function findPlugins(projectId: string): Found[] {
  const approvals = readApprovals()
  return [
    ...folderPlugins(join(projectPath(projectId), PROJECT_PLUGINS_DIR), 'project', projectId, approvals),
    ...folderPlugins(globalPluginsFolder(), 'global', projectId, approvals)
  ]
}

export function findPlugin(projectId: string, key: string): Found {
  const found = findPlugins(projectId).find((f) => f.info.key === key)
  if (!found) throw new Error("That plugin isn't there any more.")
  return found
}

export type ReadyPlugin = Found & { info: PluginInfo & { manifest: PluginManifest }; files: Map<string, Buffer> }

/** An approved plugin that's on, with its files as approved (throws otherwise, saying why). */
export function readyPlugin(projectId: string, key: string): ReadyPlugin {
  refuseWhenPaused()
  const found = findPlugin(projectId, key)
  const { info, files } = found
  if (info.status !== 'approved' || !info.manifest || !files) {
    throw new Error(
      info.status === 'off'
        ? `It's turned off${info.offReason ? ` (${info.offReason})` : ''}.`
        : info.status === 'broken'
          ? `It has problems: ${info.problems.join(' ')}`
          : info.status === 'changed'
            ? 'It changed since you approved it: approve it again first.'
            : 'It needs approving first.'
    )
  }
  return found as ReadyPlugin
}

interface Example {
  name: string
  title: string
}

function examples(): Example[] {
  try {
    return readdirSync(examplesFolder(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => {
        try {
          const m = JSON.parse(readFileSync(join(examplesFolder(), d.name, 'plugin.json'), 'utf-8')) as { title?: string }
          return [{ name: d.name, title: String(m.title ?? d.name) }]
        } catch {
          return []
        }
      })
      // The first example first: it's the one to start with.
      .sort((a, b) => (a.name === EXAMPLE_PLUGIN ? -1 : b.name === EXAMPLE_PLUGIN ? 1 : a.title.localeCompare(b.title)))
  } catch {
    return []
  }
}

/** The project's plugins and the plugins for every project, with whether each may run. */
export function listPlugins(projectId: string): PluginList {
  return {
    plugins: findPlugins(projectId).map((f) => f.info),
    projectFolder: join(projectPath(projectId), PROJECT_PLUGINS_DIR),
    globalFolder: globalPluginsFolder(),
    examples: examples().filter((e) => !existsSync(join(globalPluginsFolder(), e.name))),
    paused: pluginsPaused()
  }
}

/**
 * Approves a plugin as you saw it: `hash` is the fingerprint the approval screen showed, so a
 * change made in between (by an agent, say) isn't approved along with it.
 */
export function approvePlugin(projectId: string, key: string, hash: string): PluginInfo {
  const found = findPlugin(projectId, key)
  if (!found.info.manifest || !found.info.hash || found.info.problems.length) throw new Error(`It can't be approved: ${found.info.problems.join(' ')}`)
  if (found.info.hash !== hash) throw new Error('Its files changed while you were looking: check it again before approving.')
  const approvals = readApprovals()
  approvals[approvalKey(projectId, found.info.scope, found.info.name)] = {
    hash,
    permissions: found.info.manifest.permissions,
    approvedAt: new Date().toISOString()
  }
  writeApprovals(approvals)
  closePlugin(projectId, key)
  return findPlugin(projectId, key).info
}

/** Turns an approved plugin off or on again (on needs it unchanged since approval). */
export function setPluginOff(projectId: string, key: string, off: boolean, reason?: string): PluginInfo {
  const found = findPlugin(projectId, key)
  const approvals = readApprovals()
  const k = approvalKey(projectId, found.info.scope, found.info.name)
  if (!approvals[k]) throw new Error("It hasn't been approved yet.")
  approvals[k] = { ...approvals[k], off }
  if (off && reason) approvals[k].offReason = reason
  else delete approvals[k].offReason
  writeApprovals(approvals)
  if (off) closePlugin(projectId, key)
  return findPlugin(projectId, key).info
}

/** Puts a bundled example in the plugins folder for every project (it still needs approving). */
export function addExamplePlugin(name: string = EXAMPLE_PLUGIN): void {
  if (!examples().some((e) => e.name === name)) throw new Error("Starwright doesn't come with that example.")
  const to = join(globalPluginsFolder(), name)
  if (existsSync(to)) throw new Error('The example is already there.')
  mkdirSync(globalPluginsFolder(), { recursive: true })
  cpSync(join(examplesFolder(), name), to, { recursive: true })
}

// ---- the approved copy commands run from ----------------------------------------------------------

const runCopies = (): string => join(app.getPath('userData'), 'plugin-run')

/**
 * The plugin's approved files, written out where its commands run them from ({plugin}). One copy
 * for each fingerprint, so a file changed after approval is never what runs.
 */
export function approvedCopy(found: ReadyPlugin): string {
  const hash = found.info.hash!
  const name = `${found.info.scope}-${found.info.name}`
  const dir = join(runCopies(), `${name}-${hash.slice(0, 16)}`)
  if (!existsSync(join(dir, '.complete'))) {
    rmSync(dir, { recursive: true, force: true })
    for (const [path, content] of found.files) {
      const to = join(dir, ...path.split('/'))
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, content)
    }
    writeFileSync(join(dir, '.complete'), hash)
  }
  // Older copies of the same plugin aren't needed any more.
  try {
    for (const d of readdirSync(runCopies())) {
      if (d.startsWith(`${name}-`) && d.length === name.length + 17 && d !== `${name}-${hash.slice(0, 16)}`) rmSync(join(runCopies(), d), { recursive: true, force: true })
    }
  } catch {
    // Another run may be using one: tried again next time.
  }
  return dir
}

// ---- open panels ------------------------------------------------------------------------------

export interface OpenPanel {
  token: string
  projectId: string
  key: string
  manifest: PluginManifest
  permissions: Set<PluginPermission>
  files: Map<string, Buffer>
}

const open = new Map<string, OpenPanel>()

/** Opens an approved plugin's panel: a copy of its files as approved, served under a new token. */
export function openPanel(projectId: string, key: string, panelId: string): OpenedPanel {
  const { info, files } = readyPlugin(projectId, key)
  const panel = info.manifest.panels.find((p) => p.id === panelId)
  if (!panel) throw new Error("That plugin doesn't have that panel.")
  const token = randomBytes(16).toString('hex')
  open.set(token, { token, projectId, key, manifest: info.manifest, permissions: new Set(info.manifest.permissions), files })
  while (open.size > MAX_OPEN) open.delete(open.keys().next().value!)
  return {
    token,
    url: `${PANEL_SCHEME}://${token}/${panel.entry}`,
    remotePath: `${REMOTE_PANEL_PREFIX}${token}/${panel.entry}`,
    title: panel.title,
    pluginTitle: info.manifest.title
  }
}

export function closePanel(token: string): void {
  open.delete(token)
}

export function closePlugin(projectId: string, key: string): void {
  for (const [token, p] of open) if (p.projectId === projectId && p.key === key) open.delete(token)
}

/** Closes every open panel (plugins were paused). */
export function closeAllPanels(): void {
  open.clear()
}

export function openPanelFor(token: string): OpenPanel {
  const panel = open.get(token)
  if (!panel) throw new Error('This panel was closed: open it again.')
  return panel
}

/** The open panels of a project. */
export function openPanelsOf(projectId: string): OpenPanel[] {
  return [...open.values()].filter((p) => p.projectId === projectId)
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8'
}

/**
 * What a panel page may do: run its own scripts and styles and show its own pictures, nothing
 * else. No network, no other sites, no frames, no forms: everything it needs comes through the
 * Starwright API, which checks each call. `own` is where the panel's files are served from.
 */
export function panelPolicy(token: string, own: string[] = [`${PANEL_SCHEME}://${token}`]): string {
  const self = own.join(' ')
  return [
    "default-src 'none'",
    `script-src ${self} 'unsafe-inline'`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data: blob:`,
    `font-src ${self} data:`,
    "base-uri 'none'",
    // No frame-ancestors: Starwright's own page is a file: (or the dev server's) page, which "*"
    // doesn't cover; anything else would need the panel's token to frame it.
    "form-action 'none'"
  ].join('; ')
}

export interface PanelResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

const notFound = (why: string): PanelResponse => ({ status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: Buffer.from(why) })

function panelFile(token: string, path: string, own?: string[]): PanelResponse {
  const panel = open.get(token)
  if (!panel) return notFound('This panel was closed: open it again.')
  const headers = (type: string): Record<string, string> => ({
    'Content-Type': type,
    'Content-Security-Policy': panelPolicy(panel.token, own),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  })
  if (path === API_PATH) return { status: 200, headers: headers(TYPES['.js']), body: Buffer.from(PANEL_API_SCRIPT) }
  const body = panel.files.get(path)
  if (!body || path === 'plugin.json') return notFound(`${path} isn't part of this plugin.`)
  return { status: 200, headers: headers(TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'), body }
}

/** The answer to a request for starwright-plugin://<token>/<path>. */
export function panelResponse(url: string): PanelResponse {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return notFound('Not a panel address.')
  }
  if (parsed.protocol !== `${PANEL_SCHEME}:`) return notFound('This panel was closed: open it again.')
  return panelFile(parsed.hostname, decodeURIComponent(parsed.pathname.replace(/^\/+/, '')))
}

/**
 * Over Remote: the answer to /plugin-panel/<token>/<path>. `origin` is the Remote address
 * ("https://pc.tailnet.ts.net:7428"). The token is the open panel's own secret, so this needs no
 * session of its own; the frame is sandboxed, so it can't reach Starwright's page or its cookies
 * either way. A page asks for its helper script from the top (/_starwright/api.js), which over
 * Remote would be Starwright's own address: its pages are served with that pointed at the
 * panel's. Null for any other address.
 */
export function remotePanelResponse(pathname: string, origin: string): PanelResponse | null {
  if (!pathname.startsWith(REMOTE_PANEL_PREFIX)) return null
  const m = /^\/plugin-panel\/([0-9a-f]{32})\/(.+)$/.exec(pathname)
  if (!m) return notFound('Not a panel address.')
  let path: string
  try {
    path = decodeURIComponent(m[2])
  } catch {
    return notFound('Not a panel address.')
  }
  const own = `${origin}${REMOTE_PANEL_PREFIX}${m[1]}/`
  const response = panelFile(m[1], path, [own])
  if (response.status === 200 && /\.html?$/i.test(path)) {
    response.body = Buffer.from(response.body.toString('utf-8').replace(/(["'])\/_starwright\/api\.js\1/g, `$1${REMOTE_PANEL_PREFIX}${m[1]}/${API_PATH}$1`))
  }
  return response
}

/** Whether an open panel's plugin was given a permission (calls check this first). */
export function requirePermission(panel: Pick<OpenPanel, 'permissions'>, permission: PluginPermission): void {
  if (!panel.permissions.has(permission)) {
    throw new Error(`This plugin wasn't given "${permission}" (${PLUGIN_PERMISSIONS[permission]}). Add it to plugin.json's permissions; you'll be asked to approve it.`)
  }
}

export const projectFolderOf = projectPath
