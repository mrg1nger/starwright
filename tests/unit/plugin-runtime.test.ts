import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { VibeEvent } from '@shared/types'
import { commandLine, parseManifest } from '@shared/plugins'
import { recordProjectOpened } from '../../src/main/projects/store'
import { updateSettings } from '../../src/main/settings/store'
import {
  addExamplePlugin,
  approvePlugin,
  closePanel,
  globalPluginsFolder,
  listPlugins,
  openPanel,
  remotePanelResponse,
  setPluginOff,
  setSafeModeForTests
} from '../../src/main/plugins/registry'
import { callPlugin } from '../../src/main/plugins/calls'
import { checkPluginFolder, pluginWarnings } from '../../src/main/plugins/check'
import {
  FAILS_TO_TURN_OFF,
  pluginEvent,
  pluginRuns,
  pluginRunsSettled,
  runPluginCommand,
  setPluginRuntimeDeps,
  tickPluginSchedules
} from '../../src/main/plugins/runtime'

const chat: { projectId: string; text: string }[] = []
const alerts: string[] = []
const sent: { channel: string; args: unknown[] }[] = []
setPluginRuntimeDeps({
  chatEvent: (projectId, event: VibeEvent) => chat.push({ projectId, text: (event as { text?: string }).text ?? '' }),
  notify: (title, body) => alerts.push(`${title}: ${body}`),
  send: (channel, ...args) => sent.push({ channel, args })
})

const BASE = { title: 'Tool', version: '1.0.0', description: 'A test plugin with commands.' }

/** A project with a plugin of its own: plugin.json plus the given files, approved unless asked not to. */
function project(manifest: Record<string, unknown>, files: Record<string, string>, approve = true) {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-runtime-'))
  const name = String(manifest.name)
  const folder = join(dir, '.starwright', 'plugins', name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ ...BASE, ...manifest }))
  for (const [path, text] of Object.entries(files)) writeFileSync(join(folder, path), text)
  const id = recordProjectOpened(dir).id
  const info = () => listPlugins(id).plugins.find((p) => p.key === `project:${name}`)!
  if (approve) approvePlugin(id, info().key, info().hash!)
  return { id, dir, folder, key: `project:${name}`, info }
}

test('commands, buttons, hooks and schedules are checked in plugin.json', () => {
  const ok = parseManifest(
    {
      name: 'tool',
      ...BASE,
      permissions: ['commands'],
      commands: [
        { id: 'check', title: 'Check', run: ['node', '{plugin}/check.js'], timeout: 30 },
        { id: 'line', title: 'Line', run: 'npm test' }
      ],
      buttons: [{ title: 'Check now', command: 'check' }],
      hooks: [{ on: 'request-end', command: 'check' }],
      schedules: [
        { id: 'daily', command: 'line', when: { kind: 'daily', time: '09:30' } },
        { id: 'often', command: 'check', when: { kind: 'every', minutes: 15 } }
      ]
    },
    'tool'
  )
  assert.deepEqual(ok.problems, [])
  assert.equal(ok.manifest!.commands[1].timeout, 120, 'two minutes unless it says')
  assert.deepEqual(ok.manifest!.schedules[0].when, { kind: 'daily', time: '09:30', days: [0, 1, 2, 3, 4, 5, 6] })
  assert.equal(commandLine(ok.manifest!.commands[0]), 'node {plugin}/check.js')
  assert.equal(commandLine({ run: ['node', 'a b.js'] }), 'node "a b.js"')

  const bad = parseManifest(
    {
      name: 'tool',
      ...BASE,
      permissions: [],
      commands: [{ id: 'check', title: 'Check', run: [], timeout: 99999 }],
      buttons: [{ title: 'Go', command: 'missing' }],
      hooks: [{ on: 'whenever', command: 'check' }],
      schedules: [
        { id: 'fast', command: 'check', when: { kind: 'every', minutes: 1 } },
        { id: 'late', command: 'check', when: { kind: 'daily', time: '25:00' } }
      ]
    },
    'tool'
  ).problems.join('\n')
  assert.match(bad, /must include "commands"/)
  assert.match(bad, /needs a "run"/)
  assert.match(bad, /"timeout" is seconds/)
  assert.match(bad, /names the command "missing"/)
  assert.match(bad, /hook's "on" must be one of/)
  assert.match(bad, /"minutes" must be a whole number from 5/)
  assert.match(bad, /"time" must be like "09:30"/)
  // A plugin with only commands (no panel) is fine; one with neither isn't.
  assert.match(parseManifest({ name: 'tool', ...BASE }, 'tool').problems.join(), /at least one panel or command/)
})

const SCRIPT = `
const fs = require('fs')
console.log('dir=' + __dirname)
console.log('project=' + process.env.STARWRIGHT_PROJECT)
console.log('event=' + process.env.STARWRIGHT_EVENT)
console.log('input=' + process.env.STARWRIGHT_INPUT)
fs.writeFileSync(require('path').join(process.env.STARWRIGHT_DATA_DIR, 'seen.txt'), 'yes')
console.log('::status All good')
console.log('::json {"count": 3}')
console.log('::note Checked the project.')
console.log('::notify Something to know')
`

test('a command runs from the copy of the files you approved, in the project, and its run is kept', async () => {
  const p = project(
    {
      name: 'runner',
      permissions: ['commands', 'notify'],
      commands: [{ id: 'go', title: 'Go', run: ['node', '{plugin}/go.js'] }],
      buttons: [{ title: 'Go', command: 'go' }],
      panels: [{ id: 'main', title: 'Main', entry: 'panel.html' }]
    },
    { 'go.js': SCRIPT, 'panel.html': '<p>hi</p>' }
  )
  try {
    chat.length = 0
    alerts.length = 0
    const run = await runPluginCommand(p.id, p.key, 'go', 'button')
    assert.equal(run.ok, true, run.output)
    assert.equal(run.exitCode, 0)
    assert.equal(run.status, 'All good')
    assert.deepEqual(run.result, { count: 3 })
    assert.match(run.output, /dir=.*plugin-run/, 'its script ran from the approved copy, not the project folder')
    assert.ok(run.output.includes(`project=${p.dir}`))
    assert.doesNotMatch(run.output, /::status|::json/, 'the lines for Starwright are taken out')
    assert.deepEqual(
      chat.map((c) => c.text),
      ['🧩 Tool: Checked the project.', '🧩 Tool · Go finished in ' + run.seconds + ' s: All good']
    )
    assert.equal(alerts.length, 1)
    assert.match(alerts[0], /🧩 Tool: Something to know/)
    assert.equal(pluginRuns(p.id, p.key)[0].at, run.at)
    assert.equal(p.info().lastRun?.status, 'All good')

    // From its panel, with something passed in; the panel needs the commands permission.
    const { token } = openPanel(p.id, p.key, 'main')
    const fromPanel = (await callPlugin(token, 'commands.run', ['go', { file: 'a.js' }])) as { ok: boolean; output: string; trigger: string }
    assert.equal(fromPanel.ok, true)
    assert.match(fromPanel.output, /input=\{"file":"a\.js"\}/)
    assert.equal(fromPanel.trigger, 'panel')
    assert.equal(((await callPlugin(token, 'commands.runs', ['go'])) as unknown[]).length, 2)
    await assert.rejects(callPlugin(token, 'commands.run', ['nope']), /no command "nope"/)
    closePanel(token)

    // Changed after approval: it doesn't run until approved again.
    writeFileSync(join(p.folder, 'go.js'), 'console.log("changed")')
    await assert.rejects(runPluginCommand(p.id, p.key, 'go', 'button'), /approve it again/)
    setSafeModeForTests(true)
    await assert.rejects(runPluginCommand(p.id, p.key, 'go', 'button'), /safe mode/)
    setSafeModeForTests(false)
  } finally {
    rmSync(p.dir, { recursive: true, force: true })
  }
})

test('a command line runs in the shell, and a command that runs too long is stopped', async () => {
  const p = project(
    {
      name: 'shell',
      permissions: ['commands'],
      commands: [
        { id: 'line', title: 'Line', run: 'echo hello-from-the-shell' },
        { id: 'slow', title: 'Slow', run: ['node', '-e', 'setTimeout(() => {}, 20000)'], timeout: 1 },
        { id: 'fail', title: 'Fail', run: ['node', '-e', 'console.error("broke"); process.exit(3)'] }
      ]
    },
    {}
  )
  try {
    const line = await runPluginCommand(p.id, p.key, 'line', 'button')
    assert.equal(line.ok, true, line.output)
    assert.match(line.output, /hello-from-the-shell/)
    const slow = await runPluginCommand(p.id, p.key, 'slow', 'button')
    assert.equal(slow.ok, false)
    assert.match(slow.output, /stopped it after 1 seconds/)
    const fail = await runPluginCommand(p.id, p.key, 'fail', 'button')
    assert.equal(fail.ok, false)
    assert.equal(fail.exitCode, 3)
    assert.match(chat.at(-1)!.text, /Fail failed \(exit code 3\): broke/)
  } finally {
    rmSync(p.dir, { recursive: true, force: true })
  }
})

test('hooks run when something happens, open panels hear it, and runs that keep failing turn the plugin off', async () => {
  const p = project(
    {
      name: 'hooks',
      permissions: ['commands', 'records:read'],
      commands: [
        { id: 'log', title: 'Log', run: ['node', '-e', 'console.log("got " + process.env.STARWRIGHT_EVENT)'] },
        { id: 'bad', title: 'Bad', run: ['node', '-e', 'process.exit(1)'] }
      ],
      hooks: [
        { on: 'request-end', command: 'log' },
        { on: 'handoff-end', command: 'bad' }
      ],
      panels: [{ id: 'main', title: 'Main', entry: 'panel.html' }]
    },
    { 'panel.html': '<p>hi</p>' }
  )
  try {
    const { token } = openPanel(p.id, p.key, 'main')
    sent.length = 0
    pluginEvent(p.id, 'request-end', { outcome: 'done', request: 'make it blue', files: ['a.css'] })
    await pluginRunsSettled()
    const run = pluginRuns(p.id, p.key)[0]
    assert.equal(run.trigger, 'hook:request-end')
    assert.match(run.output, /got \{"type":"request-end","at":"[^"]+","outcome":"done","request":"make it blue","files":\["a\.css"\]\}/)
    const heard = sent.find((s) => s.channel === 'vibe:plugins:event')
    assert.equal(heard?.args[0], token, 'the open panel heard it, by its token')
    assert.equal((heard?.args[1] as { type: string }).type, 'request-end')
    // No hook for it: nothing runs.
    pluginEvent(p.id, 'deploy-end', { ok: true })
    await pluginRunsSettled()
    assert.equal(pluginRuns(p.id, p.key).length, 1)

    chat.length = 0
    for (let i = 0; i < FAILS_TO_TURN_OFF; i++) {
      pluginEvent(p.id, 'handoff-end', { agent: 'codex', status: 'done' })
      await pluginRunsSettled()
    }
    const info = p.info()
    assert.equal(info.status, 'off')
    assert.match(info.offReason ?? '', /last 3 runs from events or schedules failed/)
    assert.match(chat.at(-1)!.text, /Turned Tool off/)
    assert.equal(chat.filter((c) => /^🧩 Tool · Bad failed/.test(c.text)).length, FAILS_TO_TURN_OFF - 1, 'each failure before that is said in the chat')
    // Off, its hooks don't run; turned on again, the reason goes.
    pluginEvent(p.id, 'request-end', { outcome: 'done' })
    await pluginRunsSettled()
    assert.equal(pluginRuns(p.id, p.key).filter((r) => r.command === 'log').length, 1)
    assert.equal(setPluginOff(p.id, p.key, false).offReason, undefined)
    closePanel(token)
  } finally {
    rmSync(p.dir, { recursive: true, force: true })
  }
})

test('schedules run when due, and not while plugins or schedules are paused', async () => {
  const p = project(
    {
      name: 'timed',
      permissions: ['commands'],
      commands: [{ id: 'tick', title: 'Tick', run: ['node', '-e', 'console.log("tick")'] }],
      schedules: [{ id: 'often', command: 'tick', when: { kind: 'every', minutes: 30 } }]
    },
    {}
  )
  try {
    const t0 = new Date()
    tickPluginSchedules(t0)
    await pluginRunsSettled()
    assert.equal(pluginRuns(p.id, p.key).length, 0, 'first seen: due in 30 minutes')
    tickPluginSchedules(new Date(t0.getTime() + 31 * 60_000))
    await pluginRunsSettled()
    assert.equal(pluginRuns(p.id, p.key)[0]?.trigger, 'schedule:often')
    // Paused: the time passes without a run, and nothing is made up for afterwards.
    updateSettings({ pluginsPaused: true })
    tickPluginSchedules(new Date(t0.getTime() + 70 * 60_000))
    updateSettings({ pluginsPaused: false, schedulesPaused: true })
    tickPluginSchedules(new Date(t0.getTime() + 100 * 60_000))
    updateSettings({ schedulesPaused: false })
    await pluginRunsSettled()
    assert.equal(pluginRuns(p.id, p.key).length, 1)
    // Not approved (changed), it doesn't run either.
    writeFileSync(join(p.folder, 'plugin.json'), readFileSync(join(p.folder, 'plugin.json'), 'utf-8').replace('1.0.0', '1.0.1'))
    tickPluginSchedules(new Date(t0.getTime() + 200 * 60_000))
    await pluginRunsSettled()
    assert.equal(pluginRuns(p.id, p.key).length, 1)
  } finally {
    rmSync(p.dir, { recursive: true, force: true })
  }
})

test('over Remote a panel is served under its own address, with its helper script pointed there', () => {
  const p = project({ name: 'remote', permissions: [], panels: [{ id: 'main', title: 'Main', entry: 'panel.html' }] }, { 'panel.html': '<script src="/_starwright/api.js"></script><link href="style.css">', 'style.css': 'p{}' })
  try {
    const opened = openPanel(p.id, p.key, 'main')
    assert.equal(opened.remotePath, `/plugin-panel/${opened.token}/panel.html`)
    const origin = 'https://pc.example.ts.net:7428'
    const page = remotePanelResponse(opened.remotePath, origin)!
    assert.equal(page.status, 200)
    assert.match(page.body.toString(), new RegExp(`src="/plugin-panel/${opened.token}/_starwright/api\\.js"`))
    const policy = page.headers['Content-Security-Policy']
    assert.match(policy, new RegExp(`script-src ${origin}/plugin-panel/${opened.token}/ 'unsafe-inline'`))
    assert.doesNotMatch(policy, /connect-src/)
    assert.equal(remotePanelResponse(`/plugin-panel/${opened.token}/_starwright/api.js`, origin)!.status, 200)
    assert.equal(remotePanelResponse(`/plugin-panel/${opened.token}/style.css`, origin)!.status, 200)
    assert.equal(remotePanelResponse(`/plugin-panel/${'0'.repeat(32)}/panel.html`, origin)!.status, 404)
    assert.equal(remotePanelResponse(`/plugin-panel/${opened.token}/plugin.json`, origin)!.status, 404)
    assert.equal(remotePanelResponse('/index.html', origin), null, "anything else isn't a panel's")
    closePanel(opened.token)
    assert.equal(remotePanelResponse(opened.remotePath, origin)!.status, 404)
  } finally {
    rmSync(p.dir, { recursive: true, force: true })
  }
})

test("plugin_check finds what would stop a plugin working that plugin.json doesn't show", () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-check-'))
  const folder = join(dir, 'checky')
  mkdirSync(folder)
  writeFileSync(
    join(folder, 'plugin.json'),
    JSON.stringify({ name: 'checky', ...BASE, permissions: ['commands'], panels: [{ id: 'p', title: 'P', entry: 'p.html' }], commands: [{ id: 'c', title: 'C', run: ['node', '{plugin}/gone.js'] }] })
  )
  writeFileSync(join(folder, 'p.html'), '<script src="https://cdn.example.com/chart.js"></script><link href="/style.css"><script>starwright.ready.then(</script>')
  writeFileSync(join(folder, 'broken.js'), 'function (')
  const checked = checkPluginFolder(folder, 'checky')
  assert.match(checked.problems.join(), /runs \{plugin\}\/gone\.js, which isn't in the folder/)
  writeFileSync(join(folder, 'gone.js'), 'console.log(1)')
  const again = checkPluginFolder(folder, 'checky')
  assert.deepEqual(again.problems, [])
  const warnings = pluginWarnings(again.files!, again.manifest).join('\n')
  assert.match(warnings, /broken\.js doesn't parse/)
  assert.match(warnings, /p\.html \(script 2\) doesn't parse/)
  assert.match(warnings, /doesn't load it: add <script src="\/_starwright\/api\.js">/)
  assert.match(warnings, /from the internet: a panel can't/)
  assert.match(warnings, /a path from the top/)
  rmSync(dir, { recursive: true, force: true })
})

test('the TODO Finder example scans a project and hands its panel the list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'todo-project-'))
  writeFileSync(join(dir, 'app.js'), 'const a = 1 // TODO: make this configurable\nconst s = "TODO not a comment"\nconst t = \'FIXME: in a string\'\n')
  writeFileSync(join(dir, 'tool.py'), '# FIXME: handle errors\n')
  const id = recordProjectOpened(dir).id
  const key = 'global:todo-finder'
  rmSync(join(globalPluginsFolder(), 'todo-finder'), { recursive: true, force: true })
  try {
    addExamplePlugin('todo-finder')
    const info = listPlugins(id).plugins.find((p) => p.key === key)!
    assert.equal(info.status, 'needs-approval')
    assert.deepEqual(info.manifest!.permissions, ['commands', 'chat:draft'])
    approvePlugin(id, key, info.hash!)
    const run = await runPluginCommand(id, key, 'scan', 'button')
    assert.equal(run.ok, true, run.output)
    const result = run.result as { items: { path: string; line: number; kind: string; text: string }[]; scanned: number }
    assert.deepEqual(
      result.items.map((i) => [i.path, i.line, i.kind, i.text]),
      [
        ['app.js', 1, 'TODO', 'make this configurable'],
        ['tool.py', 1, 'FIXME', 'handle errors']
      ]
    )
    assert.match(run.status ?? '', /Found 2 \(1 TODO, 1 FIXME\)/)
    // After a request changes files it scans by itself, and says so in the chat when there are more.
    writeFileSync(join(dir, 'more.js'), '// TODO: and this\n')
    chat.length = 0
    pluginEvent(id, 'files-changed', { files: ['more.js'] })
    await pluginRunsSettled()
    assert.equal(pluginRuns(id, key)[0].trigger, 'hook:files-changed')
    assert.match(chat.map((c) => c.text).join('\n'), /1 new TODO comment since the last scan \(3 in all\)/)
    // Its panel can put a request in the message box: Starwright hands back the text, nothing is sent.
    const { token } = openPanel(id, key, 'list')
    assert.deepEqual(await callPlugin(token, 'chat.draft', ['Fix the TODO in app.js']), { draft: 'Fix the TODO in app.js' })
    await assert.rejects(callPlugin(token, 'notify', ['hi']), /wasn't given "notify"/)
    closePanel(token)
  } finally {
    rmSync(join(globalPluginsFolder(), 'todo-finder'), { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
    assert.ok(!existsSync(join(globalPluginsFolder(), 'todo-finder')))
  }
})
