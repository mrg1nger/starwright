import { app } from 'electron'
import { execFile, execFileSync } from 'child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

// Previews left running. Stopping a preview stops everything it started, but only while Starwright
// is there to do it: after a crash, a forced close or an update restart, the dev servers keep
// running and hold their ports (a second "npm run dev" then fails with "Port 5173 is already in
// use"). So each preview's processes are written down while it runs, and anything still running
// from that list is stopped the next time Starwright opens (or the preview starts again).
// A process counts only if its id AND its start time match, so a reused process id is never hit.

export interface RecordedProcess {
  pid: number
  /** When it started (Windows file time), to tell it from a later process given the same id. */
  created: string
  name: string
}

export interface ProcessInfo extends RecordedProcess {
  ppid: number
}

type Records = Record<string, RecordedProcess[]>

const recordsFile = (): string => join(app.getPath('userData'), 'preview-processes.json')

function readRecords(): Records {
  try {
    if (existsSync(recordsFile())) return JSON.parse(readFileSync(recordsFile(), 'utf-8')) as Records
  } catch {
    // unreadable: nothing to go on
  }
  return {}
}

function writeRecords(records: Records): void {
  try {
    if (Object.keys(records).length) writeFileSync(recordsFile(), JSON.stringify(records), 'utf-8')
    else rmSync(recordsFile(), { force: true })
  } catch {
    // not fatal: at worst a leftover isn't cleaned up
  }
}

const LIST_SCRIPT =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId,$_.ParentProcessId,$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }),$_.Name }"

/** Every process on this computer, with its parent and start time (Windows only; elsewhere none). */
export function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  return new Promise((done) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT],
      { windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => done(err ? [] : parseProcessList(stdout))
    )
  })
}

export function parseProcessList(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = []
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, created, ...name] = line.trim().split('|')
    if (!pid || !/^\d+$/.test(pid) || !/^\d+$/.test(ppid ?? '') || !created || created === '0') continue
    out.push({ pid: Number(pid), ppid: Number(ppid), created, name: name.join('|') })
  }
  return out
}

/** The process and everything under it. */
export function treeOf(all: ProcessInfo[], rootPid: number): ProcessInfo[] {
  const root = all.find((p) => p.pid === rootPid)
  if (!root) return []
  const tree = [root]
  for (let i = 0; i < tree.length; i++) {
    for (const p of all) {
      // A child starts after its parent; a process whose parent id was reused by a newer one isn't its child.
      if (p.ppid === tree[i].pid && p.pid !== tree[i].pid && BigInt(p.created) >= BigInt(tree[i].created) && !tree.includes(p)) tree.push(p)
    }
  }
  return tree
}

/** The recorded processes that are still the same processes (id and start time both match). */
export function stillRunning(recorded: RecordedProcess[], all: ProcessInfo[]): RecordedProcess[] {
  return recorded.filter((r) => all.some((p) => p.pid === r.pid && p.created === r.created))
}

/**
 * Writes down the preview's processes as they are now (the server it started and everything that
 * server started), keeping any recorded earlier that are still running.
 */
export async function recordPreview(projectId: string, rootPid: number): Promise<void> {
  const all = await listProcesses()
  const tree = treeOf(all, rootPid)
  if (!tree.length) return
  const records = readRecords()
  const earlier = stillRunning(records[projectId] ?? [], all)
  const merged = [...tree.map(({ pid, created, name }) => ({ pid, created, name }))]
  for (const r of earlier) if (!merged.some((m) => m.pid === r.pid && m.created === r.created)) merged.push(r)
  records[projectId] = merged
  writeRecords(records)
}

/** A preview stopped cleanly: nothing of it to clean up later. */
export function forgetPreview(projectId: string): void {
  const records = readRecords()
  if (!(projectId in records)) return
  delete records[projectId]
  writeRecords(records)
}

function kill(pids: number[]): void {
  for (const pid of pids) {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 })
    } catch {
      // already gone
    }
  }
}

/**
 * Stops what's still running from earlier previews: all of them (when Starwright opens), or one
 * project's (before its preview starts again). Returns the names of what was stopped.
 */
export async function stopLeftoverPreviews(projectId?: string): Promise<string[]> {
  if (process.platform !== 'win32') return []
  const records = readRecords()
  const ids = projectId ? [projectId] : Object.keys(records)
  const recorded = ids.flatMap((id) => records[id] ?? [])
  if (!recorded.length) return []
  // Taken off the list first: a preview starting meanwhile records its own new processes.
  for (const id of ids) delete records[id]
  writeRecords(records)
  const alive = stillRunning(recorded, await listProcesses())
  kill(alive.map((p) => p.pid))
  return alive.map((p) => p.name)
}
