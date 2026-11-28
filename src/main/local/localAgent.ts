import { spawn } from 'child_process'
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { OUTSIDE_PROJECT, commandDanger } from '../cline/hookPolicy'
import { killTree, trackChild } from '../cli/codexExec'
import { bashPath } from '../deploy/deploy'
import { countsFromChatUsage, ensureModelLoaded, holdModel, lmStudioBase, lmStudioStatus, pickModel, type ModelReady } from '../cli/lmStudio'
import { getSettings } from '../settings/store'
import { maskText } from '../secrets/maskSecrets'
import type { TokenCounts } from '../usage/tokens'
import type { DelegationActivity, LiveTokens } from '@shared/types'
import { fileTimeOf, listProcesses, startedBy, stopProcesses, type RecordedProcess } from '../preview/leftovers'
import { StreamStopped, progressText, stepSummary, streamChat, type StreamedReply, type ToolCall } from './chatStream'

// VibeApp's own coding agent, on a model in LM Studio. The model can only ask
// for one of the tools below; VibeApp carries each request out itself, after
// the same checks Cline's runs get (inside the project, nothing destructive,
// no pushing). Nothing else is reachable: there are no other tools to misuse.
//
// Codex on LM Studio was tried first (2026-11-14): Codex puts system messages
// mid-conversation, which Qwen's chat template refuses, so every request failed.

export interface LocalAgentRun {
  task: string
  /** The project folder: every path and command stays inside it. */
  cwd: string
  /** Go Nutz: commands may reach outside the project (pushing and account changes still can't). */
  goNutz?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  /** Most model turns before it's stopped. */
  maxSteps?: number
  /** Let the model think before each step. Off by default: on the eval (2026-11-14) it scored the same at about half the speed. */
  thinking?: boolean
  model?: string
  onActivity?: (activity: DelegationActivity) => void
  /** Tokens so far: estimated while a step runs, exact once it ends. */
  onTokens?: (tokens: LiveTokens) => void
  /** Extra environment variables for its commands: the project's secrets, as Claude has them. */
  env?: Record<string, string>
  /** TEMP, TMP and TMPDIR for its commands: a private folder (see helperTemp). Not secrets: never masked. */
  temp?: Record<string, string>
  /** Asks the user about a command that only failed the folder check (Allow/Deny), as for Claude. None: refused. */
  ask?: (command: string) => Promise<boolean>
  /** Set by runLocalAgent: when the run must end, and what its commands left running in the background. */
  deadline?: number
  leftBehind?: RecordedProcess[]
  /** Reading the context for longer than this, with it more than half full, twice in a row, hands the task over (for tests; SLOW_STEP_MS otherwise). */
  slowStepMs?: number
  /** No output for this long part-way through a reply ends the run (for tests; STALL_MS otherwise). */
  stallMs?: number
  /** A step running longer than this gets a live line in the hand-off (for tests; PROGRESS_AFTER_MS otherwise). */
  progressAfterMs?: number
  /** Lets LM Studio's model be unloaded again once the run is over. */
  releaseModel?: () => void
}

export interface LocalAgentResult {
  ok: boolean
  /** The model's final report. */
  text: string
  error?: string
  model?: string
  steps: number
  usage: TokenCounts
  /** What VibeApp refused, in plain words. */
  blocked: string[]
}

const SYSTEM = `You are a coding agent working for Claude inside Starwright, on the user's project in the current folder. You can only act through the tools. Work like this:
1. Look before you change: find the right files (list_files, search) and read the parts you need.
2. Make the change with edit_file (exact text from the file, enough lines to be unique) or write_file for new files.
3. Check it the way the task says (run the tests it names with run_command). If something fails, fix it and check again.
4. When done, reply WITHOUT calling a tool: a short report of what you changed, file by file, and how the checks went.
Rules: paths are relative to the project folder. Stay inside the project. Don't start servers or watchers that keep running (commands time out). Some commands are refused by Starwright (deleting folders, pushing, anything outside the project): if a result says "BLOCKED by Starwright", don't try another way, say in your report what was needed. Keep going until the task is done or you are truly stuck; then say what's left.`

const TOOLS = [
  {
    name: 'list_files',
    description: 'List files and folders under a folder of the project (dependency and build folders are skipped).',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder, relative to the project. Default: the project folder.' } } }
  },
  {
    name: 'read_file',
    description: 'Read a text file. Long files come back in parts: pass start_line to read further.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, start_line: { type: 'integer', description: 'First line to read (1-based). Default 1.' } },
      required: ['path']
    }
  },
  {
    name: 'search',
    description: 'Search the project\'s text files for a word or phrase (case-insensitive). Returns file:line: text for each match.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, path: { type: 'string', description: 'Only under this folder.' } },
      required: ['query']
    }
  },
  {
    name: 'edit_file',
    description: 'Replace text in a file. old_text must be copied exactly from the file and appear once (include surrounding lines to make it unique), unless replace_all is true.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } },
      required: ['path', 'old_text', 'new_text']
    }
  },
  {
    name: 'write_file',
    description: 'Create a file, or replace a whole file, with this content. Folders are created as needed.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
  },
  {
    name: 'run_command',
    description: 'Run a shell command (bash) in the project folder and get its output, e.g. npm test or node script.js. Times out after 2 minutes unless timeout_seconds says otherwise (at most 10 minutes).',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, timeout_seconds: { type: 'integer' } },
      required: ['command']
    }
  }
].map((f) => ({ type: 'function' as const, function: f }))

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', 'release', '.next', 'coverage', '.venv', 'venv', '__pycache__', 'test-results', '.cache'])
const READ_LINES = 400
const OUTPUT_CHARS = 12_000
const MAX_FILE_BYTES = 1_000_000

/** Where a path the model gave points, or null when it's outside the project. */
export function projectPath(cwd: string, path: unknown): string | null {
  if (typeof path !== 'string' || !path.trim()) return null
  const full = resolve(cwd, path.trim())
  const rel = relative(resolve(cwd), full)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return full
}

function shown(cwd: string, full: string): string {
  return relative(cwd, full).split(sep).join('/') || '.'
}

function clip(text: string, max = OUTPUT_CHARS): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.25)
  return `${text.slice(0, head)}\n… (${text.length - max} characters left out) …\n${text.slice(text.length - (max - head))}`
}

function isText(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8000).includes(0)
}

function walk(root: string, each: (file: string) => boolean | void, limit = 5000): void {
  let count = 0
  const visit = (dir: string): boolean => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return true
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        if (!visit(resolve(dir, e.name))) return false
      } else if (e.isFile()) {
        if (++count > limit || each(resolve(dir, e.name)) === false) return false
      }
    }
    return true
  }
  visit(root)
}

/**
 * Replaces old with new in content. Exact first; then, for text quoted with
 * different line endings or trailing spaces, a line-by-line match ignoring them.
 */
export function applyEdit(content: string, oldText: string, newText: string, all = false): { content: string } | { error: string } {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const body = content.replace(/\r\n/g, '\n')
  const from = oldText.replace(/\r\n/g, '\n')
  const to = newText.replace(/\r\n/g, '\n')
  if (!from) return { error: 'old_text is empty. To create or replace a whole file, use write_file.' }
  const count = body.split(from).length - 1
  let next: string | undefined
  if (count === 1 || (count > 1 && all)) next = body.split(from).join(to)
  else if (count > 1) return { error: `old_text appears ${count} times. Include more surrounding lines so it appears once, or set replace_all.` }
  else {
    const lines = body.split('\n')
    const want = from.replace(/\n$/, '').split('\n').map((l) => l.trimEnd())
    const starts: number[] = []
    for (let i = 0; i + want.length <= lines.length; i++) {
      if (want.every((w, j) => lines[i + j].trimEnd() === w)) starts.push(i)
    }
    if (starts.length !== 1) {
      return {
        error: starts.length
          ? `old_text appears ${starts.length} times. Include more surrounding lines so it appears once.`
          : 'old_text was not found in the file. Read the file again and copy the text exactly.'
      }
    }
    const i = starts[0]
    next = [...lines.slice(0, i), ...to.replace(/\n$/, '').split('\n'), ...lines.slice(i + want.length)].join('\n')
  }
  return { content: eol === '\n' ? next : next.replace(/\n/g, '\r\n') }
}

interface ToolOutcome {
  text: string
  activity: Omit<DelegationActivity, 'id' | 'done'>
  blocked?: string
}

/**
 * Git's bin\bash.exe only starts usr\bin\bash.exe and ends; that one ends too once the command has,
 * which leaves nothing linking a background process to the command that started it. Running the
 * real bash directly keeps that link, so what a command leaves running can be found and stopped.
 */
function realBash(bash: string | undefined): string | undefined {
  if (!bash || process.platform !== 'win32') return bash
  const dir = dirname(bash)
  // Git\bin\bash.exe (not Git\usr\bin\bash.exe, which is already the real one).
  const launcher = basename(dir).toLowerCase() === 'bin' && basename(dirname(dir)).toLowerCase() !== 'usr'
  const real = join(dirname(dir), 'usr', 'bin', 'bash.exe')
  return launcher && existsSync(real) ? real : bash
}

/** How long to wait for a command's output to end after the command itself has. */
const OUTPUT_GRACE_MS = 1_500

export interface ShellResult {
  code: number | null
  output: string
  timedOut: boolean
  /** Something the command started is still running in the background (a server, say). */
  background: boolean
}

/**
 * Runs one command and always comes back: when it ends, when its time is up, or when the run is
 * stopped. A command that starts something in the background (`npm run dev &`) ends while that
 * process keeps its output open, which used to leave the run waiting for ever; now the run carries
 * on after a moment, and what was left running goes into `leftBehind` to be stopped when the run ends.
 */
export function runShell(
  command: string,
  cwd: string,
  timeoutSec: number,
  signal?: AbortSignal,
  extra: Record<string, string> = {},
  leftBehind?: RecordedProcess[]
): Promise<ShellResult> {
  return new Promise((done) => {
    const startedAt = Date.now() - 1_000
    const bash = realBash(bashPath())
    const child = trackChild(
      bash
        ? spawn(bash, ['-lc', command], { cwd, env: { ...process.env, ...extra, MSYSTEM: process.env.MSYSTEM ?? 'MINGW64', CHERE_INVOKING: '1', CI: '1' }, windowsHide: true })
        : spawn(command, { cwd, shell: true, env: { ...process.env, ...extra, CI: '1' }, windowsHide: true })
    )
    let output = ''
    const add = (d: Buffer): void => {
      output += d.toString()
      if (output.length > 400_000) output = output.slice(-200_000)
    }
    child.stdout?.on('data', add)
    child.stderr?.on('data', add)
    let timedOut = false
    let finished = false
    let grace: NodeJS.Timeout | undefined
    // What the command started and left running (found after it has ended).
    const collectLeftovers = async (stopNow: boolean): Promise<boolean> => {
      if (!child.pid) return false
      const found = startedBy(await listProcesses(), child.pid, fileTimeOf(startedAt)).map(({ pid, created, name }) => ({ pid, created, name }))
      if (stopNow) await stopProcesses(found)
      else leftBehind?.push(...found)
      return found.length > 0
    }
    const finish = (code: number | null, background = false): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (grace) clearTimeout(grace)
      signal?.removeEventListener('abort', onAbort)
      // Stop listening: a background process may keep these open for as long as it runs.
      child.stdout?.destroy()
      child.stderr?.destroy()
      done({ code, output, timedOut, background })
    }
    // Ended, but its output is still open: something it started is still running.
    const endWithoutOutput = (code: number | null): void => {
      if (finished) return
      const stopNow = timedOut || !!signal?.aborted
      void collectLeftovers(stopNow)
        .catch(() => false)
        .then((background) => finish(code, background && !stopNow))
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      grace = setTimeout(() => endWithoutOutput(null), OUTPUT_GRACE_MS * 2)
    }, timeoutSec * 1000)
    const onAbort = (): void => {
      killTree(child)
      endWithoutOutput(null)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (err) => {
      output += `\n${err.message}`
      finish(null)
    })
    child.once('exit', (code) => {
      if (!grace) grace = setTimeout(() => endWithoutOutput(code), OUTPUT_GRACE_MS)
    })
    child.once('close', (code) => finish(code))
  })
}

async function runTool(name: string, args: Record<string, unknown>, run: LocalAgentRun): Promise<ToolOutcome> {
  const { cwd } = run
  const outside = (what: string): ToolOutcome => ({
    text: `BLOCKED by Starwright: ${what} is outside the project folder. Use a path inside the project.`,
    activity: { step: 'tool', text: `Refused: ${what} (outside the project)`, ok: false },
    blocked: `${what} outside the project`
  })
  switch (name) {
    case 'list_files': {
      const dir = projectPath(cwd, args.path ?? '.')
      if (!dir) return outside(String(args.path))
      if (!existsSync(dir)) return { text: `No folder ${shown(cwd, dir)}.`, activity: { step: 'tool', text: `Listed ${shown(cwd, dir)} (missing)`, ok: false } }
      const files: string[] = []
      walk(dir, (f) => {
        files.push(shown(cwd, f))
      }, 400)
      return {
        text: files.length ? `${files.join('\n')}${files.length >= 400 ? '\n… (more files; list a sub-folder)' : ''}` : '(no files)',
        activity: { step: 'tool', text: `Listed ${shown(cwd, dir)}`, ok: true }
      }
    }
    case 'read_file': {
      const file = projectPath(cwd, args.path)
      if (!file) return outside(String(args.path))
      const label = shown(cwd, file)
      if (!existsSync(file) || !statSync(file).isFile()) return { text: `No file ${label}.`, activity: { step: 'tool', text: `Read ${label} (missing)`, ok: false } }
      const buffer = readFileSync(file)
      if (!isText(buffer)) return { text: `${label} isn't a text file.`, activity: { step: 'tool', text: `Read ${label} (not text)`, ok: false } }
      const lines = buffer.toString('utf8').replace(/\r\n/g, '\n').split('\n')
      const start = Math.max(1, Math.floor(Number(args.start_line) || 1))
      const end = Math.min(lines.length, start + READ_LINES - 1)
      const part = clip(lines.slice(start - 1, end).join('\n'), 30_000)
      const note = start > 1 || end < lines.length ? `(${label}: lines ${start}-${end} of ${lines.length}${end < lines.length ? `; read on with start_line ${end + 1}` : ''})\n` : ''
      return { text: `${note}${part}`, activity: { step: 'tool', text: `Read ${label}`, ok: true } }
    }
    case 'search': {
      const query = String(args.query ?? '').toLowerCase()
      if (!query) return { text: 'Give a query to search for.', activity: { step: 'tool', text: 'Searched (no query)', ok: false } }
      const dir = projectPath(cwd, args.path ?? '.')
      if (!dir) return outside(String(args.path))
      const hits: string[] = []
      walk(dir, (f) => {
        try {
          if (statSync(f).size > MAX_FILE_BYTES) return
          const buffer = readFileSync(f)
          if (!isText(buffer)) return
          const lines = buffer.toString('utf8').split(/\r?\n/)
          for (let i = 0; i < lines.length && hits.length < 100; i++) {
            if (lines[i].toLowerCase().includes(query)) hits.push(`${shown(cwd, f)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          }
        } catch {
          // unreadable: skip
        }
        return hits.length < 100
      })
      return {
        text: hits.length ? `${hits.join('\n')}${hits.length >= 100 ? '\n… (more matches; search a sub-folder or a longer phrase)' : ''}` : 'No matches.',
        activity: { step: 'tool', text: `Searched for "${String(args.query).slice(0, 60)}"`, ok: true }
      }
    }
    case 'edit_file':
    case 'write_file': {
      const file = projectPath(cwd, args.path)
      if (!file) return outside(String(args.path))
      const label = shown(cwd, file)
      if (label === '.' || (existsSync(file) && statSync(file).isDirectory())) {
        return { text: 'Give the path of a file, not a folder.', activity: { step: 'edit', text: `Edit of ${label} (a folder)`, ok: false } }
      }
      if (/(^|\/)\.git(\/|$)/.test(label)) {
        return { text: 'BLOCKED by Starwright: the .git folder is not to be changed.', activity: { step: 'edit', text: `Refused: changing ${label}`, ok: false }, blocked: `changing ${label}` }
      }
      const existed = existsSync(file)
      if (name === 'write_file') {
        if (typeof args.content !== 'string') return { text: 'Missing content.', activity: { step: 'edit', text: `Write of ${label} (nothing given)`, ok: false } }
        // Writing a file again with what it already holds (on Lazarus the local model rewrote the
        // same failing script five times running) changes nothing: say so, so it tries something else.
        if (existed && readFileSync(file, 'utf8') === args.content) {
          return {
            text: `${label} already has exactly this content: writing it again changes nothing. If it isn't working, the problem is elsewhere; if you can't get past it, stop and say in your report what's left.`,
            activity: { step: 'edit', text: `Rewrote ${label} (no change)`, ok: true }
          }
        }
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, args.content, 'utf8')
        return { text: `${existed ? 'Replaced' : 'Created'} ${label}.`, activity: { step: 'edit', text: `${existed ? 'Rewrote' : 'Created'} ${label}`, ok: true } }
      }
      if (!existed) return { text: `No file ${label}. Use write_file to create it.`, activity: { step: 'edit', text: `Edit of ${label} (missing)`, ok: false } }
      const result = applyEdit(readFileSync(file, 'utf8'), String(args.old_text ?? ''), String(args.new_text ?? ''), args.replace_all === true)
      if ('error' in result) return { text: result.error, activity: { step: 'edit', text: `Edit of ${label} didn't apply`, ok: false } }
      writeFileSync(file, result.content, 'utf8')
      return { text: `Edited ${label}.`, activity: { step: 'edit', text: `Edited ${label}`, ok: true } }
    }
    case 'run_command': {
      const command = String(args.command ?? '').trim()
      if (!command) return { text: 'Give a command.', activity: { step: 'run', text: 'Command (empty)', ok: false } }
      let danger = commandDanger(command, { mode: 'build', projectPath: cwd, goNutz: run.goNutz, dataPaths: [app.getPath('userData')] })
      // Only the folder check failed: the user decides, as for Claude's commands.
      if (danger === OUTSIDE_PROJECT && run.ask && (await run.ask(command).catch(() => false))) danger = null
      if (danger) {
        return {
          text: `BLOCKED by Starwright: ${danger} is not allowed in this run. Do not try another way round it; say in your report that it needs the user.`,
          activity: { step: 'run', text: command.slice(0, 120), full: command, detail: `Refused: ${danger}`, ok: false },
          blocked: danger
        }
      }
      // Never past the end of the whole run.
      const left = Math.floor(((run.deadline ?? Infinity) - Date.now()) / 1000)
      const timeout = Math.max(5, Math.min(600, left, Math.floor(Number(args.timeout_seconds) || 120)))
      const result = await runShell(command, cwd, timeout, run.signal, { ...(run.env ?? {}), ...(run.temp ?? {}) }, run.leftBehind)
      // The command has the project's secrets; what it printed doesn't show them (`env`, a config dump).
      // Only here: a file's contents stay as they are, or an edit could write the label into the file.
      result.output = maskText(result.output, Object.entries(run.env ?? {}).map(([name, value]) => ({ name, value })))
      const output = clip(result.output.trim() || '(no output)')
      const status = result.timedOut
        ? `Stopped after ${timeout} s (still running).`
        : `Exit code ${result.code}.${result.background ? " Something it started is still running in the background (a server, say); Starwright stops it when this task ends. Don't wait for it or start it again." : ''}`
      return {
        text: `${status}\n${output}`,
        activity: { step: 'run', text: command.split('\n')[0].slice(0, 120), full: command, detail: clip(result.output.trim(), 2000), ok: result.code === 0 && !result.timedOut }
      }
    }
    default:
      return { text: `There is no tool called ${name}. Use list_files, read_file, search, edit_file, write_file or run_command.`, activity: { step: 'tool', text: `Unknown tool ${name}`, ok: false } }
  }
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

const TRIMMED = '[Earlier output removed to save room. Read or run it again if you still need it.]'

/**
 * Shrinks older tool results once the conversation fills much of the model's context. With labels
 * (tool call id → "read_file src/a.js"), the note says what was removed, so the model knows what it
 * has lost instead of reading everything again.
 */
export function trimConversation(
  messages: Message[],
  keepRecent = 6,
  labels?: Map<string, string>,
  onTrim?: (toolCallId: string) => void
): number {
  const tools = messages.map((m, i) => (m.role === 'tool' && !m.content.startsWith('[Earlier output ') ? i : -1)).filter((i) => i >= 0)
  let trimmed = 0
  for (const i of tools.slice(0, Math.max(0, tools.length - keepRecent))) {
    const label = messages[i].tool_call_id ? labels?.get(messages[i].tool_call_id!) : undefined
    messages[i] = { ...messages[i], content: label ? trimmedNote(label) : TRIMMED }
    if (messages[i].tool_call_id) onTrim?.(messages[i].tool_call_id!)
    trimmed++
  }
  return trimmed
}

function trimmedNote(label: string): string {
  return `[Earlier output removed to save room: ${label}. Read again only the lines you still need, and get on with the change: reading the same files over and over ends the run.]`
}

/** How often the same part of a file may be read before the run is stopped (an edit to the file resets it). */
export const MAX_READS_OF_A_PART = 3
/** Re-reads in all before the run is stopped: the task needs more than fits in the model's context. */
export const MAX_REREADS = 8
/**
 * Reads of parts whose earlier read was removed to save room, before the run is stopped. Needing
 * back a few lines it lost is fine; reading a batch of them again means the task doesn't fit in the
 * model's context, and it would only lose them again (it read 20 files, lost 8, and read those 8
 * again until the time ran out).
 */
export const MAX_DROPPED_REREADS = 3
/**
 * Reading the context for longer than this before writing anything, while it is more than half
 * full, means the model is wading through more than it can handle: on Lazarus (2026-11-19) such
 * steps took 2-2½ minutes, so only a few fit before the time ran out, and Cline then did the whole
 * task in 30 seconds. Only the reading counts (the time to the first token): writing a big file at
 * 11 tokens a second takes minutes and is fine. It takes SLOW_READS_TO_HAND_OVER such steps in a
 * row; the first step (which may load the model) and the step after trimming (which reads the
 * whole conversation again, once) don't count.
 */
export const SLOW_STEP_MS = 90_000
export const SLOW_READS_TO_HAND_OVER = 2
/** Nothing for this long part-way through a reply: the model has stopped. */
export const STALL_MS = 120_000
/** A step running longer than this gets a live line in the hand-off: reading, about N%, or writing at N tok/s. */
export const PROGRESS_AFTER_MS = 5_000

/**
 * Counts the model's reads, to spot it cycling through files it has already read (A, B, C, A, B, C):
 * each read is new to the check for one call in a row, so that alone never stops it, and it would
 * read until the time ran out. Reading a file again after changing it is fine.
 */
export class ReadTracker {
  private parts = new Map<string, number>()
  private rereads = 0
  /** Parts whose read was removed from the conversation to save room. */
  private lost = new Set<string>()
  private lostRereads = 0

  private static key(path: unknown, startLine: unknown): string {
    return `${String(path ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()}:${Math.max(1, Math.floor(Number(startLine) || 1))}`
  }

  /** A read of the file from start_line: how many times that part has now been read, and whether it's time to stop. */
  read(path: unknown, startLine: unknown): { times: number; stop: boolean } {
    const key = ReadTracker.key(path, startLine)
    const times = (this.parts.get(key) ?? 0) + 1
    this.parts.set(key, times)
    if (times > 1) this.rereads++
    if (this.lost.delete(key)) this.lostRereads++
    return {
      times,
      stop: times > MAX_READS_OF_A_PART || this.rereads > MAX_REREADS || this.lostRereads > MAX_DROPPED_REREADS
    }
  }

  /** That read's output was removed to save room. */
  dropped(path: unknown, startLine: unknown): void {
    this.lost.add(ReadTracker.key(path, startLine))
  }

  /** The file changed: reading it again is checking the change, not going round in circles. */
  changed(path: unknown): void {
    const prefix = ReadTracker.key(path, 1).replace(/:1$/, ':')
    for (const key of [...this.parts.keys()]) if (key.startsWith(prefix)) this.parts.delete(key)
    for (const key of [...this.lost]) if (key.startsWith(prefix)) this.lost.delete(key)
  }

  /** The files read most often, for the message when the run is stopped. */
  mostRead(): string {
    const byFile = new Map<string, number>()
    for (const [key, times] of this.parts) {
      const file = key.replace(/:\d+$/, '')
      byFile.set(file, (byFile.get(file) ?? 0) + times)
    }
    return [...byFile].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, n]) => `${f} ${n}×`).join(', ')
  }
}

/** Runs one task to the end on LM Studio's model. Never throws: failures come back in the result. */
export async function runLocalAgent(task: LocalAgentRun): Promise<LocalAgentResult> {
  const run: LocalAgentRun = { ...task, deadline: Date.now() + (task.timeoutMs ?? 15 * 60_000), leftBehind: [] }
  try {
    return await runModel(run)
  } finally {
    run.releaseModel?.()
    // Servers its commands started in the background end with the task.
    const stopped = await stopProcesses(run.leftBehind!).catch(() => [] as string[])
    if (stopped.length) run.onActivity?.({ id: 'local-cleanup', done: true, step: 'run', text: `Stopped what the task left running (${stopped.join(', ')})`, ok: true })
  }
}

async function runModel(run: LocalAgentRun): Promise<LocalAgentResult> {
  const settings = getSettings()
  const base = lmStudioBase(settings.lmStudioUrl)
  const usage: TokenCounts = { fresh: 0, cached: 0, output: 0, steps: 0 }
  const blocked: string[] = []
  const deadline = run.deadline!
  const maxSteps = run.maxSteps ?? 60
  const fail = (error: string, steps: number, model?: string, text = ''): LocalAgentResult => ({ ok: false, text, error, model, steps, usage, blocked })

  const status = await lmStudioStatus(base)
  if (!status.running) return fail(status.error ?? 'LM Studio is not running.', 0)
  const model = run.model ?? pickModel(status.models, settings.lmStudioModel)
  if (!model) return fail('LM Studio has no chat model downloaded.', 0)
  let activityId = 0
  const emit = (a: Omit<DelegationActivity, 'id' | 'done'>, done = true): void => run.onActivity?.({ id: `local-${++activityId}`, done, ...a })
  let ready: ModelReady
  try {
    ready = await ensureModelLoaded(model, (size) =>
      emit({ step: 'tool', text: size ? `Loading ${model} in LM Studio (${size.toLocaleString()} tokens of context)…` : `Waiting for LM Studio to load ${model}…` }, false)
    )
  } catch (err) {
    return fail((err as Error).message, 0, model)
  }
  // Not unloaded for being idle while this task is using it.
  run.releaseModel = holdModel(model)
  if (ready.loadedNow) {
    emit({ step: 'tool', text: `Loaded ${model} in LM Studio${ready.seconds ? ` in ${Math.round(ready.seconds)} s` : ''} (${(ready.contextLength ?? 0).toLocaleString()} tokens of context)`, ok: true })
  }
  const listed = status.models.find((m) => m.id === model)
  // Only a loaded model's size is its real one (otherwise it's the most the model supports).
  let context = ready.contextLength ?? (listed?.loaded ? listed.contextLength : undefined)
  const contextKnown = context !== undefined
  context ??= 8_192

  const messages: Message[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: run.task }
  ]
  let lastCall = ''
  let repeats = 0
  /** The tool it got stuck calling over and over, once it has been asked to stop and report. */
  let stuckOn: string | undefined
  let nudged = false
  const reads = new ReadTracker()
  /** What each tool result was, for the note that replaces it when it's trimmed. */
  const labels = new Map<string, string>()
  /** Which part of which file each read_file call read, to tell the tracker when its output is trimmed. */
  const readOf = new Map<string, { path: unknown; startLine: unknown }>()
  const onTrim = (id: string): void => {
    const part = readOf.get(id)
    if (part) reads.dropped(part.path, part.startLine)
  }

  const slowLimit = run.slowStepMs ?? SLOW_STEP_MS
  const progressAfter = run.progressAfterMs ?? PROGRESS_AFTER_MS
  const slowMessage = (readMs: number, full: number): string =>
    `The local model got slow reading its context (${Math.round(readMs / 1000)} s before it wrote anything, on more than one step, with its ${context!.toLocaleString()} tokens of context ${Math.round(full * 100)}% full): the task needs more than it can work through in time. Hand it to another agent, or split it into smaller tasks.`
  /** How full the context was at the last request. */
  let lastFull = 0
  /** Steps in a row that read for longer than slowLimit. */
  let slowReads = 0
  /** The conversation was trimmed after the last step, so this one reads all of it again. */
  let trimmedBefore = false
  /** The conversation's size at the last request, to estimate what's new to read. */
  let lastChars = 0
  /** Tokens a second it reads at, from earlier steps, for the "about N%" while it reads. */
  let readRate = 0

  for (let step = 1; step <= maxSteps; step++) {
    if (run.signal?.aborted) return fail('The local model run was cancelled.', step - 1, model)
    const left = deadline - Date.now()
    if (left <= 0) return fail('The local model ran out of time.', step - 1, model)
    // Only a later step with the context more than half full, and nothing trimmed since, is held to the limit.
    const watched = step > 1 && lastFull > 0.5 && !trimmedBefore
    const chars = JSON.stringify(messages).length
    const toRead = Math.round((trimmedBefore ? chars : Math.max(0, chars - lastChars)) / 3.5)
    lastChars = chars
    const liveId = `local-live-${step}`
    let live = false
    let streamed: StreamedReply
    try {
      streamed = await streamChat(
        `${base}/v1/chat/completions`,
        { model, messages, tools: TOOLS, temperature: 0.2, ...(run.thinking ? {} : { reasoning_effort: 'none' }) },
        {
          signal: run.signal ? AbortSignal.any([run.signal, AbortSignal.timeout(left)]) : AbortSignal.timeout(left),
          // The step that would make it slow twice in a row ends as soon as it's clear, rather than reading on.
          readLimitMs: watched && slowReads + 1 >= SLOW_READS_TO_HAND_OVER ? slowLimit : undefined,
          stallMs: run.stallMs ?? STALL_MS,
          progressEveryMs: Math.max(10, Math.min(2000, progressAfter)),
          onProgress: (p) => {
            run.onTokens?.({ read: usage.fresh + usage.cached + Math.round(chars / 3.5), written: usage.output + p.pieces, steps: step })
            if (p.elapsedMs < progressAfter) return
            live = true
            run.onActivity?.({ id: liveId, step: 'tool', done: false, text: progressText(p, readRate ? { tokens: toRead, perSecond: readRate } : undefined) })
          }
        }
      )
    } catch (err) {
      const end = (text: string): void => {
        if (live) run.onActivity?.({ id: liveId, step: 'tool', done: true, ok: false, text })
      }
      if (err instanceof StreamStopped) {
        end(err.why === 'slow-read' ? `Local model still reading after ${Math.round(err.afterMs / 1000)} s` : `Local model stopped writing for ${Math.round(err.afterMs / 1000)} s`)
        if (err.why === 'slow-read') return fail(slowMessage(err.afterMs, lastFull), step, model)
        return fail(
          `The local model stopped responding (nothing for ${Math.round(err.afterMs / 1000)} s part-way through a reply). Hand it to another agent, or try again.`,
          step,
          model
        )
      }
      end('Local model step ended')
      if (run.signal?.aborted) return fail('The local model run was cancelled.', step - 1, model)
      return fail((err as Error).name === 'TimeoutError' ? 'The local model ran out of time.' : `Couldn't reach LM Studio (${(err as Error).message}).`, step - 1, model)
    }
    const { reply, firstTokenMs, totalMs } = streamed
    const counts = countsFromChatUsage(reply.usage)
    usage.fresh += counts.fresh
    usage.cached += counts.cached
    usage.output += counts.output
    usage.steps = step
    run.onTokens?.({ read: usage.fresh + usage.cached, written: usage.output, steps: step })
    if (live) run.onActivity?.({ id: liveId, step: 'tool', done: true, ok: true, text: stepSummary(firstTokenMs, totalMs, counts.output, toRead) })
    if (reply.error) {
      const message = typeof reply.error === 'string' ? reply.error : (reply.error.message ?? 'unknown error')
      return fail(`LM Studio refused the request: ${message.slice(0, 300)}`, step, model)
    }
    const choice = reply.choices?.[0]
    const said = (choice?.message?.content ?? '').trim()
    const calls = choice?.message?.tool_calls ?? []
    // The reading time: until the first token when it streamed, the whole step otherwise.
    const readMs = firstTokenMs ?? totalMs
    if (firstTokenMs !== undefined && readMs >= 1000 && toRead >= 200) {
      const rate = toRead / (readMs / 1000)
      readRate = readRate ? (readRate + rate) / 2 : rate
    }
    const full = (counts.fresh + counts.cached) / context
    if (watched) slowReads = readMs > slowLimit ? slowReads + 1 : 0
    if (calls.length && slowReads >= SLOW_READS_TO_HAND_OVER) return fail(slowMessage(readMs, full), step, model)
    lastFull = full

    if (!calls.length) {
      if (said) {
        emit({ step: 'say', text: said.split('\n')[0].slice(0, 160) })
        const text = stuckOn ? `${said}\n[Starwright stopped the local model repeating ${stuckOn} and asked for this report: check what it says is left.]` : said
        return { ok: true, text, model, steps: step, usage: { ...usage, model }, blocked }
      }
      if (nudged) return fail('The local model stopped without a report.', step, model)
      nudged = true
      messages.push({ role: 'user', content: 'Reply with your final report now: what you changed, file by file, and how the checks went.' })
      continue
    }

    // Asked to wrap up after getting stuck, and still calling tools: it really is stuck.
    if (stuckOn) return fail(`The local model got stuck repeating ${stuckOn}.`, step, model)

    messages.push({ role: 'assistant', content: said, tool_calls: calls })
    for (const call of calls) {
      // Stuck earlier in this reply: its remaining calls aren't run (each still needs an answer).
      if (stuckOn) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'Not run: you were asked to stop and report.' })
        continue
      }
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
      } catch {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'The arguments were not valid JSON. Call the tool again with valid JSON.' })
        continue
      }
      // The same call again and again: it's stuck.
      const key = `${call.function.name}:${call.function.arguments}`
      repeats = key === lastCall ? repeats + 1 : 0
      lastCall = key
      // Stuck on one call (on Lazarus, a browser check it had no tools for, after the change itself was
      // done): it isn't run again, and the model is asked for its report rather than failed, so work
      // that's done isn't undone with it.
      if (repeats >= 3) {
        stuckOn = call.function.name
        emit({ step: 'tool', text: `The local model was repeating ${stuckOn}: asked for its report`, ok: false })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `Not run: you have made this exact call four times and it won't get you further.`
        })
        continue
      }
      emit({ step: call.function.name === 'run_command' ? 'run' : call.function.name.endsWith('_file') && call.function.name !== 'read_file' ? 'edit' : 'tool', text: `${call.function.name}…` }, false)
      const outcome = await runTool(call.function.name, args, run)
      if (outcome.blocked) blocked.push(outcome.blocked)
      emit(outcome.activity)
      let note = repeats === 2 ? '\n(You have made this exact call three times. Try something different.)' : ''
      const name = call.function.name
      if (name === 'read_file' && outcome.activity.ok) {
        const seen = reads.read(args.path, args.start_line)
        if (seen.stop) {
          return fail(
            `The local model kept reading the same files again (${reads.mostRead()}) instead of making the change: the task needs more than fits in its ${context.toLocaleString()} tokens of context. Hand it to another agent, or split it into smaller tasks.`,
            step,
            model
          )
        }
        if (seen.times === MAX_READS_OF_A_PART) note += `\n(You have now read this ${seen.times} times. Don't read it again: write down in your next reply what you need from it, then make the change.)`
        readOf.set(call.id, { path: args.path, startLine: args.start_line })
        labels.set(call.id, `read_file ${String(args.path)}${Number(args.start_line) > 1 ? ` from line ${Math.floor(Number(args.start_line))}` : ''}`)
      } else if ((name === 'edit_file' || name === 'write_file') && outcome.activity.ok) {
        reads.changed(args.path)
      } else if (name === 'run_command') {
        labels.set(call.id, `the output of run_command ${String(args.command ?? '').split('\n')[0].slice(0, 80)}`)
      } else if (name === 'search' || name === 'list_files') {
        labels.set(call.id, `${name} ${String(args.query ?? args.path ?? '.').slice(0, 80)}`)
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: `${outcome.text}${note}` })
    }
    if (stuckOn) {
      messages.push({
        role: 'user',
        content: `Stop here, without calling any more tools. Reply with your final report: what you changed, file by file, which checks passed, and what you couldn't do or check (the step you were repeating ${stuckOn} on), so Claude can finish it.`
      })
    }

    // Keep the conversation inside the model's context.
    if (!contextKnown && step === 1) {
      // LM Studio loaded it for the first request: now it can say with how much.
      const now = (await lmStudioStatus(base).catch(() => null))?.models.find((m) => m.id === model)
      if (now?.loaded && now.contextLength) context = now.contextLength
    }
    const prompt = counts.fresh + counts.cached
    trimmedBefore = false
    if (prompt > context * 0.6) trimmedBefore = trimConversation(messages, 6, labels, onTrim) > 0
    if (prompt > context * 0.9) {
      const more = trimConversation(messages, 2, labels, onTrim)
      if (!more) return fail('The task outgrew the local model\'s context. Load the model with a longer context, or hand over a smaller task.', step, model)
      trimmedBefore = true
    }
  }
  return fail(`The local model used all ${maxSteps} steps without finishing.`, maxSteps, model)
}
