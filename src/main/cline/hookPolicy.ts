// What Cline may do in a VibeApp run. Cline approves every tool by itself and
// has no sandbox, so VibeApp puts a PreToolUse hook in front of every tool
// call (hookMain.ts, run by Cline for each call) and this decides it.
//
// Found on a real install: Cline also offers the tools of the user's Cline
// account connectors (Gmail, Google Drive, Docs through Composio), and with
// its editor turned off it went looking for a Google Drive tool to edit a
// file with. So it's an allow-list: anything not named here is refused.

import { isAbsolute, relative, resolve } from 'path'
import { staysInProject } from '../orchestrator/commandScope'
import { githubDanger } from '../orchestrator/githubGuard'
import { starwrightDataDanger } from '../guard/starwrightData'

export type ClineMode = 'build' | 'review' | 'helper'

export interface ClinePolicy {
  mode: ClineMode
  /** The project folder (the run's working folder). */
  projectPath: string
  /** Go Nutz: commands that reach outside the project are allowed (GitHub account changes still aren't). */
  goNutz?: boolean
  /** Files outside the project that may be read (the task file of a long prompt). */
  readFiles?: string[]
  /** A file whose text explains a refused read (read instead of the refused file). */
  blockedNote?: string
  /**
   * A command that only fails the folder check goes to the user (Allow/Deny), as Claude's
   * do, instead of being refused: the hook lets it through to Cline's permission request,
   * which Starwright answers (hosted Cline). One-off CLI runs can't ask, so they refuse.
   */
  askOutside?: boolean
  /** Starwright's own data folder(s): never touched, Go Nutz or not (the usual names are refused anyway). */
  dataPaths?: string[]
}

export interface ToolCall {
  name?: string
  input?: unknown
}

export type HookDecision =
  /** ask: allowed by the hook, but the permission answer must ask the user first (why). */
  | { allow: true; ask?: string }
  /**
   * Swap the tool's input for this one (a refused command becomes an echo that says why). quiet: not
   * something refused that the user needs to hear about (logged for diagnosis only).
   */
  | { allow: false; reason: string; overrideInput: unknown; quiet?: true }
  /** Stop the whole run: the tool can't be made harmless. */
  | { allow: false; reason: string; cancel: true }

/** Memory tools that only read. */
const MEMORY_READS = new Set(['recall', 'where', 'history', 'handoffs', 'plans', 'todos', 'notes'])
/** Memory tools that change the shared memory (allowed when building). */
const MEMORY_WRITES = new Set(['remember', 'update', 'forget', 'add_todo', 'complete_todo'])

/** Commands that destroy work or history, refused outside Go Nutz. */
const DESTRUCTIVE: { pattern: RegExp; what: string }[] = [
  { pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*r/i, what: 'deleting folders with rm -r' },
  { pattern: /\b(Remove-Item|ri|rm|del|erase)\b[^\n;|&]*-Recurse\b/i, what: 'deleting folders with Remove-Item -Recurse' },
  { pattern: /\b(rd|rmdir|del|erase)\b[^\n;|&]*\/s\b/i, what: 'deleting folders with rmdir /s' },
  { pattern: /\bdrop\s+(table|database)\b/i, what: 'deleting a database table' },
  { pattern: /\bgit(?:\.exe)?\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+--\s+\.|restore\s+(--staged\s+)?\.)/i, what: 'throwing away changes with git' },
  { pattern: /\bgit(?:\.exe)?\s+push\b[^\n]*(\s-f\b|--force)/i, what: 'force-pushing with git' },
  { pattern: /\bgit(?:\.exe)?\s+push\b/i, what: 'pushing to GitHub (Starwright does that through its own buttons)' },
  { pattern: /\bformat(-volume)?\b.*\b[a-z]:|\b(diskpart|mkfs(\.\w+)?)\b/i, what: 'formatting a disk' },
  { pattern: /\b(shutdown|Restart-Computer|Stop-Computer)\b/i, what: 'shutting the computer down' },
  { pattern: /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[^\n]*\|\s*(sh|bash|iex|Invoke-Expression|powershell|pwsh)\b/i, what: 'running a script straight from the internet' },
  { pattern: /\b(reg(\.exe)?\s+(add|delete)|Set-ItemProperty\s+-Path\s+['"]?HK)/i, what: 'changing the Windows registry' }
]

/**
 * The file an editor call is for. When the model's arguments didn't parse, Cline passes the raw text
 * on as { arguments: "…" } (seen in Cline 3.0.74): the path may still be in there.
 */
export function editorPath(input: Record<string, unknown>): unknown {
  if (input.path !== undefined) return input.path
  if (typeof input.arguments === 'string') {
    try {
      const parsed = JSON.parse(input.arguments) as { path?: unknown }
      if (parsed && typeof parsed === 'object') return parsed.path
    } catch {
      // Cut short: look for the path at the start of the text.
      const match = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input.arguments)
      if (match) {
        try {
          return JSON.parse(`"${match[1]}"`) as string
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

function inside(path: string, folder: string): boolean {
  const rel = relative(resolve(folder), resolve(folder, path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The reason a command gets when it only fails the folder check: the user may still allow it. */
export const OUTSIDE_PROJECT = 'working outside the project folder'

/** Why a command isn't allowed in this run, or null. OUTSIDE_PROJECT is the one the user can allow. */
export function commandDanger(command: string, policy: ClinePolicy): string | null {
  const github = githubDanger(command)
  if (github) return github
  // Starwright's secrets, deploy recipes and memory: never, Go Nutz or not, and not the user's to allow from a prompt.
  const data = starwrightDataDanger(command, policy.dataPaths)
  if (data) return data
  if (policy.goNutz) return null
  for (const rule of DESTRUCTIVE) if (rule.pattern.test(command)) return rule.what
  if (!staysInProject(command, policy.projectPath)) return OUTSIDE_PROJECT
  return null
}

function commandText(command: unknown): string {
  return typeof command === 'string' ? command : JSON.stringify(command ?? '')
}

function blockedEcho(what: string): string {
  // Single quotes: the same in PowerShell and bash, and the message has none.
  return `echo 'BLOCKED by Starwright: ${what.replace(/'/g, '')} is not allowed in this run. Do not try another way round it; say in your report that it needs the user.'`
}

export function decideToolCall(policy: ClinePolicy, call: ToolCall): HookDecision {
  const name = call.name ?? ''
  const input = (call.input ?? {}) as Record<string, unknown>
  const refuse = (reason: string): HookDecision => ({ allow: false, reason, cancel: true })

  // VibeApp's shared memory (its MCP server is named vibe_memory).
  const memory = /^vibe_memory__([a-z_]+)$/.exec(name)
  if (memory) {
    if (MEMORY_READS.has(memory[1]) && policy.mode !== 'helper') return { allow: true }
    if (MEMORY_WRITES.has(memory[1]) && policy.mode === 'build') return { allow: true }
    return refuse(`Starwright doesn't allow the memory tool ${memory[1]} here.`)
  }

  switch (name) {
    case 'read_files': {
      const files = Array.isArray(input.files) ? (input.files as { path?: unknown }[]) : []
      const allowedExtra = new Set((policy.readFiles ?? []).map((f) => resolve(f).toLowerCase()))
      const ok = (path: unknown): boolean =>
        typeof path === 'string' &&
        (allowedExtra.has(resolve(policy.projectPath, path).toLowerCase()) ||
          (policy.mode !== 'helper' && inside(path, policy.projectPath)))
      if (files.length && files.every((f) => ok(f?.path))) return { allow: true }
      const reason = policy.mode === 'helper' ? 'This job has no tools.' : 'Reading files outside the project is not allowed.'
      if (!policy.blockedNote) return refuse(reason)
      // Read the explanation instead, so the run carries on.
      return { allow: false, reason, overrideInput: { ...input, files: [{ path: policy.blockedNote }] } }
    }
    case 'search_codebase':
      // Searches the run's working folder (the project).
      return policy.mode === 'helper' ? refuse('This job has no tools.') : { allow: true }
    case 'editor': {
      if (policy.mode !== 'build') return refuse('This run may not change files.')
      const path = editorPath(input)
      if (typeof path === 'string' && path.trim()) {
        if (inside(path, policy.projectPath)) return { allow: true }
        return refuse('Changing files outside the project is not allowed.')
      }
      // No path: the model's call was cut short or malformed (a big write whose arguments didn't
      // parse). It can't change anything, so it isn't a reason to stop the run: an empty path makes
      // Cline's editor turn it down with an error the model can correct (it requires a path).
      return { allow: false, reason: 'an edit with no file path (sent back for Cline to try again)', overrideInput: { ...input, path: '' }, quiet: true }
    }
    case 'run_commands': {
      if (policy.mode !== 'build') return refuse('This run may not run commands.')
      const commands = Array.isArray(input.commands) ? input.commands : [input.commands]
      const verdicts = commands.map((c) => commandDanger(commandText(c), policy))
      if (verdicts.every((v) => v === null)) return { allow: true }
      // Only the folder check failed: the user decides, as for Claude's commands.
      if (policy.askOutside && verdicts.every((v) => v === null || v === OUTSIDE_PROJECT)) {
        return { allow: true, ask: OUTSIDE_PROJECT }
      }
      const reasons = verdicts.filter(Boolean) as string[]
      return {
        allow: false,
        reason: reasons.join('; '),
        overrideInput: { ...input, commands: commands.map((c, i) => (verdicts[i] ? blockedEcho(verdicts[i]!) : c)) }
      }
    }
    default:
      // Connectors (Gmail, Drive…), web fetches, helper agents, questions to a user who isn't there.
      return refuse(`Starwright doesn't allow the ${name || 'unnamed'} tool in Cline runs.`)
  }
}

/** The hook's answer to Cline, from a decision (Cline's PreToolUse output format). */
export function hookOutput(decision: HookDecision): Record<string, unknown> {
  if (decision.allow) return {}
  if ('cancel' in decision) return { cancel: true, errorMessage: decision.reason }
  return { overrideInput: decision.overrideInput }
}
