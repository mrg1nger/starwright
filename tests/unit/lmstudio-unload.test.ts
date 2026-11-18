import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ensureModelLoaded, holdModel, unloadIdleModels } from '../../src/main/cli/lmStudio'
import { updateSettings } from '../../src/main/settings/store'

const QWEN = 'qwen/qwen3.6-35b-a3b'
const MIN = 60_000

/** A fake LM Studio: Qwen loaded or not, recording loads and unloads. */
function fakeLmStudio(t: { mock: { method: (o: object, k: string, f: unknown) => void } }, startLoaded = false) {
  const state = { loaded: startLoaded, loads: 0, unloads: [] as string[] }
  t.mock.method(globalThis, 'fetch', async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    if (String(url).endsWith('/api/v1/models/load')) {
      state.loaded = true
      state.loads++
      return Response.json({ type: 'llm', instance_id: QWEN, status: 'loaded', load_config: { context_length: body.context_length } })
    }
    if (String(url).endsWith('/api/v1/models/unload')) {
      state.loaded = false
      state.unloads.push(body.instance_id)
      return Response.json({ instance_id: body.instance_id })
    }
    return Response.json({
      models: [{ type: 'llm', key: QWEN, max_context_length: 262_144, loaded_instances: state.loaded ? [{ id: QWEN, config: { context_length: 32_768 } }] : [] }]
    })
  })
  return state
}

beforeEach(() => updateSettings({ lmStudioUrl: 'http://localhost:1234', lmStudioUnloadMinutes: 60 }))

test('a model Starwright loaded is unloaded once unused for the set time, not before', async (t) => {
  const lm = fakeLmStudio(t)
  await ensureModelLoaded(QWEN)
  assert.equal(lm.loads, 1)
  assert.deepEqual(await unloadIdleModels(Date.now() + 59 * MIN), [], 'not yet')
  assert.deepEqual(await unloadIdleModels(Date.now() + 61 * MIN), [QWEN])
  assert.deepEqual(lm.unloads, [QWEN])
  assert.deepEqual(await unloadIdleModels(Date.now() + 200 * MIN), [], 'only once')
})

test('never while a job is using it; the idle time counts from when the job ended', async (t) => {
  const lm = fakeLmStudio(t)
  await ensureModelLoaded(QWEN)
  const release = holdModel(QWEN)
  assert.deepEqual(await unloadIdleModels(Date.now() + 120 * MIN), [], 'a long hand-off keeps it')
  release()
  assert.deepEqual(await unloadIdleModels(Date.now() + 30 * MIN), [], 'used just now')
  assert.deepEqual(await unloadIdleModels(Date.now() + 61 * MIN), [QWEN])
  assert.equal(lm.unloads.length, 1)
})

test('a model loaded by hand is never unloaded', async (t) => {
  const lm = fakeLmStudio(t, true)
  const ready = await ensureModelLoaded(QWEN)
  assert.equal(ready.loadedNow, false)
  assert.deepEqual(await unloadIdleModels(Date.now() + 1000 * MIN), [])
  assert.deepEqual(lm.unloads, [])
})

test('ejected in LM Studio: forgotten, so a copy loaded by hand later is left alone', async (t) => {
  const lm = fakeLmStudio(t)
  await ensureModelLoaded(QWEN)
  lm.loaded = false // ejected by hand
  assert.deepEqual(await unloadIdleModels(Date.now() + 61 * MIN), [])
  lm.loaded = true // loaded again by hand
  assert.deepEqual(await unloadIdleModels(Date.now() + 1000 * MIN), [])
  assert.deepEqual(lm.unloads, [])
})

test('0 minutes keeps it loaded', async (t) => {
  updateSettings({ lmStudioUnloadMinutes: 0 })
  const lm = fakeLmStudio(t)
  await ensureModelLoaded(QWEN)
  assert.deepEqual(await unloadIdleModels(Date.now() + 10_000 * MIN), [])
  assert.deepEqual(lm.unloads, [])
  updateSettings({ lmStudioUnloadMinutes: 60 })
  assert.deepEqual(await unloadIdleModels(Date.now() + 61 * MIN), [QWEN], 'until a time is set')
})
