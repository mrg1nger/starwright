import { app } from 'electron'
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getProject } from '../projects/store'
import { listProjectFiles, readProjectFile } from '../files/projectFiles'
import { memoryDb } from '../memory/paths'
import { listSchedules } from '../schedule/scheduler'
import { openPanelFor, projectFolderOf, requirePermission } from './registry'
import { pluginNotify, pluginRuns, runPluginCommand } from './runtime'

// What a panel can ask Starwright for, each call checked against the permissions its plugin was
// approved with. Everything is about the project the panel is open in, and read-only, apart from
// the plugin's own store and running its own approved commands.

/** A plugin's store, for each project: at most this much. */
export const MAX_STORAGE_BYTES = 1024 * 1024
const MAX_KEY = 200
/** Records go back at most this far, and a call returns at most this many rows. */
const MAX_DAYS = 365
const MAX_ROWS = 2000

const clip = (text: unknown, max: number): string => {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// ---- the plugin's own store ------------------------------------------------------------------

function storageFile(projectId: string, key: string): string {
  const id = createHash('sha256').update(`${projectId}\n${key}`).digest('hex').slice(0, 32)
  return join(app.getPath('userData'), 'plugin-data', `${id}.json`)
}

function readStore(file: string): Record<string, unknown> {
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeStore(file: string, data: Record<string, unknown>): void {
  const text = JSON.stringify(data)
  if (Buffer.byteLength(text) > MAX_STORAGE_BYTES) throw new Error(`The plugin's store would be over ${MAX_STORAGE_BYTES / 1024} KB: remove something first.`)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
}

function storeKey(key: unknown): string {
  if (typeof key !== 'string' || !key || key.length > MAX_KEY) throw new Error(`A storage key must be text of 1 to ${MAX_KEY} characters.`)
  return key
}

// ---- Starwright's records ---------------------------------------------------------------------

function since(options: unknown): string {
  const raw = Number((options as { days?: unknown } | undefined)?.days ?? 30)
  const days = Math.min(MAX_DAYS, Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : 30))
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

function requests(projectId: string, options: unknown): unknown[] {
  const rows = memoryDb()
    .prepare(
      `SELECT at, mode, route, size, model, text, outcome, seconds, handoffs, claude_fresh, claude_cached, claude_output, codex_fresh, codex_cached, codex_output, cline_fresh, cline_cached, cline_output
       FROM request_log WHERE project_id = ? AND at >= ? ORDER BY at LIMIT ?`
    )
    .all(projectId, since(options), MAX_ROWS) as Record<string, unknown>[]
  return rows.map((r) => ({
    at: r.at,
    mode: r.mode,
    route: r.route ?? null,
    size: r.size ?? null,
    model: r.model ?? null,
    text: clip(r.text, 200),
    outcome: r.outcome,
    seconds: Number(r.seconds),
    handoffs: Number(r.handoffs),
    claude: { fresh: Number(r.claude_fresh), cached: Number(r.claude_cached), output: Number(r.claude_output) },
    codex: { fresh: Number(r.codex_fresh), cached: Number(r.codex_cached), output: Number(r.codex_output) },
    cline: { fresh: Number(r.cline_fresh), cached: Number(r.cline_cached), output: Number(r.cline_output) }
  }))
}

function usage(projectId: string, options: unknown): unknown[] {
  const rows = memoryDb()
    .prepare('SELECT at, kind, agent, model, fresh, cached, output, steps, cost_usd FROM usage_log WHERE project_id = ? AND at >= ? ORDER BY at LIMIT ?')
    .all(projectId, since(options), MAX_ROWS) as Record<string, unknown>[]
  return rows.map((r) => ({
    at: r.at,
    kind: r.kind,
    agent: r.agent,
    model: r.model ?? null,
    fresh: Number(r.fresh),
    cached: Number(r.cached),
    output: Number(r.output),
    steps: Number(r.steps),
    costUsd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd)
  }))
}

function handoffs(projectId: string, options: unknown): unknown[] {
  const rows = memoryDb()
    .prepare('SELECT * FROM handoffs WHERE project_id = ? AND started_at >= ? ORDER BY id LIMIT ?')
    .all(projectId, since(options), MAX_ROWS) as Record<string, unknown>[]
  return rows.map((r) => {
    let files = 0
    try {
      files = (JSON.parse(String(r.files ?? '[]')) as unknown[]).length
    } catch {
      files = 0
    }
    return {
      id: Number(r.id),
      agent: r.agent,
      status: r.status,
      brief: clip(r.brief, 200),
      kind: r.task_kind ?? null,
      model: r.model ?? null,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? null,
      files
    }
  })
}

function schedules(projectId: string): unknown[] {
  // Not what a schedule does (a request's text, a site's address): when it runs and how it went.
  return listSchedules(projectId).map((s) => ({
    name: s.name,
    kind: s.action.kind,
    enabled: s.enabled,
    nextAt: s.nextAt ?? null,
    runs: s.runs.slice(-30).map((r) => ({ at: r.at, status: r.status, detail: clip(r.detail, 300), trigger: r.trigger }))
  }))
}

// ---- the calls --------------------------------------------------------------------------------

/** Answers one call from an open panel (the token names it; the frame never sees it). */
export async function callPlugin(token: string, method: unknown, args: unknown): Promise<unknown> {
  const panel = openPanelFor(String(token))
  const list = Array.isArray(args) ? args : []
  if (JSON.stringify(list).length > 300_000) throw new Error('That call is too big.')
  const projectId = panel.projectId
  switch (method) {
    case 'hello':
      return {
        project: { name: getProject(projectId)?.name ?? '' },
        plugin: { name: panel.manifest.name, title: panel.manifest.title, version: panel.manifest.version },
        permissions: [...panel.permissions],
        commands: panel.manifest.commands.map((c) => ({ id: c.id, title: c.title }))
      }
    case 'files.list':
      requirePermission(panel, 'files:read')
      return listProjectFiles(projectFolderOf(projectId))
    case 'files.read':
      requirePermission(panel, 'files:read')
      return readProjectFile(projectFolderOf(projectId), list[0] as string)
    case 'storage.get': {
      requirePermission(panel, 'storage')
      const value = readStore(storageFile(projectId, panel.key))[storeKey(list[0])]
      return value === undefined ? null : value
    }
    case 'storage.keys':
      requirePermission(panel, 'storage')
      return Object.keys(readStore(storageFile(projectId, panel.key)))
    case 'storage.set': {
      requirePermission(panel, 'storage')
      const key = storeKey(list[0])
      if (list[1] === undefined) throw new Error('storage.set needs a value (use storage.remove to remove one).')
      const file = storageFile(projectId, panel.key)
      const data = readStore(file)
      data[key] = JSON.parse(JSON.stringify(list[1]))
      writeStore(file, data)
      return true
    }
    case 'storage.remove': {
      requirePermission(panel, 'storage')
      const file = storageFile(projectId, panel.key)
      const data = readStore(file)
      const had = storeKey(list[0]) in data
      delete data[list[0] as string]
      if (had) writeStore(file, data)
      return had
    }
    case 'records.requests':
      requirePermission(panel, 'records:read')
      return requests(projectId, list[0])
    case 'records.usage':
      requirePermission(panel, 'records:read')
      return usage(projectId, list[0])
    case 'records.handoffs':
      requirePermission(panel, 'records:read')
      return handoffs(projectId, list[0])
    case 'records.schedules':
      requirePermission(panel, 'records:read')
      return schedules(projectId)
    case 'commands.run':
      requirePermission(panel, 'commands')
      return runPluginCommand(projectId, panel.key, String(list[0] ?? ''), 'panel', list[1])
    case 'commands.runs':
      requirePermission(panel, 'commands')
      return pluginRuns(projectId, panel.key).filter((r) => list[0] === undefined || r.command === list[0])
    case 'notify': {
      requirePermission(panel, 'notify')
      const body = clip(list[0], 300).trim()
      if (!body) throw new Error('notify needs some text.')
      pluginNotify(projectId, panel.manifest.title, body)
      return true
    }
    case 'chat.draft': {
      requirePermission(panel, 'chat:draft')
      const text = clip(list[0], 4000)
      if (!text.trim()) throw new Error('chat.draft needs some text.')
      // Starwright's screen puts it in the message box; nothing is sent.
      return { draft: text }
    }
    default:
      throw new Error(`Starwright has no "${String(method).slice(0, 60)}" for plugins.`)
  }
}
