import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyEdit, projectPath, runLocalAgent, trimConversation } from '../../src/main/local/localAgent'
import { forgetLmStudioStatus } from '../../src/main/cli/lmStudio'
import { updateSettings } from '../../src/main/settings/store'
import type { DelegationActivity } from '@shared/types'

// A stand-in LM Studio that plays back a script of model turns (tool calls, then a report).
type Turn = { calls?: [string, Record<string, unknown>][]; say?: string }
let script: Turn[] = []
/** What the stand-in says each prompt cost: raise it to make the conversation look full, so it gets trimmed. */
let promptTokens = 100
/** How long the stand-in takes over each model turn. */
let replyDelayMs = 0
const requests: { messages: { role: string; content: string }[]; reasoning_effort?: string }[] = []

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/api/v0/models') return res.end(JSON.stringify({ data: [{ id: 'coder', type: 'llm', state: 'loaded', loaded_context_length: 32000 }] }))
    // Already loaded: Starwright uses it as it is (it never loads a second copy).
    if (req.url === '/api/v1/models') return res.end(JSON.stringify({ models: [{ type: 'llm', key: 'coder', max_context_length: 131072, loaded_instances: [{ id: 'coder', config: { context_length: 32000 } }] }] }))
    requests.push(JSON.parse(raw))
    const turn = script.shift() ?? { say: 'Done.' }
    const message = turn.calls
      ? { content: '', tool_calls: turn.calls.map(([name, args], i) => ({ id: `c${requests.length}-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }
      : { content: turn.say }
    const body = JSON.stringify({ model: 'coder', choices: [{ message, finish_reason: turn.calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: 10 } })
    if (replyDelayMs) setTimeout(() => res.end(body), replyDelayMs)
    else res.end(body)
  })
})

let dir = ''
const temps: string[] = []
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  updateSettings({ lmStudioUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, lmStudioModel: null })
  forgetLmStudioStatus()
})
after(() => {
  server.close()
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

const project = (files: Record<string, string>): string => {
  dir = mkdtempSync(join(tmpdir(), 'vibeapp-unit-local-'))
  temps.push(dir)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

test('edits: exact text, other line endings, trailing spaces; refused when missing or ambiguous', () => {
  assert.deepEqual(applyEdit('a = 1\nb = 2\n', 'b = 2', 'b = 3'), { content: 'a = 1\nb = 3\n' })
  // The file has Windows line endings, the model's text doesn't: kept as Windows endings.
  assert.deepEqual(applyEdit('one\r\ntwo\r\nthree\r\n', 'two\nthree', 'TWO\nTHREE'), { content: 'one\r\nTWO\r\nTHREE\r\n' })
  // Trailing spaces in the file the model didn't copy.
  assert.deepEqual(applyEdit('if (x) {   \n  go()\n}\n', 'if (x) {\n  go()', 'if (y) {\n  go()'), { content: 'if (y) {\n  go()\n}\n' })
  assert.match((applyEdit('x\nx\n', 'x', 'y') as { error: string }).error, /appears 2 times/)
  assert.deepEqual(applyEdit('x\nx\n', 'x', 'y', true), { content: 'y\ny\n' })
  assert.match((applyEdit('abc', 'zzz', 'y') as { error: string }).error, /not found/)
  assert.match((applyEdit('abc', '', 'y') as { error: string }).error, /write_file/)
})

test('paths must stay inside the project', () => {
  const root = join(tmpdir(), 'proj')
  assert.equal(projectPath(root, 'src/a.js'), join(root, 'src', 'a.js'))
  assert.equal(projectPath(root, '../other/a.js'), null)
  assert.equal(projectPath(root, join(tmpdir(), 'elsewhere.txt')), null)
  assert.equal(projectPath(root, ''), null)
})

test('old tool output is trimmed, the latest kept', () => {
  const messages = [{ role: 'system' as const, content: 's' }, ...Array.from({ length: 8 }, (_, i) => ({ role: 'tool' as const, content: `out ${i}` }))]
  assert.equal(trimConversation(messages, 6), 2)
  assert.match(messages[1].content, /Earlier output removed/)
  assert.equal(messages[8].content, 'out 7')
  assert.equal(trimConversation(messages, 6), 0, 'nothing more to trim')
})

test('a task runs to the end: reads, edits, runs the tests, reports', async () => {
  const cwd = project({ 'math.js': 'function add(a, b) {\n  return a - b\n}\nmodule.exports = { add }\n' })
  script = [
    { calls: [['read_file', { path: 'math.js' }]] },
    { calls: [['edit_file', { path: 'math.js', old_text: 'return a - b', new_text: 'return a + b' }]] },
    { calls: [['run_command', { command: "node -e \"process.exit(require('./math').add(2, 3) === 5 ? 0 : 1)\"" }]] },
    { say: 'Fixed add() in math.js; the check passes.' }
  ]
  requests.length = 0
  const activity: DelegationActivity[] = []
  const result = await runLocalAgent({ task: 'Fix add.', cwd, onActivity: (a) => activity.push(a) })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.text, 'Fixed add() in math.js; the check passes.')
  assert.equal(result.steps, 4)
  assert.equal(result.usage.fresh, 400)
  assert.match(readFileSync(join(cwd, 'math.js'), 'utf8'), /return a \+ b/)
  // What the model was shown after each call.
  const toolResults = requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => m.content)
  assert.match(toolResults[0], /return a - b/)
  assert.equal(toolResults[1], 'Edited math.js.')
  assert.match(toolResults[2], /^Exit code 0\./)
  assert.ok(activity.some((a) => a.done && a.step === 'edit' && a.text === 'Edited math.js'))
  assert.ok(activity.some((a) => a.done && a.step === 'run' && a.ok === true))
  assert.equal(requests[0].reasoning_effort, 'none', 'thinking is off unless asked for')
})

test('refused: paths outside the project, destructive commands, pushing, .git', async () => {
  const cwd = project({ 'a.txt': 'hello\n' })
  script = [
    { calls: [['read_file', { path: '../../secret.txt' }], ['write_file', { path: join(tmpdir(), 'evil.txt'), content: 'x' }]] },
    { calls: [['run_command', { command: 'rm -rf src' }], ['run_command', { command: 'git push origin main' }]] },
    { calls: [['write_file', { path: '.git/config', content: 'x' }]] },
    { say: 'Could not do it.' }
  ]
  requests.length = 0
  const result = await runLocalAgent({ task: 'Do bad things.', cwd })
  assert.equal(result.ok, true)
  assert.equal(result.blocked.length, 5, result.blocked.join(' | '))
  assert.equal(existsSync(join(tmpdir(), 'evil.txt')), false)
  const toolResults = requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => m.content)
  assert.ok(toolResults.every((t) => t.startsWith('BLOCKED by Starwright')), toolResults.join(' | '))
})

test('write_file creates folders; a missing file to edit says to use write_file', async () => {
  const cwd = project({})
  script = [
    { calls: [['write_file', { path: 'src/new/util.js', content: 'module.exports = 1\n' }], ['edit_file', { path: 'nope.js', old_text: 'a', new_text: 'b' }]] },
    { say: 'Created util.js.' }
  ]
  requests.length = 0
  const result = await runLocalAgent({ task: 'Create a file.', cwd })
  assert.equal(result.ok, true)
  assert.equal(readFileSync(join(cwd, 'src', 'new', 'util.js'), 'utf8'), 'module.exports = 1\n')
  const toolResults = requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => m.content)
  assert.deepEqual(toolResults, ['Created src/new/util.js.', 'No file nope.js. Use write_file to create it.'])
})

test('stops: a model repeating itself, running out of steps; thinking when asked for', async () => {
  const cwd = project({ 'a.txt': 'x\n' })
  script = Array.from({ length: 5 }, () => ({ calls: [['read_file', { path: 'a.txt' }]] as [string, Record<string, unknown>][] }))
  let result = await runLocalAgent({ task: 'Loop.', cwd })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /stuck repeating read_file/)

  script = Array.from({ length: 5 }, (_, i) => ({ calls: [['search', { query: `q${i}` }]] as [string, Record<string, unknown>][] }))
  requests.length = 0
  result = await runLocalAgent({ task: 'Search forever.', cwd, maxSteps: 3, thinking: true })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /all 3 steps/)
  assert.equal(requests[0].reasoning_effort, undefined, 'thinking when asked for')
})

test('a model that stops without a report is asked for one', async () => {
  const cwd = project({})
  script = [{ say: '' }, { say: 'Nothing needed changing.' }]
  requests.length = 0
  const result = await runLocalAgent({ task: 'Check.', cwd })
  assert.equal(result.text, 'Nothing needed changing.')
  assert.match(requests[1].messages.at(-1)!.content, /final report now/)
})

test('routing offers the local model only when it can take work, and as a way round a low Codex plan', async () => {
  const { routeMessage } = await import('../../src/main/orchestrator/routing')
  const settings = { smartRouting: true, aiRouting: false, agentBalance: 'codex', claudeModel: 'sonnet' } as unknown as Parameters<typeof routeMessage>[1]
  const withLocal = await routeMessage('Add a shop screen with a sell button', settings, { clineReady: false, localReady: true })
  assert.match(withLocal.note ?? '', /run_subtask/)
  assert.match(withLocal.note ?? '', /the local model/)
  const without = await routeMessage('Add a shop screen with a sell button', settings, { clineReady: false, localReady: false })
  assert.doesNotMatch(without.note ?? '', /local model/)
  const quick = await routeMessage('Make the title blue', { ...settings, agentBalance: 'balanced' }, { clineReady: false, localReady: true })
  assert.doesNotMatch(quick.note ?? '', /local model/, 'not for a quick edit')
  // Switched off in Settings (the default): the readiness check says no without asking LM Studio.
  updateSettings({ localHandoffs: false })
  const off = await routeMessage('Add a shop screen with a sell button', settings, { clineReady: false })
  assert.doesNotMatch(off.note ?? '', /local model/)
})

test("the project's secrets reach the local model's commands, and the hand-off names them without values", async () => {
  const cwd = project({})
  script = [
    { calls: [['run_command', { command: "node -e \"process.exit(process.env.SHOP_API_KEY === 'sk-test-123' ? 0 : 1)\"" }]] },
    { say: 'The key is there.' }
  ]
  requests.length = 0
  const result = await runLocalAgent({ task: 'Check the key.', cwd, env: { SHOP_API_KEY: 'sk-test-123' } })
  assert.equal(result.ok, true, result.error)
  const toolResults = requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => m.content)
  assert.match(toolResults[0], /^Exit code 0\./, 'the command saw the secret')

  const { setSecret, deleteSecret } = await import('../../src/main/secrets/vault')
  const { helperSecretsNote } = await import('../../src/main/secrets/vault')
  setSecret('helper-secrets-project', 'SHOP_API_KEY', 'sk-test-123456')
  setSecret('helper-secrets-project', 'ANTHROPIC_API_KEY', 'sk-ant-hidden-999')
  const note = helperSecretsNote('helper-secrets-project')
  assert.match(note, /SHOP_API_KEY/)
  assert.doesNotMatch(note, /ANTHROPIC_API_KEY/, "Starwright's own keys stay hidden from agents, as from Claude")
  assert.doesNotMatch(note, /sk-test|sk-ant/, 'never a value')
  deleteSecret('helper-secrets-project', 'SHOP_API_KEY')
  deleteSecret('helper-secrets-project', 'ANTHROPIC_API_KEY')
  assert.equal(helperSecretsNote('helper-secrets-project'), '', 'no secrets, no note')
})

test("a secret a command prints is masked in what the model and the chat see (the command still has it)", async () => {
  const cwd = project({})
  script = [
    { calls: [['run_command', { command: 'node -e "console.log(\'HYPERV_PASSWORD=\' + process.env.HYPERV_PASSWORD)"' }]] },
    { say: 'Printed it.' }
  ]
  requests.length = 0
  const activity: DelegationActivity[] = []
  const result = await runLocalAgent({ task: 'Show the env.', cwd, env: { HYPERV_PASSWORD: 'Dragon-test-99!' }, onActivity: (a) => activity.push(a) })
  assert.equal(result.ok, true, result.error)
  const toolResults = requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => m.content)
  assert.match(toolResults[0], /HYPERV_PASSWORD=\[secret HYPERV_PASSWORD\]/, 'the command saw the value; the model sees the label')
  assert.doesNotMatch(JSON.stringify(activity), /Dragon-test-99/, 'nor does the chat')
})

test('a model going round the same files is stopped early, with a warning first; reading after an edit is fine', async () => {
  const cwd = project({ 'a.js': 'a\n', 'b.js': 'b\n', 'c.js': 'c\n' })
  const read = (path: string): Turn => ({ calls: [['read_file', { path }]] })
  // A, B, C, A, B, C…: never the same call twice in a row, so the repeat check alone wouldn't stop it.
  script = Array.from({ length: 12 }, (_, i) => read(['a.js', 'b.js', 'c.js'][i % 3]))
  requests.length = 0
  let result = await runLocalAgent({ task: 'Change a, b and c.', cwd })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /kept reading the same files again \(a\.js 4×, b\.js 3×, c\.js 3×\)/)
  assert.match(result.error ?? '', /32,000 tokens of context/)
  assert.equal(result.steps, 10, 'stopped at the fourth read of a.js, not at the time limit')
  const warned = requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => m.content)
  assert.match(warned[6], /read this 3 times/, 'the third read of a part comes with a warning')

  // Read, change, read again to check: each change starts the count again.
  script = [
    read('a.js'),
    { calls: [['edit_file', { path: 'a.js', old_text: 'a', new_text: 'a1' }]] },
    read('a.js'),
    { calls: [['edit_file', { path: 'a.js', old_text: 'a1', new_text: 'a2' }]] },
    read('a.js'),
    { calls: [['edit_file', { path: 'a.js', old_text: 'a2', new_text: 'a3' }]] },
    read('a.js'),
    read('b.js'),
    read('a.js'),
    { say: 'Done.' }
  ]
  result = await runLocalAgent({ task: 'Change a.', cwd })
  assert.equal(result.ok, true, result.error)
})

test('a model reading again what was removed to save room is stopped after a few such reads', async () => {
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`m${i + 1}.js`, `m${i + 1}\n`]))
  const cwd = project(files)
  const read = (path: string): Turn => ({ calls: [['read_file', { path }]] })
  // Each prompt fills 25,000 of the 32,000 tokens, so all but the last 6 results are removed: by the
  // tenth read, m1–m4 are gone, and it reads them again. No part is read a third time and there are
  // only 4 re-reads in all, so only the removed-then-read-again count stops it.
  promptTokens = 25_000
  try {
    script = [...Array.from({ length: 10 }, (_, i) => read(`m${i + 1}.js`)), read('m1.js'), read('m2.js'), read('m3.js'), read('m4.js'), read('m5.js')]
    let result = await runLocalAgent({ task: 'Summarise m1 to m10.', cwd })
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /kept reading the same files again \(m1\.js 2×/)
    assert.match(result.error ?? '', /32,000 tokens of context/)
    assert.equal(result.steps, 14, 'stopped at the fourth read of something it had lost')

    // Getting back one lost file to make the change is fine.
    script = [...Array.from({ length: 10 }, (_, i) => read(`m${i + 1}.js`)), read('m1.js'), { calls: [['edit_file', { path: 'm1.js', old_text: 'm1', new_text: 'm1 done' }]] }, { say: 'Done.' }]
    result = await runLocalAgent({ task: 'Change m1.', cwd })
    assert.equal(result.ok, true, result.error)
  } finally {
    promptTokens = 100
  }
})

test('slow steps with a context more than half full hand the task over; slow steps with room, or the first one, do not', async () => {
  const cwd = project({ 'a.js': 'a\n', 'b.js': 'b\n', 'c.js': 'c\n' })
  const read = (path: string): Turn => ({ calls: [['read_file', { path }]] })
  replyDelayMs = 60
  try {
    promptTokens = 20_000 // with the reply, about 63% of 32,000
    script = [read('a.js'), read('b.js'), read('c.js'), { say: 'Done.' }]
    let result = await runLocalAgent({ task: 'Read a, b and c.', cwd, slowStepMs: 30 })
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /steps got slow \(\d+ s for the last one, with its 32,000 tokens of context 63% full\)/)
    assert.equal(result.steps, 2, 'the first step (which may load the model) is let off')

    promptTokens = 10_000 // 31%: slow, but it has room, so it's just slow hardware
    script = [read('a.js'), read('b.js'), read('c.js'), { say: 'Done.' }]
    result = await runLocalAgent({ task: 'Read a, b and c.', cwd, slowStepMs: 30 })
    assert.equal(result.ok, true, result.error)
  } finally {
    replyDelayMs = 0
    promptTokens = 100
  }
})

test('trimmed output says what was removed', () => {
  const messages = [
    { role: 'system' as const, content: 's' },
    { role: 'tool' as const, content: 'file text', tool_call_id: 'c1' },
    { role: 'tool' as const, content: 'more text', tool_call_id: 'c2' },
    { role: 'tool' as const, content: 'latest', tool_call_id: 'c3' }
  ]
  const labels = new Map([['c1', 'read_file src/vms.ts'], ['c2', 'read_file src/vms.ts from line 401']])
  assert.equal(trimConversation(messages, 1, labels), 2)
  assert.match(messages[1].content, /^\[Earlier output removed to save room: read_file src\/vms\.ts\./)
  assert.match(messages[2].content, /from line 401/)
  assert.equal(trimConversation(messages, 1, labels), 0, 'a labelled note is not trimmed again')
  const told: string[] = []
  messages.push({ role: 'tool' as const, content: 'newest', tool_call_id: 'c4' })
  trimConversation(messages, 1, labels, (id) => told.push(id))
  assert.deepEqual(told, ['c3'], 'the caller hears which results were removed')
})

test('a command outside the project goes to the user, as for Claude: Allow runs it, Deny refuses it', async () => {
  const cwd = project({ 'a.txt': 'hello\n' })
  const asked: string[] = []
  script = [
    { calls: [['run_command', { command: 'node -e "console.log(1)" > /tmp/out-allowed' }]] },
    { calls: [['run_command', { command: 'node -e "console.log(2)" > /tmp/out-denied' }]] },
    { calls: [['run_command', { command: 'rm -rf src' }]] },
    { say: 'Done.' }
  ]
  requests.length = 0
  const result = await runLocalAgent({
    task: 'Write outside.',
    cwd,
    ask: async (command) => {
      asked.push(command)
      return command.includes('allowed')
    }
  })
  assert.deepEqual(asked, ['node -e "console.log(1)" > /tmp/out-allowed', 'node -e "console.log(2)" > /tmp/out-denied'], 'destructive commands are refused without asking')
  assert.deepEqual(result.blocked, ['working outside the project folder', 'deleting folders with rm -r'])
  const toolResults = requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => m.content)
  assert.match(toolResults[0], /^Exit code 0\./)
  assert.match(toolResults[1], /^BLOCKED by Starwright/)
})
