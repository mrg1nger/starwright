import { app } from 'electron'
import { createHash, randomBytes } from 'crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, extname, join } from 'path'
import { getProject } from '../projects/store'
import {
  parseManifest,
  PLUGIN_PERMISSIONS,
  type OpenedPanel,
  type PluginInfo,
  type PluginList,
  type PluginManifest,
  type PluginPermission,
  type PluginScope
} from '@shared/plugins'
import { PANEL_API_SCRIPT } from './panelApi'

// Finds plugins, fingerprints their files, keeps your approvals, and serves an approved panel's
// files to its frame (starwright-plugin://<token>/...). What a panel runs is a copy of the files
// taken when it opens, checked against the fingerprint you approved: a file changed afterwards
// isn't served, and the plugin needs approving again before it opens next.

/** A plugin's folder may hold at most this much (a panel, its scripts and pictures). */
export const MAX_PLUGIN_FILES = 200
export const MAX_PLUGIN_BYTES = 5 * 1024 * 1024
/** Open panels kept at once (the oldest is closed past this). */
const MAX_OPEN = 12

export const PROJECT_PLUGINS_DIR = join('.starwright', 'plugins')
export const PANEL_SCHEME = 'starwright-plugin'
/** The panel's helper script, served at this path in every panel. */
export const API_PATH = '_starwright/api.js'

export const globalPluginsFolder = (): string => join(app.getPath('userData'), 'plugins')
const approvalsFile = (): string => join(app.getPath('userData'), 'plugins-approved.json')

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

// ---- approvals -------------------------------------------------------------------------------

interface Approval {
  hash: string
  permissions: PluginPermission[]
  approvedAt: string
  off?: boolean
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

const approvalKey = (projectId: string, scope: PluginScope, name: string): string => (scope === 'global' ? `global:${name}` : `${projectId}:${name}`)

// ---- finding and fingerprinting -------------------------------------------------------------

/** Every file in a plugin's folder (relative paths with /), or a problem: too big, or a link. */
export function readPluginFiles(folder: string): { files: Map<string, Buffer>; hash: string } | { problem: string } {
  const files = new Map<string, Buffer>()
  let bytes = 0
  const walk = (dir: string, prefix: string): string | undefined => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      // A link could lead anywhere on the computer: plugins hold real files only.
      if (lstatSync(full).isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) return `"${rel}" is a link: a plugin's folder may only hold real files.`
      if (entry.isDirectory()) {
        const problem = walk(full, rel)
        if (problem) return problem
        continue
      }
      const content = readFileSync(full)
      bytes += content.length
      files.set(rel, content)
      if (files.size > MAX_PLUGIN_FILES) return `It has more than ${MAX_PLUGIN_FILES} files.`
      if (bytes > MAX_PLUGIN_BYTES) return `Its files come to more than ${MAX_PLUGIN_BYTES / 1024 / 1024} MB.`
    }
    return undefined
  }
  try {
    const problem = walk(folder, '')
    if (problem) return { problem }
  } catch (err) {
    return { problem: `Its folder can't be read: ${(err as Error).message}` }
  }
  const h = createHash('sha256')
  for (const [path, content] of files) {
    h.update(`${path}\0${content.length}\0`)
    h.update(content)
  }
  return { files, hash: h.digest('hex') }
}

interface Found {
  info: PluginInfo
  files?: Map<string, Buffer>
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
    const dir = join(folder, name)
    const info: PluginInfo = { key: `${scope}:${name}`, scope, name, folder: dir, status: 'broken', problems: [], newPermissions: [] }
    const read = readPluginFiles(dir)
    if ('problem' in read) return { info: { ...info, problems: [read.problem] } }
    const raw = read.files.get('plugin.json')
    if (!raw) return { info: { ...info, problems: ['It has no plugin.json.'] } }
    let json: unknown
    try {
      json = JSON.parse(raw.toString('utf-8').replace(/^﻿/, ''))
    } catch (err) {
      return { info: { ...info, problems: [`plugin.json isn't valid JSON: ${(err as Error).message}`] } }
    }
    const { manifest, problems } = parseManifest(json, name)
    if (!manifest) return { info: { ...info, problems } }
    const missing = manifest.panels.filter((p) => !read.files.has(p.entry)).map((p) => `Panel "${p.id}" names ${p.entry}, which isn't in the folder.`)
    if (missing.length) return { info: { ...info, manifest, problems: missing } }
    const approval = approvals[approvalKey(projectId, scope, name)]
    const newPermissions = manifest.permissions.filter((p) => !approval?.permissions.includes(p))
    const status = !approval ? 'needs-approval' : approval.hash !== read.hash || newPermissions.length ? 'changed' : approval.off ? 'off' : 'approved'
    return {
      info: { ...info, manifest, status, hash: read.hash, newPermissions: approval ? newPermissions : manifest.permissions, approvedAt: approval?.approvedAt },
      files: read.files
    }
  })
}

function projectPath(projectId: string): string {
  const project = getProject(projectId)
  if (!project) throw new Error('That project is no longer in the list.')
  return project.path
}

function findAll(projectId: string): Found[] {
  const approvals = readApprovals()
  return [
    ...folderPlugins(join(projectPath(projectId), PROJECT_PLUGINS_DIR), 'project', projectId, approvals),
    ...folderPlugins(globalPluginsFolder(), 'global', projectId, approvals)
  ]
}

function findOne(projectId: string, key: string): Found {
  const found = findAll(projectId).find((f) => f.info.key === key)
  if (!found) throw new Error("That plugin isn't there any more.")
  return found
}

/** The project's plugins and the plugins for every project, with whether each may run. */
export function listPlugins(projectId: string): PluginList {
  return {
    plugins: findAll(projectId).map((f) => f.info),
    projectFolder: join(projectPath(projectId), PROJECT_PLUGINS_DIR),
    globalFolder: globalPluginsFolder(),
    canAddExample: !existsSync(join(globalPluginsFolder(), EXAMPLE_PLUGIN)) && existsSync(join(examplesFolder(), EXAMPLE_PLUGIN))
  }
}

/**
 * Approves a plugin as you saw it: `hash` is the fingerprint the approval screen showed, so a
 * change made in between (by an agent, say) isn't approved along with it.
 */
export function approvePlugin(projectId: string, key: string, hash: string): PluginInfo {
  const found = findOne(projectId, key)
  if (!found.info.manifest || !found.info.hash) throw new Error(`It can't be approved: ${found.info.problems.join(' ')}`)
  if (found.info.hash !== hash) throw new Error('Its files changed while you were looking: check it again before approving.')
  const approvals = readApprovals()
  approvals[approvalKey(projectId, found.info.scope, found.info.name)] = {
    hash,
    permissions: found.info.manifest.permissions,
    approvedAt: new Date().toISOString()
  }
  writeApprovals(approvals)
  closePlugin(projectId, key)
  return findOne(projectId, key).info
}

/** Turns an approved plugin off or on again (on needs it unchanged since approval). */
export function setPluginOff(projectId: string, key: string, off: boolean): PluginInfo {
  const found = findOne(projectId, key)
  const approvals = readApprovals()
  const k = approvalKey(projectId, found.info.scope, found.info.name)
  if (!approvals[k]) throw new Error("It hasn't been approved yet.")
  approvals[k] = { ...approvals[k], off }
  writeApprovals(approvals)
  if (off) closePlugin(projectId, key)
  return findOne(projectId, key).info
}

/** Puts the bundled example in the plugins folder for every project (it still needs approving). */
export function addExamplePlugin(): void {
  const to = join(globalPluginsFolder(), EXAMPLE_PLUGIN)
  if (existsSync(to)) throw new Error('The example is already there.')
  mkdirSync(globalPluginsFolder(), { recursive: true })
  cpSync(join(examplesFolder(), EXAMPLE_PLUGIN), to, { recursive: true })
}

// ---- open panels ------------------------------------------------------------------------------

interface OpenPanel {
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
  const found = findOne(projectId, key)
  const { info, files } = found
  if (info.status !== 'approved' || !info.manifest || !files) {
    throw new Error(info.status === 'off' ? "It's turned off." : info.status === 'broken' ? `It has problems: ${info.problems.join(' ')}` : 'It needs approving first.')
  }
  const panel = info.manifest.panels.find((p) => p.id === panelId)
  if (!panel) throw new Error("That plugin doesn't have that panel.")
  const token = randomBytes(16).toString('hex')
  open.set(token, { token, projectId, key, manifest: info.manifest, permissions: new Set(info.manifest.permissions), files })
  while (open.size > MAX_OPEN) open.delete(open.keys().next().value!)
  return { token, url: `${PANEL_SCHEME}://${token}/${panel.entry}`, title: panel.title, pluginTitle: info.manifest.title }
}

export function closePanel(token: string): void {
  open.delete(token)
}

function closePlugin(projectId: string, key: string): void {
  for (const [token, p] of open) if (p.projectId === projectId && p.key === key) open.delete(token)
}

export function openPanelFor(token: string): OpenPanel {
  const panel = open.get(token)
  if (!panel) throw new Error('This panel was closed: open it again.')
  return panel
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
 * Starwright API, which asks for each call.
 */
export function panelPolicy(token: string): string {
  const self = `${PANEL_SCHEME}://${token}`
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

/** The answer to a request for starwright-plugin://<token>/<path>. */
export function panelResponse(url: string): PanelResponse {
  const notFound = (why: string): PanelResponse => ({ status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: Buffer.from(why) })
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return notFound('Not a panel address.')
  }
  const panel = open.get(parsed.hostname)
  if (!panel || parsed.protocol !== `${PANEL_SCHEME}:`) return notFound('This panel was closed: open it again.')
  const path = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
  const headers = (type: string): Record<string, string> => ({
    'Content-Type': type,
    'Content-Security-Policy': panelPolicy(panel.token),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  })
  if (path === API_PATH) return { status: 200, headers: headers(TYPES['.js']), body: Buffer.from(PANEL_API_SCRIPT) }
  const body = panel.files.get(path)
  if (!body || path === 'plugin.json') return notFound(`${path} isn't part of this plugin.`)
  return { status: 200, headers: headers(TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'), body }
}

/** Whether an open panel's plugin was given a permission (calls check this first). */
export function requirePermission(panel: OpenPanel, permission: PluginPermission): void {
  if (!panel.permissions.has(permission)) {
    throw new Error(`This plugin wasn't given "${permission}" (${PLUGIN_PERMISSIONS[permission]}). Add it to plugin.json's permissions; you'll be asked to approve it.`)
  }
}

export const projectFolderOf = projectPath
