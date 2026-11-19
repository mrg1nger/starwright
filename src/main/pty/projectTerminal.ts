import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { PtySession } from './ptySession'

// The command line under a project's preview: the user's own shell (PowerShell on Windows), started
// in the project folder the first time the drawer opens. It keeps running while the drawer is folded
// away or another screen is open, and keeps its recent output, so opening it again (or from a phone
// over Remote access) shows what was there.

/** Output kept for a screen that opens the terminal later (about the last few hundred lines). */
const BACKLOG_CHARS = 200_000

interface ProjectTerminal {
  id: string
  projectId: string
  session: PtySession
  backlog: string
  exited: boolean
}

const byProject = new Map<string, ProjectTerminal>()
const byId = new Map<string, ProjectTerminal>()

export interface TerminalEvents {
  data: (id: string, data: string) => void
  exit: (id: string, exitCode: number) => void
}

/** The shell to start, and its arguments. */
export function terminalShell(platform = process.platform, env = process.env): { file: string; args: string[] } {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] }
  const shell = env.SHELL && existsSync(env.SHELL) ? env.SHELL : '/bin/bash'
  return { file: shell, args: ['-l'] }
}

/** Keeps the end of the output, cut at a line break so the first line isn't half a line. */
export function trimBacklog(text: string, max = BACKLOG_CHARS): string {
  if (text.length <= max) return text
  const cut = text.slice(text.length - max)
  const nl = cut.indexOf('\n')
  return nl >= 0 && nl < 2000 ? cut.slice(nl + 1) : cut
}

/** The project's terminal, started if it isn't running. Returns its id and the output so far. */
export function openTerminal(
  projectId: string,
  cwd: string,
  events: TerminalEvents,
  size: { cols?: number; rows?: number } = {}
): { id: string; backlog: string } {
  const running = byProject.get(projectId)
  if (running && !running.exited) return { id: running.id, backlog: running.backlog }
  if (running) closeTerminal(running.id)

  const { file, args } = terminalShell()
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color' }
  delete env.ELECTRON_RUN_AS_NODE
  const id = randomUUID()
  const session = new PtySession(id, { file, args, cwd, env, direct: true, cols: size.cols ?? 100, rows: size.rows ?? 12 })
  const terminal: ProjectTerminal = { id, projectId, session, backlog: '', exited: false }
  byProject.set(projectId, terminal)
  byId.set(id, terminal)
  session.on('data', (data: string) => {
    terminal.backlog = trimBacklog(terminal.backlog + data)
    events.data(id, data)
  })
  session.on('exit', (exitCode: number) => {
    terminal.exited = true
    events.exit(id, exitCode)
  })
  return { id, backlog: '' }
}

export function writeTerminal(id: string, data: string): void {
  const terminal = byId.get(id)
  if (terminal && !terminal.exited) terminal.session.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const terminal = byId.get(id)
  if (!terminal || terminal.exited) return
  const c = Math.max(10, Math.min(500, Math.floor(cols)))
  const r = Math.max(2, Math.min(200, Math.floor(rows)))
  if (Number.isFinite(c) && Number.isFinite(r)) terminal.session.resize(c, r)
}

/** Ends the shell and whatever it started (a dev server left running, say). */
export function closeTerminal(id: string): void {
  const terminal = byId.get(id)
  if (!terminal) return
  byId.delete(id)
  if (byProject.get(terminal.projectId) === terminal) byProject.delete(terminal.projectId)
  if (process.platform === 'win32' && !terminal.exited && terminal.session.pid) {
    try {
      // Synchronous: on quit the app exits before an async taskkill would run.
      execFileSync('taskkill', ['/pid', String(terminal.session.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 })
    } catch {
      // already gone
    }
  }
  try {
    terminal.session.dispose()
  } catch {
    // already gone
  }
}

export function closeProjectTerminal(projectId: string): void {
  const terminal = byProject.get(projectId)
  if (terminal) closeTerminal(terminal.id)
}

/** On quit: nothing keeps running after Starwright is closed. */
export function closeAllTerminals(): void {
  for (const id of [...byId.keys()]) closeTerminal(id)
}
