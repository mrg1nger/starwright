import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'fs'
import { join } from 'path'
import type { VibeEvent } from '@shared/types'
import { ensureModelLoaded, forgetLmStudioStatus, lmStudioStatus, unloadIdleModels } from '../../src/main/cli/lmStudio'
import { memoryDb } from '../../src/main/memory/paths'
import { usageSummary } from '../../src/main/memory/store'
import { updateSettings } from '../../src/main/settings/store'
import { makeProject, projectId, testSession, turn } from '../support/fixtures'

// The local model (VibeApp's own coding agent on LM Studio) taking a hand-off from
// a real Claude session. Needs LM Studio's server running with a model loaded;
// skipped otherwise. Claude (Haiku) spends a little plan; the local model nothing.

const MINUTES = 60_000

test('Claude hands a task to the local model and gets back the files changed', { timeout: 15 * MINUTES }, async (t) => {
  const status = await lmStudioStatus('http://localhost:1234')
  if (!status.running || !status.models.some((m) => m.loaded)) return t.skip('LM Studio is not running with a model loaded')
  updateSettings({ claudeModel: 'haiku', autoMemory: false, localHandoffs: true, lmStudioUrl: 'http://localhost:1234', lmStudioModel: null })
  forgetLmStudioStatus()
  const pid = projectId('local-handoff')
  const since = new Date(Date.now() - 1000).toISOString()
  const dir = makeProject()
  const s = testSession(t, pid, dir)
  const events = await turn(
    s,
    'Use the run_subtask tool with agent "local" (do not edit any files yourself) to have the local model create util.js exporting a function add(a, b) that returns their sum. Then reply DONE.',
    14 * MINUTES
  )
  const call = events.find((e) => e.type === 'tool_call' && e.name === 'mcp__vibe_tools__run_subtask') as Extract<VibeEvent, { type: 'tool_call' }> | undefined
  assert.ok(call, 'Claude called run_subtask')
  const result = events.find((e) => e.type === 'tool_result' && e.toolUseId === call.toolUseId) as Extract<VibeEvent, { type: 'tool_result' }> | undefined
  const text = Array.isArray(result?.raw) ? (result!.raw as { text?: string }[]).map((b) => b.text ?? '').join('\n') : String(result?.summary)
  assert.match(text, /Local model hand-off.*files changed: .*util\.js/s, text)
  assert.ok(existsSync(join(dir, 'util.js')))
  const add = require(join(dir, 'util.js')) as { add?: (a: number, b: number) => number } | ((a: number, b: number) => number)
  assert.equal(typeof add === 'function' ? add(2, 3) : add.add?.(2, 3), 5)
  assert.ok(events.some((e) => e.type === 'delegation_activity'), "the local model's steps reached the chat")
  assert.ok(usageSummary(memoryDb(), since, pid).some((r) => r.kind === 'handoff (lmstudio)'), 'logged as LM Studio usage')
})

test('a simple hand-off with no agent named goes to the free local model first', { timeout: 15 * MINUTES }, async (t) => {
  const status = await lmStudioStatus('http://localhost:1234')
  if (!status.running || !status.models.some((m) => m.loaded)) return t.skip('LM Studio is not running with a model loaded')
  updateSettings({ claudeModel: 'haiku', autoMemory: false, localHandoffs: true, clineHandoffs: false, lmStudioUrl: 'http://localhost:1234', lmStudioModel: null })
  forgetLmStudioStatus()
  const pid = projectId('routed-handoff')
  const since = new Date(Date.now() - 1000).toISOString()
  const dir = makeProject()
  const s = testSession(t, pid, dir)
  const events = await turn(
    s,
    'Use the run_subtask tool (do not edit any files yourself, and do not name an agent) to hand off this simple boilerplate task: create util.js exporting a function add(a, b) that returns their sum. Then reply DONE.',
    14 * MINUTES
  )
  const call = events.find((e) => e.type === 'tool_call' && e.name === 'mcp__vibe_tools__run_subtask') as Extract<VibeEvent, { type: 'tool_call' }> | undefined
  assert.ok(call, 'Claude called run_subtask')
  assert.equal((call.input as { agent?: string }).agent, undefined, 'no agent named')
  const result = events.find((e) => e.type === 'tool_result' && e.toolUseId === call.toolUseId) as Extract<VibeEvent, { type: 'tool_result' }> | undefined
  const text = Array.isArray(result?.raw) ? (result!.raw as { text?: string }[]).map((b) => b.text ?? '').join('\n') : String(result?.summary)
  assert.match(text, /Starwright gave this simple \w+ task to the local model/, text)
  assert.ok(events.some((e) => e.type === 'delegation_progress' && /^Handed to the local model/.test(e.note)), 'the chat card learned the agent')
  const row = memoryDb().prepare('SELECT agent, task_kind, difficulty, checks_ok FROM handoffs WHERE project_id = ? AND started_at >= ?').get(pid, since) as Record<string, unknown>
  assert.equal(row.agent, 'local')
  assert.equal(row.difficulty, 'simple')
  assert.ok(row.task_kind, 'the kind of task is recorded')
})

test("the local model's commands see the project's secrets", { timeout: 15 * MINUTES }, async (t) => {
  const status = await lmStudioStatus('http://localhost:1234')
  if (!status.running || !status.models.some((m) => m.loaded)) return t.skip('LM Studio is not running with a model loaded')
  updateSettings({ claudeModel: 'haiku', autoMemory: false, localHandoffs: true, lmStudioUrl: 'http://localhost:1234', lmStudioModel: null })
  forgetLmStudioStatus()
  const pid = projectId('handoff-secrets')
  const { setSecret } = await import('../../src/main/secrets/vault')
  setSecret(pid, 'DEMO_SERVICE_TOKEN', 'demo-token-value-123')
  const dir = makeProject()
  const s = testSession(t, pid, dir)
  await turn(
    s,
    'Use the run_subtask tool with agent "local" (do not edit or run anything yourself) to have the local model write a file check.js containing: require("fs").writeFileSync("out.txt", process.env.DEMO_SERVICE_TOKEN ? "yes" : "no") and then run node check.js. Then reply DONE.',
    14 * MINUTES
  )
  assert.ok(existsSync(join(dir, 'out.txt')), 'the command ran')
  assert.equal(require('fs').readFileSync(join(dir, 'out.txt'), 'utf8'), 'yes', 'the secret reached the command')
})

test("with the model not loaded, the hand-off loads it with Settings' context first", { timeout: 15 * MINUTES }, async (t) => {
  const status = await lmStudioStatus('http://localhost:1234')
  if (!status.running || !status.models.length) return t.skip('LM Studio is not running with a model downloaded')
  if (status.models.some((m) => m.loaded)) return t.skip('a model is loaded (unload it in LM Studio to run this)')
  updateSettings({ claudeModel: 'haiku', autoMemory: false, localHandoffs: true, lmStudioUrl: 'http://localhost:1234', lmStudioModel: null, lmStudioContextLength: 32_768 })
  forgetLmStudioStatus()
  const dir = makeProject()
  const s = testSession(t, projectId('local-load'), dir)
  const events = await turn(
    s,
    'Use the run_subtask tool with agent "local" (do not edit any files yourself) to have the local model create util.js exporting a function add(a, b) that returns their sum. Then reply DONE.',
    14 * MINUTES
  )
  const steps = events.flatMap((e) => (e.type === 'delegation_activity' ? [e.activity.text] : []))
  console.log(steps.filter((x) => /load/i.test(x)).join('\n'))
  assert.ok(steps.some((x) => /^Loading .* in LM Studio \(32,768 tokens of context\)/.test(x)), 'the hand-off said it was loading the model')
  assert.ok(steps.some((x) => /^Loaded .* \(32,768 tokens of context\)/.test(x)), 'and when it was loaded')
  assert.ok(existsSync(join(dir, 'util.js')), 'the work was done')
  const after = await lmStudioStatus('http://localhost:1234')
  const loaded = after.models.filter((m) => m.loaded)
  assert.equal(loaded.length, 1, 'one model loaded')
  assert.equal(loaded[0].contextLength, 32_768, "with Settings' context")
})

test('a model Starwright loaded is unloaded again from the real LM Studio once unused, and not before', { timeout: 10 * MINUTES }, async (t) => {
  const status = await lmStudioStatus('http://localhost:1234')
  if (!status.running || !status.models.length) return t.skip('LM Studio is not running with a model downloaded')
  // Starts from nothing loaded (an earlier test may have loaded it).
  for (const m of status.models.filter((m) => m.loaded)) {
    await fetch('http://localhost:1234/api/v1/models/unload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instance_id: m.id }) })
  }
  updateSettings({ lmStudioUrl: 'http://localhost:1234', lmStudioModel: null, lmStudioContextLength: 32_768, lmStudioUnloadMinutes: 60 })
  forgetLmStudioStatus()
  const model = status.models[0].id
  forgetLmStudioStatus()
  const ready = await ensureModelLoaded(model)
  assert.equal(ready.loadedNow, true)
  const loadedNow = async (): Promise<boolean> => (await lmStudioStatus('http://localhost:1234')).models.some((m) => m.id === model && m.loaded)
  assert.ok(await loadedNow(), 'loaded')
  assert.deepEqual(await unloadIdleModels(Date.now() + 30 * MINUTES), [], 'kept while recently used')
  assert.ok(await loadedNow(), 'still loaded')
  assert.deepEqual(await unloadIdleModels(Date.now() + 61 * MINUTES), [model])
  assert.ok(!(await loadedNow()), 'unloaded from LM Studio')
})
