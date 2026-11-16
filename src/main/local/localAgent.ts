import { spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import { OUTSIDE_PROJECT, commandDanger } from '../cline/hookPolicy'
import { killTree, trackChild } from '../cli/codexExec'
import { bashPath } from '../deploy/deploy'
import { countsFromChatUsage, lmStudioBase, lmStudioStatus, pickModel } from '../cli/lmStudio'
import { getSettings } from '../settings/store'
import type { TokenCounts } from '../usage/tokens'
import type { DelegationActivity } from '@shared/types'

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
  /** Extra environment variables for its commands: the project's secrets, as Claude has them. */
  env?: Record<string, string>
  /** Asks the user about a command that only failed the folder check (Allow/Deny), as for Claude. None: refused. */
  ask?: (command: string) => Promise<boolean>
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

function runShell(
  command: string,
  cwd: string,
  timeoutSec: number,
  signal?: AbortSignal,
  extra: Record<string, string> = {}
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((done) => {
    const bash = bashPath()
    const child = trackChild(
      bash
        ? spawn(bash, ['-lc', command], { cwd, env: { ...process.env, ...extra, CHERE_INVOKING: '1', CI: '1' }, windowsHide: true })
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
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutSec * 1000)
    const onAbort = (): void => killTree(child)
    signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (code: number | null): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      done({ code, output, timedOut })
    }
    child.once('error', (err) => {
      output += `\n${err.message}`
      finish(null)
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
      let danger = commandDanger(command, { mode: 'build', projectPath: cwd, goNutz: run.goNutz })
      // Only the folder check failed: the user decides, as for Claude's commands.
      if (danger === OUTSIDE_PROJECT && run.ask && (await run.ask(command).catch(() => false))) danger = null
      if (danger) {
        return {
          text: `BLOCKED by Starwright: ${danger} is not allowed in this run. Do not try another way round it; say in your report that it needs the user.`,
          activity: { step: 'run', text: command.slice(0, 120), full: command, detail: `Refused: ${danger}`, ok: false },
          blocked: danger
        }
      }
      const timeout = Math.min(600, Math.max(5, Math.floor(Number(args.timeout_seconds) || 120)))
      const result = await runShell(command, cwd, timeout, run.signal, run.env)
      const output = clip(result.output.trim() || '(no output)')
      const status = result.timedOut ? `Stopped after ${timeout} s (still running).` : `Exit code ${result.code}.`
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
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

interface ChatReply {
  model?: string
  choices?: { message?: { content?: string | null; tool_calls?: Message['tool_calls'] }; finish_reason?: string }[]
  usage?: Parameters<typeof countsFromChatUsage>[0]
  error?: { message?: string } | string
}

const TRIMMED = '[Earlier output removed to save room. Read or run it again if you still need it.]'

/** Shrinks older tool results once the conversation fills much of the model's context. */
export function trimConversation(messages: Message[], keepRecent = 6): number {
  const tools = messages.map((m, i) => (m.role === 'tool' && m.content !== TRIMMED ? i : -1)).filter((i) => i >= 0)
  let trimmed = 0
  for (const i of tools.slice(0, Math.max(0, tools.length - keepRecent))) {
    messages[i] = { ...messages[i], content: TRIMMED }
    trimmed++
  }
  return trimmed
}

/** Runs one task to the end on LM Studio's model. Never throws: failures come back in the result. */
export async function runLocalAgent(run: LocalAgentRun): Promise<LocalAgentResult> {
  const settings = getSettings()
  const base = lmStudioBase(settings.lmStudioUrl)
  const usage: TokenCounts = { fresh: 0, cached: 0, output: 0, steps: 0 }
  const blocked: string[] = []
  const deadline = Date.now() + (run.timeoutMs ?? 15 * 60_000)
  const maxSteps = run.maxSteps ?? 60
  const fail = (error: string, steps: number, model?: string, text = ''): LocalAgentResult => ({ ok: false, text, error, model, steps, usage, blocked })

  const status = await lmStudioStatus(base)
  if (!status.running) return fail(status.error ?? 'LM Studio is not running.', 0)
  const model = run.model ?? pickModel(status.models, settings.lmStudioModel)
  if (!model) return fail('LM Studio has no chat model downloaded.', 0)
  const context = status.models.find((m) => m.id === model)?.contextLength ?? 32_000

  const messages: Message[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: run.task }
  ]
  let activityId = 0
  const emit = (a: Omit<DelegationActivity, 'id' | 'done'>, done = true): void => run.onActivity?.({ id: `local-${++activityId}`, done, ...a })
  let lastCall = ''
  let repeats = 0
  let nudged = false

  for (let step = 1; step <= maxSteps; step++) {
    if (run.signal?.aborted) return fail('The local model run was cancelled.', step - 1, model)
    const left = deadline - Date.now()
    if (left <= 0) return fail('The local model ran out of time.', step - 1, model)
    let reply: ChatReply
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          tools: TOOLS,
          temperature: 0.2,
          stream: false,
          ...(run.thinking ? {} : { reasoning_effort: 'none' })
        }),
        signal: run.signal ? AbortSignal.any([run.signal, AbortSignal.timeout(left)]) : AbortSignal.timeout(left)
      })
      reply = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as ChatReply
      if (!res.ok && !reply.error) reply.error = `HTTP ${res.status}`
    } catch (err) {
      if (run.signal?.aborted) return fail('The local model run was cancelled.', step - 1, model)
      return fail((err as Error).name === 'TimeoutError' ? 'The local model ran out of time.' : `Couldn't reach LM Studio (${(err as Error).message}).`, step - 1, model)
    }
    const counts = countsFromChatUsage(reply.usage)
    usage.fresh += counts.fresh
    usage.cached += counts.cached
    usage.output += counts.output
    usage.steps = step
    if (reply.error) {
      const message = typeof reply.error === 'string' ? reply.error : (reply.error.message ?? 'unknown error')
      return fail(`LM Studio refused the request: ${message.slice(0, 300)}`, step, model)
    }
    const choice = reply.choices?.[0]
    const said = (choice?.message?.content ?? '').trim()
    const calls = choice?.message?.tool_calls ?? []

    if (!calls.length) {
      if (said) {
        emit({ step: 'say', text: said.split('\n')[0].slice(0, 160) })
        return { ok: true, text: said, model, steps: step, usage: { ...usage, model }, blocked }
      }
      if (nudged) return fail('The local model stopped without a report.', step, model)
      nudged = true
      messages.push({ role: 'user', content: 'Reply with your final report now: what you changed, file by file, and how the checks went.' })
      continue
    }

    messages.push({ role: 'assistant', content: said, tool_calls: calls })
    for (const call of calls) {
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
      if (repeats >= 3) return fail(`The local model got stuck repeating ${call.function.name}.`, step, model)
      emit({ step: call.function.name === 'run_command' ? 'run' : call.function.name.endsWith('_file') && call.function.name !== 'read_file' ? 'edit' : 'tool', text: `${call.function.name}…` }, false)
      const outcome = await runTool(call.function.name, args, run)
      if (outcome.blocked) blocked.push(outcome.blocked)
      emit(outcome.activity)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: repeats === 2 ? `${outcome.text}\n(You have made this exact call three times. Try something different.)` : outcome.text
      })
    }

    // Keep the conversation inside the model's context.
    const prompt = counts.fresh + counts.cached
    if (prompt > context * 0.6) trimConversation(messages)
    if (prompt > context * 0.9 && !trimConversation(messages, 2)) {
      return fail('The task outgrew the local model\'s context. Load the model with a longer context, or hand over a smaller task.', step, model)
    }
  }
  return fail(`The local model used all ${maxSteps} steps without finishing.`, maxSteps, model)
}
