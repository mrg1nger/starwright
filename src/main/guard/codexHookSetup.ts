import { app } from 'electron'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { findNode } from '../cli/clineExec'

// Codex's PreToolUse hook for every Starwright run (codexHookMain.ts): Starwright's data folders
// are refused before a command, patch or tool call runs. Codex only runs hooks it trusts; one given
// for a single run with -c needs --dangerously-bypass-hook-trust, which is what that flag is for
// ("one-off automation that already vets hook sources outside Codex"). Nothing is written to the
// user's ~/.codex.

const toml = (s: string): string => JSON.stringify(s) // a TOML basic string has JSON's escapes
const fwd = (p: string): string => p.replace(/\\/g, '/')

let ready: { args: string[] } | undefined
let preparing: Promise<string[]> | undefined

/** The bundled hook, next to out/main/index.js (inside app.asar when installed; copied out for Node). */
const hookSource = (): string => join(__dirname, 'guard', 'codexHook.cjs')

/** Runs the hook once on a call it must refuse: a hook that doesn't work isn't given to Codex. */
function selfTest(node: string, hook: string, dataDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(node, [hook, dataDir], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', () => resolve(false))
    child.on('exit', () => resolve(/"permissionDecision":"deny"/.test(out)))
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'dir "%APPDATA%\\vibeapp\\secrets"' } }))
    setTimeout(() => child.kill(), 10_000)
  })
}

/**
 * The `codex exec` arguments that put Starwright's hook in front of Codex's tools, or [] when it
 * can't be set up (no Node on the PATH: Codex's npm install needs it, so that's rare).
 */
export async function codexHookArgs(): Promise<string[]> {
  if (ready) return ready.args
  preparing ??= (async () => {
    try {
      const node = await findNode()
      if (!node) throw new Error('no Node on the PATH')
      const dataDir = app.getPath('userData')
      const dir = join(dataDir, 'codex-hook')
      mkdirSync(dir, { recursive: true })
      const hook = join(dir, 'PreToolUse.cjs')
      const source = readFileSync(hookSource(), 'utf8')
      if (!existsSync(hook) || readFileSync(hook, 'utf8') !== source) writeFileSync(hook, source)
      if (!(await selfTest(node, hook, dataDir))) throw new Error("its self-check didn't refuse")
      // "node" from the PATH (where findNode found it): a quoted full path reads as a string, not a
      // command, in PowerShell.
      const command = `node "${fwd(hook)}" "${fwd(dataDir)}"`
      const args = [
        '--dangerously-bypass-hook-trust',
        '-c',
        `hooks.PreToolUse=[{matcher="",hooks=[{type="command",command=${toml(command)},timeout=30,statusMessage="Starwright's safety check"}]}]`
      ]
      ready = { args }
      return args
    } catch (err) {
      console.warn(`Codex runs without Starwright's data-folder check: ${(err as Error).message}`)
      return []
    } finally {
      preparing = undefined
    }
  })()
  return preparing
}
