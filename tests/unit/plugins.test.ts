import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseManifest } from '@shared/plugins'
import { recordProjectOpened } from '../../src/main/projects/store'
import {
  addExamplePlugin,
  approvePlugin,
  closePanel,
  EXAMPLE_PLUGIN,
  examplesFolder,
  globalPluginsFolder,
  listPlugins,
  openPanel,
  panelResponse,
  setPluginOff
} from '../../src/main/plugins/registry'
import { callPlugin, MAX_STORAGE_BYTES } from '../../src/main/plugins/calls'
import { PANEL_API_SCRIPT } from '../../src/main/plugins/panelApi'
import { checkRemoteCall } from '../../src/main/remote/auth'
import { memoryDb } from '../../src/main/memory/paths'
import { finishHandoff, logRequest, startHandoff } from '../../src/main/memory/store'

const MANIFEST = {
  name: 'demo',
  title: 'Demo',
  version: '1.0.0',
  description: 'A test plugin.',
  permissions: ['storage'],
  panels: [{ id: 'main', title: 'Main', entry: 'panel.html' }]
}

/** A project in the list with one plugin of its own. */
function projectWithPlugin(manifest: Record<string, unknown> = MANIFEST): { id: string; dir: string; plugin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'plugins-project-'))
  const plugin = join(dir, '.starwright', 'plugins', String(manifest.name))
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify(manifest))
  writeFileSync(join(plugin, 'panel.html'), '<!doctype html><script src="/_starwright/api.js"></script><p>v1</p>')
  writeFileSync(join(plugin, 'app.js'), 'console.log(1)')
  return { id: recordProjectOpened(dir).id, dir, plugin }
}

const one = (projectId: string) => listPlugins(projectId).plugins.find((p) => p.scope === 'project')!

test('plugin.json is checked: name, version, known permissions, panels inside the folder', () => {
  assert.deepEqual(parseManifest(MANIFEST, 'demo').problems, [])
  const bad = parseManifest(
    { ...MANIFEST, name: 'Demo!', version: 'one', permissions: ['storage', 'network'], panels: [{ id: 'x', title: 'X', entry: '../outside.html' }] },
    'demo'
  ).problems.join('\n')
  assert.match(bad, /lower-case letters/)
  assert.match(bad, /must match/)
  assert.match(bad, /1\.0\.0/)
  assert.match(bad, /Unknown permission "network"/)
  assert.match(bad, /inside the plugin's folder/)
  assert.match(parseManifest({ ...MANIFEST, panels: [] }, 'demo').problems.join(), /at least one panel or command/)
  assert.match(parseManifest([], 'demo').problems.join(), /JSON object/)
  // The example Starwright comes with passes its own check.
  for (const name of [EXAMPLE_PLUGIN, 'todo-finder']) {
    const example = JSON.parse(readFileSync(join(examplesFolder(), name, 'plugin.json'), 'utf-8'))
    assert.deepEqual(parseManifest(example, name).problems, [], name)
  }
})

test('a plugin runs only as approved: what you saw, and again after any change', () => {
  const { id, plugin } = projectWithPlugin()
  try {
    let info = one(id)
    assert.equal(info.status, 'needs-approval')
    assert.deepEqual(info.newPermissions, ['storage'])
    assert.throws(() => openPanel(id, info.key, 'main'), /needs approving/)
    // Changed while you were looking: the fingerprint you saw no longer matches.
    assert.throws(() => approvePlugin(id, info.key, 'not-what-it-is'), /changed while you were looking/)
    info = approvePlugin(id, info.key, info.hash!)
    assert.equal(info.status, 'approved')

    writeFileSync(join(plugin, 'app.js'), 'console.log(2)')
    info = one(id)
    assert.equal(info.status, 'changed')
    assert.deepEqual(info.newPermissions, [])
    assert.throws(() => openPanel(id, info.key, 'main'), /approve it again/)
    info = approvePlugin(id, info.key, info.hash!)

    // Asking for more is a change too, and says what's new.
    writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ ...MANIFEST, permissions: ['storage', 'files:read'] }))
    info = one(id)
    assert.equal(info.status, 'changed')
    assert.deepEqual(info.newPermissions, ['files:read'])
    info = approvePlugin(id, info.key, info.hash!)

    info = setPluginOff(id, info.key, true)
    assert.equal(info.status, 'off')
    assert.throws(() => openPanel(id, info.key, 'main'), /turned off/)
    assert.equal(setPluginOff(id, info.key, false).status, 'approved')
  } finally {
    rmSync(plugin, { recursive: true, force: true })
  }
})

test('a broken plugin says why: bad JSON, a missing page, a link leading out of its folder', () => {
  const { id, plugin, dir } = projectWithPlugin()
  writeFileSync(join(plugin, 'plugin.json'), '{ nope')
  assert.match(one(id).problems.join(), /isn't valid JSON/)
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ ...MANIFEST, panels: [{ id: 'main', title: 'Main', entry: 'gone.html' }] }))
  assert.match(one(id).problems.join(), /gone\.html, which isn't in the folder/)
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify(MANIFEST))
  const outside = mkdtempSync(join(tmpdir(), 'plugins-outside-'))
  symlinkSync(outside, join(plugin, 'escape'), 'junction')
  const info = one(id)
  assert.equal(info.status, 'broken')
  assert.match(info.problems.join(), /is a link/)
  rmSync(join(plugin, 'escape'))
  rmSync(dir, { recursive: true, force: true })
})

test("an open panel is served from a copy of its approved files, with a policy that lets it reach nothing else", () => {
  const { id, plugin } = projectWithPlugin()
  const key = one(id).key
  approvePlugin(id, key, one(id).hash!)
  const opened = openPanel(id, key, 'main')
  assert.match(opened.url, /^starwright-plugin:\/\/[0-9a-f]{32}\/panel\.html$/)
  const page = panelResponse(opened.url)
  assert.equal(page.status, 200)
  assert.match(page.headers['Content-Type'], /text\/html/)
  const policy = page.headers['Content-Security-Policy']
  assert.match(policy, /default-src 'none'/)
  assert.match(policy, new RegExp(`script-src starwright-plugin://${opened.token} 'unsafe-inline'`))
  assert.doesNotMatch(policy, /connect-src|https?:/)
  assert.match(page.body.toString(), /v1/)
  // The helper script, at the same path in every panel.
  assert.equal(panelResponse(opened.url.replace('panel.html', '_starwright/api.js')).body.toString(), PANEL_API_SCRIPT)
  // A file changed after it opened isn't served: the copy is.
  writeFileSync(join(plugin, 'panel.html'), '<p>v2</p>')
  assert.match(panelResponse(opened.url).body.toString(), /v1/)
  // plugin.json, files that aren't there, and other tokens are not served.
  assert.equal(panelResponse(opened.url.replace('panel.html', 'plugin.json')).status, 404)
  assert.equal(panelResponse(opened.url.replace('panel.html', 'nope.js')).status, 404)
  assert.equal(panelResponse(opened.url.replace(opened.token, '0'.repeat(32))).status, 404)
  assert.equal(panelResponse(`starwright-plugin://${opened.token}/../../etc/passwd`).status, 404)
  closePanel(opened.token)
  assert.equal(panelResponse(opened.url).status, 404)
  rmSync(plugin, { recursive: true, force: true })
})

test('calls are answered within the approved permissions, for the project the panel is open in', async () => {
  const { id, dir, plugin } = projectWithPlugin({ ...MANIFEST, name: 'calls' })
  writeFileSync(join(dir, 'notes.txt'), 'hello')
  writeFileSync(join(dir, '.env'), 'KEY=secret')
  const key = one(id).key
  approvePlugin(id, key, one(id).hash!)
  const { token } = openPanel(id, key, 'main')

  const hello = (await callPlugin(token, 'hello', [])) as { plugin: { name: string }; permissions: string[] }
  assert.equal(hello.plugin.name, 'calls')
  assert.deepEqual(hello.permissions, ['storage'])
  await assert.rejects(callPlugin(token, 'files.list', []), /wasn't given "files:read"/)
  await assert.rejects(callPlugin(token, 'records.requests', [{ days: 7 }]), /wasn't given "records:read"/)
  await assert.rejects(callPlugin(token, 'shell.run', ['rm -rf /']), /no "shell\.run"/)
  await assert.rejects(callPlugin('0'.repeat(32), 'hello', []), /closed/)

  assert.equal(await callPlugin(token, 'storage.get', ['days']), null)
  assert.equal(await callPlugin(token, 'storage.set', ['days', 30]), true)
  assert.equal(await callPlugin(token, 'storage.get', ['days']), 30)
  assert.deepEqual(await callPlugin(token, 'storage.keys', []), ['days'])
  await assert.rejects(callPlugin(token, 'storage.set', ['big', 'x'.repeat(400_000)]), /too big/, 'one call is at most 300 KB')
  // The store as a whole: 1 MB.
  for (let i = 0; i < 3; i++) await callPlugin(token, 'storage.set', [`part${i}`, 'x'.repeat(280_000)])
  await assert.rejects(callPlugin(token, 'storage.set', ['part3', 'x'.repeat(280_000)]), new RegExp(`over ${MAX_STORAGE_BYTES / 1024} KB`))
  for (let i = 0; i < 3; i++) await callPlugin(token, 'storage.remove', [`part${i}`])
  await assert.rejects(callPlugin(token, 'storage.set', ['', 1]), /storage key/)
  assert.equal(await callPlugin(token, 'storage.remove', ['days']), true)
  assert.deepEqual(await callPlugin(token, 'storage.keys', []), [])

  // With files:read and records:read approved.
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ ...MANIFEST, name: 'calls', permissions: ['files:read', 'records:read'] }))
  approvePlugin(id, key, one(id).hash!)
  const full = openPanel(id, key, 'main').token
  await assert.rejects(callPlugin(token, 'hello', []), /closed/, 'approving again closes what was open')
  const files = (await callPlugin(full, 'files.list', [])) as { files: string[] }
  assert.ok(files.files.includes('notes.txt'))
  assert.deepEqual(await callPlugin(full, 'files.read', ['notes.txt']), { kind: 'text', path: 'notes.txt', size: 5, text: 'hello', truncated: false })
  assert.equal(((await callPlugin(full, 'files.read', ['.env'])) as { kind: string }).kind, 'secret')
  await assert.rejects(callPlugin(full, 'files.read', ['../outside.txt']), /Not a file in this project/)
  await assert.rejects(callPlugin(full, 'storage.get', ['days']), /wasn't given "storage"/)

  const db = memoryDb()
  const zero = { fresh: 0, cached: 0, output: 0 }
  const at = new Date().toISOString()
  logRequest(db, {
    at,
    projectId: id,
    mode: 'build',
    balance: null,
    route: null,
    size: 'small',
    model: 'sonnet',
    text: 'make the shop bigger',
    outcome: 'done',
    seconds: 40,
    claudeSteps: 3,
    tools: {},
    handoffs: 1,
    claude: { fresh: 100, cached: 900, output: 50 },
    codex: zero,
    cline: { fresh: 7, cached: 0, output: 3 }
  })
  logRequest(db, { at, projectId: 'another-project', mode: 'build', balance: null, route: null, size: null, model: null, text: 'not this one', outcome: 'done', seconds: 1, claudeSteps: 1, tools: {}, handoffs: 0, claude: zero, codex: zero, cline: zero })
  const handoff = startHandoff(db, id, 'codex', 'Make the shop bigger', null, { kind: 'feature' })
  finishHandoff(db, handoff, { status: 'done', report: 'Done.', files: ['shop.js', 'style.css'], model: 'gpt-5.5' })
  const requests = (await callPlugin(full, 'records.requests', [{ days: 1 }])) as { text: string; outcome: string; claude: { cached: number }; cline: { fresh: number } }[]
  assert.equal(requests.length, 1, "only this project's")
  assert.equal(requests[0].text, 'make the shop bigger')
  assert.equal(requests[0].claude.cached, 900)
  assert.equal(requests[0].cline.fresh, 7)
  const handoffs = (await callPlugin(full, 'records.handoffs', [{ days: 1 }])) as { agent: string; status: string; files: number; kind: string; model: string }[]
  assert.deepEqual(
    handoffs.map((h) => [h.agent, h.status, h.files, h.kind, h.model]),
    [['codex', 'done', 2, 'feature', 'gpt-5.5']]
  )
  assert.deepEqual(await callPlugin(full, 'records.schedules', []), [])
  rmSync(dir, { recursive: true, force: true })
})

test('the example can be added for every project, once', () => {
  const { id } = projectWithPlugin({ ...MANIFEST, name: 'other' })
  rmSync(join(globalPluginsFolder(), EXAMPLE_PLUGIN), { recursive: true, force: true })
  assert.ok(listPlugins(id).examples.some((e) => e.name === EXAMPLE_PLUGIN))
  addExamplePlugin()
  const example = listPlugins(id).plugins.find((p) => p.key === `global:${EXAMPLE_PLUGIN}`)!
  assert.equal(example.status, 'needs-approval')
  assert.deepEqual(example.manifest!.permissions, ['records:read', 'files:read', 'storage'])
  assert.ok(!listPlugins(id).examples.some((e) => e.name === EXAMPLE_PLUGIN))
  assert.throws(() => addExamplePlugin('not-an-example'), /doesn't come with/)
  assert.throws(() => addExamplePlugin(), /already there/)
  // A plugin for every project is approved once, for all of them.
  approvePlugin(id, example.key, example.hash!)
  const elsewhere = projectWithPlugin({ ...MANIFEST, name: 'elsewhere' })
  assert.equal(listPlugins(elsewhere.id).plugins.find((p) => p.key === example.key)!.status, 'approved')
  rmSync(join(globalPluginsFolder(), EXAMPLE_PLUGIN), { recursive: true, force: true })
})

test('the panel helper script is valid JavaScript, and over Remote plugins are looked at and used, not approved', () => {
  assert.doesNotThrow(() => new Function(PANEL_API_SCRIPT))
  // Deciding what runs on this computer stays at it, whatever the device.
  for (const channel of ['vibe:plugins:approve', 'vibe:plugins:setOff', 'vibe:plugins:addExample', 'vibe:plugins:openFolder', 'vibe:plugins:setPaused']) {
    for (const readOnly of [false, true]) {
      const check = checkRemoteCall(channel, ['p'], readOnly)
      assert.equal(check.allowed, false, channel)
      assert.match(check.reason ?? '', /computer running Starwright/)
    }
  }
  // A device with full access can open panels and run approved commands.
  for (const channel of ['vibe:plugins:list', 'vibe:plugins:openPanel', 'vibe:plugins:run', 'vibe:plugins:stop', 'vibe:plugins:runs']) {
    assert.equal(checkRemoteCall(channel, ['p'], false).allowed, true, channel)
  }
  assert.equal(checkRemoteCall('vibe:plugins:call', ['t', 'commands.run', ['scan']], false).allowed, true)
  // A read-only one can look: list, open panels, and only the calls that read.
  for (const channel of ['vibe:plugins:list', 'vibe:plugins:openPanel', 'vibe:plugins:closePanel', 'vibe:plugins:runs']) {
    assert.equal(checkRemoteCall(channel, ['p'], true).allowed, true, channel)
  }
  for (const method of ['hello', 'records.requests', 'storage.get', 'files.list', 'commands.runs']) {
    assert.equal(checkRemoteCall('vibe:plugins:call', ['t', method, []], true).allowed, true, method)
  }
  for (const method of ['commands.run', 'storage.set', 'storage.remove', 'notify', 'files.read', 'anything']) {
    const check = checkRemoteCall('vibe:plugins:call', ['t', method, []], true)
    assert.equal(check.allowed, false, method)
    assert.match(check.reason ?? '', /read-only/)
  }
  for (const channel of ['vibe:plugins:run', 'vibe:plugins:stop']) assert.equal(checkRemoteCall(channel, ['p'], true).allowed, false, channel)
})
