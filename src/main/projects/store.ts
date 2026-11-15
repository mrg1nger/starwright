import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { ProjectRecord } from '@shared/types'

interface ProjectsFile {
  projects: ProjectRecord[]
  /**
   * Projects taken off the list but with their data kept. Adding the same
   * folder again gets its old id back, so its history and memory return.
   */
  removed?: { id: string; path: string }[]
}

function storePath(): string {
  return join(app.getPath('userData'), 'projects.json')
}

function readStore(): ProjectsFile {
  const file = storePath()
  if (!existsSync(file)) return { projects: [] }
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as ProjectsFile
  } catch {
    return { projects: [] }
  }
}

function writeStore(data: ProjectsFile): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf-8')
}

export function listProjects(): ProjectRecord[] {
  return readStore().projects.sort((a, b) => b.lastOpened.localeCompare(a.lastOpened))
}

function samePath(a: string, b: string): boolean {
  // A hand-edited or partly written entry may have no path: it matches nothing.
  if (!a || !b) return false
  const norm = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * Takes a project off the list. Never touches the project's folder.
 * keepData: remember its id so re-adding the folder brings its history back.
 */
export function removeProject(projectId: string, keepData: boolean): ProjectRecord | undefined {
  const data = readStore()
  const project = data.projects.find((p) => p.id === projectId)
  if (!project) return undefined
  data.projects = data.projects.filter((p) => p.id !== projectId)
  const others = (data.removed ?? []).filter((r) => r.id !== projectId && !samePath(r.path, project.path))
  data.removed = keepData ? [{ id: project.id, path: project.path }, ...others].slice(0, 200) : others
  writeStore(data)
  return project
}

export function recordProjectOpened(path: string): ProjectRecord {
  const data = readStore()
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
  const existing = data.projects.find((p) => p.path === path)
  const kept = data.removed?.find((r) => samePath(r.path, path))

  const record: ProjectRecord = existing
    ? { ...existing, lastOpened: new Date().toISOString() }
    : { id: kept?.id ?? randomUUID(), path, name, lastOpened: new Date().toISOString() }

  data.projects = [record, ...data.projects.filter((p) => p.path !== path)]
  if (kept) data.removed = data.removed!.filter((r) => r !== kept)
  writeStore(data)
  return record
}

/**
 * Points a project at the folder it now lives in (another computer after a restore, or a
 * moved folder), keeping its id, so its memory, chats, notes and to-dos stay with it.
 * The old Claude Code session is dropped: it belongs to the old folder (and usually the old computer).
 */
export function relocateProject(projectId: string, newPath: string): ProjectRecord {
  const data = readStore()
  const project = data.projects.find((p) => p.id === projectId)
  if (!project) throw new Error("That project isn't in the list any more.")
  const other = data.projects.find((p) => p.id !== projectId && samePath(p.path, newPath))
  if (other) {
    throw new Error(
      `That folder is already in the list as “${other.name}”. Remove that one from the list first (choose whether to keep or erase its data), then try again.`
    )
  }
  project.path = newPath
  project.name = newPath.split(/[\\/]/).filter(Boolean).pop() ?? newPath
  project.lastOpened = new Date().toISOString()
  delete project.sdkSessionId
  // A removed project that used this folder must not claim it later.
  if (data.removed) data.removed = data.removed.filter((r) => !samePath(r.path, newPath))
  writeStore(data)
  return project
}

/** Remembers a project's GitHub address, so it can be downloaded again where its folder is missing. */
export function setGitHubUrls(urls: Map<string, string>): void {
  if (!urls.size) return
  const data = readStore()
  let changed = false
  for (const p of data.projects) {
    const url = urls.get(p.id)
    if (url && p.githubUrl !== url) {
      p.githubUrl = url
      changed = true
    }
  }
  if (changed) writeStore(data)
}

export function setSdkSessionId(projectId: string, sdkSessionId: string): void {
  const data = readStore()
  const project = data.projects.find((p) => p.id === projectId)
  if (!project) return
  project.sdkSessionId = sdkSessionId
  writeStore(data)
}

export function getProject(projectId: string): ProjectRecord | undefined {
  return readStore().projects.find((p) => p.id === projectId)
}

export function setGoNutzMode(projectId: string, enabled: boolean): void {
  const data = readStore()
  const project = data.projects.find((p) => p.id === projectId)
  if (!project) return
  project.goNutzMode = enabled
  writeStore(data)
}

export function setGitHubAutoBackup(projectId: string, enabled: boolean): void {
  const data = readStore()
  const project = data.projects.find((p) => p.id === projectId)
  if (!project) return
  project.githubAutoBackup = enabled
  writeStore(data)
}

export function setGitHubLastBackup(projectId: string, at: string): void {
  const data = readStore()
  const project = data.projects.find((p) => p.id === projectId)
  if (!project) return
  project.githubLastBackupAt = at
  writeStore(data)
}

export function setDeployUrl(projectId: string, url: string): void {
  const data = readStore()
  const project = data.projects.find((p) => p.id === projectId)
  if (!project) return
  project.deployUrl = url
  writeStore(data)
}
