import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolId, ToolUpdateState } from '@shared/types'
import { TESTED_WITH, toolVersionLines } from '@shared/update'
import {
  checkUpdatedTool,
  dismissToolUpdate,
  keepTool,
  missingFlags,
  npmProblem,
  REQUIRED_FLAGS,
  restoreToolUpdates,
  rollBackTool,
  startToolUpdate,
  toolUpdates,
  updateTool,
  type UpdatableTool,
  type UpdateDeps
} from '../../src/main/updates/toolUpdate'
import { clearToolGate, setToolGate, toolHeld, toolInstalling } from '../../src/main/updates/toolGate'
import { checkTools, type ToolCheckDeps } from '../../src/main/updates/toolVersions'
import { clineUnavailable } from '../../src/main/cli/clineExec'
import { checkRemoteCall } from '../../src/main/remote/auth'
import type { ExecCliError } from '../../src/main/cli/execCli'

// What `codex exec --help` (codex-cli 0.158.0) and `cline --help` (3.0.76) list, cut down.
const CODEX_HELP = `Usage: codex exec [OPTIONS] [PROMPT]
  -c, --config <key=value>  Override a configuration value
      --image <FILE>...
  -m, --model <MODEL>
  -s, --sandbox <SANDBOX_MODE>
      --dangerously-bypass-approvals-and-sandbox
      --dangerously-bypass-hook-trust
  -C, --cd <DIR>
      --skip-git-repo-check
      --ephemeral
      --output-schema <FILE>
      --approve-for-me
      --json
  -o, --output-last-message <FILE>`
const CLINE_HELP = `Options:
  -V, --version                 Output the version number
  -p, --plan                    Run in plan mode
  --json                        Output messages as JSON instead of styled text
  -c, --cwd <path>              Working directory
  --thinking <level>            Set reasoning effort
  --compaction <mode>           Context compaction mode
  -m, --model <model-id>        Model to use
  -s, --system <system-prompt>  Override the default system prompt
  -t, --timeout <seconds>       Optional timeout in seconds
  --acp                         Run in Agent Client Protocol (ACP) mode`

const tempState = (): string => join(mkdtempSync(join(tmpdir(), 'tool-update-')), 'tool-updates.json')

interface Fake {
  deps: UpdateDeps
  installs: string[]
  skipped: string[]
  /** What the gate said while each step ran. */
  seen: { installing: boolean; held?: string }[]
}

function fake(opts: {
  installed?: string
  npm?: string
  /** Throws this from npm install (after "installing" what `installAs` says). */
  npmError?: string
  /** What --version says after an install (default: the version installed). */
  installAs?: string
  help?: string
  runs?: string[]
  busy?: number[]
  others?: number
}): Fake {
  let version = opts.installed
  const busy = [...(opts.busy ?? [])]
  const f: Fake = { installs: [], skipped: [], seen: [], deps: undefined as unknown as UpdateDeps }
  f.deps = {
    installed: async () => version,
    npmVersion: async () => opts.npm ?? opts.installed,
    install: async (pkg, v) => {
      f.seen.push({ installing: toolInstalling('cline'), held: toolHeld('cline') })
      f.installs.push(`${pkg}@${v}`)
      if (opts.npmError) {
        if (opts.installAs !== undefined) version = opts.installAs
        throw new Error(opts.npmError)
      }
      version = opts.installAs ?? v
    },
    help: async () => ({ text: opts.help ?? CLINE_HELP, problems: [] }),
    tryRuns: async () => {
      f.seen.push({ installing: toolInstalling('cline'), held: toolHeld('cline') })
      return opts.runs ?? []
    },
    busy: () => busy.shift() ?? 0,
    othersRunning: async () => opts.others ?? 0,
    stopIdle: () => undefined,
    sleep: async () => undefined,
    now: () => new Date('2026-11-27T10:00:00Z'),
    skip: (tool, v) => f.skipped.push(`${tool}@${v}`),
    refresh: () => undefined
  }
  return f
}

function reset(): void {
  restoreToolUpdates(tempState())
  for (const t of ['codex', 'cline'] as UpdatableTool[]) clearToolGate(t)
}

test('the options Starwright passes are found in each --help, and a missing one is named', () => {
  assert.deepEqual(missingFlags('codex', CODEX_HELP), [])
  assert.deepEqual(missingFlags('cline', CLINE_HELP), [])
  assert.deepEqual(missingFlags('cline', CLINE_HELP.replace('--acp', '--agent-protocol')), ['--acp'])
  // A longer option with the same start is not the one asked for.
  assert.deepEqual(missingFlags('codex', CODEX_HELP.replace('--json\n', '--json-lines\n')), ['--json'])
  assert.ok(REQUIRED_FLAGS.codex.includes('--dangerously-bypass-hook-trust'), "the safety hook's flag is checked")
})

test('an update waits for running work, installs with nothing able to start the tool, checks it and frees it', async () => {
  reset()
  const f = fake({ installed: '3.0.76', busy: [2, 1, 0] })
  const progress: string[] = []
  const done = await updateTool('cline', '3.0.80', {
    ...f.deps,
    busy: (t) => {
      const n = f.deps.busy(t)
      progress.push(toolUpdates().cline?.message ?? '')
      // While waiting, new work goes elsewhere: Cline counts as unavailable.
      assert.match(clineUnavailable() ?? '', /being updated/)
      return n
    }
  })
  assert.equal(done.phase, 'done')
  assert.equal(done.from, '3.0.76')
  assert.equal(done.to, '3.0.80')
  assert.match(done.message ?? '', /updated from 3\.0\.76 to 3\.0\.80 and passed/)
  assert.deepEqual(f.installs, ['cline@3.0.80'])
  assert.ok(progress.some((m) => /Waiting for 2 Cline runs to finish/.test(m)), progress.join(' | '))
  assert.equal(f.seen[0].installing, true, 'nothing may start Cline while npm replaces it')
  assert.equal(f.seen[1].installing, false, 'the check itself can run it')
  assert.match(f.seen[1].held ?? '', /being checked/, 'other work still waits during the check')
  assert.equal(toolHeld('cline'), undefined, 'free again')
  assert.equal(clineUnavailable(), undefined)

  // Finished: its message can be dismissed.
  dismissToolUpdate('cline')
  assert.equal(toolUpdates().cline, undefined)
})

test('a version that fails the check is held back until the user puts the old one back or keeps it', async () => {
  reset()
  const f = fake({ installed: '3.0.74', runs: ["A hosted Cline run (as hand-offs use): Starwright's safety hook refused submit_and_exit."] })
  const failed = await updateTool('cline', '3.0.75', f.deps)
  assert.equal(failed.phase, 'failed')
  assert.deepEqual(failed.problems, ["A hosted Cline run (as hand-offs use): Starwright's safety hook refused submit_and_exit."])
  assert.match(toolHeld('cline') ?? '', /failed Starwright's check.*put 3\.0\.74 back, or keep it/)
  assert.match(clineUnavailable() ?? '', /failed Starwright's check/, 'hand-offs and background jobs skip Cline')
  dismissToolUpdate('cline')
  assert.equal(toolUpdates().cline?.phase, 'failed', "a failed update can't just be dismissed")

  // The usage report says so (seen over Remote and in the usage_report tool).
  const lines = toolVersionLines({ tools: [{ tool: 'cline', package: 'cline', installed: '3.0.75', newer: false, bundled: false }], updates: toolUpdates() })
  assert.match(lines[1], /updated from 3\.0\.74 and failed Starwright's check: .*submit_and_exit/)

  const back = await rollBackTool('cline', f.deps)
  assert.equal(back?.phase, 'rolled-back')
  assert.deepEqual(f.installs, ['cline@3.0.75', 'cline@3.0.74'])
  assert.deepEqual(f.skipped, ['cline@3.0.75'], 'the bad version no longer nags')
  assert.equal(toolHeld('cline'), undefined)

  // Or keep it (the problem was the plan, say).
  reset()
  const g = fake({ installed: '3.0.74', runs: ['A one-off Cline run failed: ClinePass limit reached.'] })
  await updateTool('cline', '3.0.75', g.deps)
  assert.ok(toolHeld('cline'))
  assert.equal(keepTool('cline')?.phase, 'kept')
  assert.equal(toolHeld('cline'), undefined)
})

test('the check: the version must be the new one, the options all there, and the runs pass', async () => {
  const name = (installed: string, more: Parameters<typeof fake>[0] = {}): Promise<string[]> =>
    checkUpdatedTool('cline', '3.0.80', fake({ installed, ...more }).deps)
  assert.deepEqual(await name('3.0.80'), [])
  assert.match((await name('3.0.76'))[0], /still finds Cline 3\.0\.76, not 3\.0\.80/)
  const flags = await name('3.0.80', { help: CLINE_HELP.replace('--acp', ''), runs: ['should not run'] })
  assert.deepEqual(flags, ['Cline 3.0.80 no longer lists options Starwright passes it: --acp.'], 'no live run when the basics fail')
})

test('npm failing part-way: nothing changed is an error and the tool is free; a changed install is held', async () => {
  reset()
  const same = await updateTool('cline', '3.0.80', fake({ installed: '3.0.76', npmError: 'EBUSY: resource busy or locked' }).deps)
  assert.equal(same.phase, 'error')
  assert.match(same.message ?? '', /EBUSY.*Nothing changed/)
  assert.equal(toolHeld('cline'), undefined)

  reset()
  const half = await updateTool('cline', '3.0.80', fake({ installed: '3.0.76', npmError: 'EPERM', installAs: '' }).deps)
  assert.equal(half.phase, 'failed')
  assert.ok(toolHeld('cline'))
  clearToolGate('cline')
})

test("a tool not installed with npm, or already current, isn't touched", async () => {
  reset()
  const other = fake({ installed: '0.158.0', npm: '0.150.0' })
  const r = await updateTool('codex', '0.172.0', other.deps)
  assert.equal(r.phase, 'error')
  assert.match(r.message ?? '', /wasn't installed with npm/)
  assert.deepEqual(other.installs, [])
  assert.equal((await updateTool('codex', '0.158.0', fake({ installed: '0.158.0' }).deps)).phase, 'error')
  assert.match((await updateTool('codex', '0.172.0 && del *', fake({ installed: '0.158.0' }).deps)).message ?? '', /isn't a Codex version/)
  assert.equal(toolHeld('codex'), undefined)
})

test('a copy running outside Starwright stops the update before npm touches anything', async () => {
  reset()
  const f = fake({ installed: '3.0.76', others: 1 })
  const r = await updateTool('cline', '3.0.80', f.deps)
  assert.equal(r.phase, 'error')
  assert.match(r.message ?? '', /running outside Starwright.*cline.exe.*Nothing changed/)
  assert.deepEqual(f.installs, [])
  assert.equal(toolHeld('cline'), undefined)
})

test('the Update button only asks for the newest version Starwright found', () => {
  assert.throws(() => startToolUpdate('claude', '1.0.0'), /Only Codex and Cline/)
  assert.throws(() => startToolUpdate('cline', '9.9.9'), /isn't the newest version/)
})

test('an update cut off by closing Starwright is treated as failed and holds the tool back again', () => {
  const path = tempState()
  const s = (phase: ToolUpdateState['phase']): ToolUpdateState => ({ phase, from: '1.0.0', to: '1.1.0', at: '2026-11-27T10:00:00Z' })
  writeFileSync(path, JSON.stringify({ codex: s('installing'), cline: s('waiting') }))
  clearToolGate('codex')
  restoreToolUpdates(path)
  assert.equal(toolUpdates().codex?.phase, 'failed')
  assert.match(toolUpdates().codex?.problems?.[0] ?? '', /closed before the update was finished/)
  assert.equal(toolUpdates().cline, undefined, 'nothing had changed yet')
  assert.ok(toolHeld('codex'))
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).codex.phase, 'failed', 'saved as such')
  reset()
})

test("npm's error lines are kept, short", () => {
  const err = Object.assign(new Error('Command failed'), {
    stdout: '',
    stderr: 'npm error code EBUSY\nnpm error syscall rename\nnpm error path C:\\npm\\node_modules\\cline\nnpm error A complete log of this run can be found in: x.log\n'
  }) as ExecCliError
  assert.equal(npmProblem(err), 'code EBUSY syscall rename path C:\\npm\\node_modules\\cline')
})

test('the versions say which tools npm installed, which are newer than Starwright was tested with, and where the notes are', async () => {
  const deps: ToolCheckDeps = {
    installed: async (tool: ToolId) => ({ codex: '0.158.0', cline: '3.0.76', claude: '0.3.283' })[tool],
    // Codex: a version newer than any Starwright was tested with; Cline: the one it was tested with.
    latest: async (pkg) => ({ '@openai/codex': '99.0.0', cline: TESTED_WITH.cline, '@anthropic-ai/claude-agent-sdk': '0.3.283' })[pkg]!,
    npmVersion: async (pkg) => (pkg === 'cline' ? '3.0.76' : '0.150.0'),
    now: () => new Date()
  }
  const by = Object.fromEntries((await checkTools(deps)).tools.map((t) => [t.tool, t]))
  assert.equal(by.codex.npm, false, "npm's copy isn't the one that runs")
  assert.equal(by.cline.npm, true)
  assert.equal(by.codex.untested, true)
  assert.equal(by.cline.untested, false)
  assert.equal(by.codex.notesUrl, 'https://github.com/openai/codex/releases/tag/rust-v99.0.0')
  assert.equal(by.cline.notesUrl, `https://github.com/cline/cline/releases/tag/cli-v${TESTED_WITH.cline}`)
  assert.equal(by.claude.npm, undefined)
})

test('a held Codex gets no hand-offs; over Remote only a full-access screen can update', async () => {
  setToolGate('codex', 'drain', 'Codex is being updated.')
  const { helperAvailability } = await import('../../src/main/orchestrator/routing')
  const { getSettings } = await import('../../src/main/settings/store')
  assert.equal((await helperAvailability(getSettings())).available.codex, false)
  clearToolGate('codex')
  assert.equal((await helperAvailability(getSettings())).available.codex, true)

  for (const channel of ['vibe:tools:update', 'vibe:tools:rollBack', 'vibe:tools:keep', 'vibe:tools:recheck', 'vibe:tools:dismiss']) {
    assert.equal(checkRemoteCall(channel, ['cline'], true).allowed, false, `${channel} from a read-only screen`)
    assert.equal(checkRemoteCall(channel, ['cline'], false).allowed, true, `${channel} with full access`)
  }
})
