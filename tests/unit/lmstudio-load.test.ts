import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LOAD_CONTEXT, ensureModelLoaded, findV1Model } from '../../src/main/cli/lmStudio'

const QWEN = 'qwen/qwen3.6-35b-a3b'

/** LM Studio's /api/v1/models with Qwen loaded (at `loaded` tokens) or not. */
function list(loaded?: number): unknown {
  return {
    models: [
      { type: 'embedding', key: 'text-embedding-nomic-embed-text-v1.5', loaded_instances: [], max_context_length: 2048 },
      {
        type: 'llm',
        key: QWEN,
        max_context_length: 262_144,
        variants: [`${QWEN}@q4_k_m`],
        selected_variant: `${QWEN}@q4_k_m`,
        loaded_instances: loaded ? [{ id: QWEN, config: { context_length: loaded } }] : []
      }
    ]
  }
}

type Call = { url: string; body?: Record<string, unknown> }
function mockLmStudio(t: { mock: { method: (o: object, k: string, f: unknown) => void } }, answer: (call: Call) => { status?: number; json: unknown; delayMs?: number }): Call[] {
  const calls: Call[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init?: { body?: string }) => {
    const call = { url: String(url), body: init?.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const { status = 200, json, delayMs = 0 } = answer(call)
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    return new Response(JSON.stringify(json), { status })
  })
  return calls
}

test('a model is found by its key or its variant', () => {
  const models = (list() as { models: { key: string }[] }).models
  assert.equal(findV1Model(models, QWEN)?.key, QWEN)
  assert.equal(findV1Model(models, `${QWEN}@q4_k_m`)?.key, QWEN)
  assert.equal(findV1Model(models, 'nope'), undefined)
})

test('a model that is already loaded is used as it is, and its real context is known', async (t) => {
  const calls = mockLmStudio(t, () => ({ json: list(64_000) }))
  const ready = await ensureModelLoaded(QWEN)
  assert.deepEqual(ready, { loadedNow: false, contextLength: 64_000 })
  assert.equal(calls.length, 1, 'only looked: no second copy loaded')
})

test("a model that isn't loaded is loaded with Settings' context, not LM Studio's default", async (t) => {
  const calls = mockLmStudio(t, (c) =>
    c.url.endsWith('/load')
      ? { json: { type: 'llm', instance_id: QWEN, load_time_seconds: 21.4, status: 'loaded', load_config: { context_length: c.body!.context_length } } }
      : { json: list() }
  )
  let announced = -1
  const ready = await ensureModelLoaded(QWEN, (n) => (announced = n))
  const load = calls.find((c) => c.url.endsWith('/api/v1/models/load'))
  assert.ok(load, 'asked LM Studio to load it')
  assert.deepEqual(load.body, { model: QWEN, context_length: DEFAULT_LOAD_CONTEXT, echo_load_config: true })
  assert.equal(announced, DEFAULT_LOAD_CONTEXT, 'the hand-off was told it is loading')
  assert.deepEqual(ready, { loadedNow: true, contextLength: DEFAULT_LOAD_CONTEXT, seconds: 21.4 })
})

test('two jobs at once share one load (never two copies of a 22 GB model)', async (t) => {
  const calls = mockLmStudio(t, (c) =>
    c.url.endsWith('/load') ? { delayMs: 200, json: { status: 'loaded', load_config: { context_length: 32_768 } } } : { json: list() }
  )
  const [a, b] = await Promise.all([ensureModelLoaded(QWEN), ensureModelLoaded(QWEN)])
  assert.equal(calls.filter((c) => c.url.endsWith('/load')).length, 1)
  assert.deepEqual(a, b)
})

test("an older LM Studio without the load API is left to load on demand", async (t) => {
  const calls = mockLmStudio(t, () => ({ status: 404, json: { error: 'Unexpected endpoint' } }))
  assert.deepEqual(await ensureModelLoaded(QWEN), { loadedNow: false })
  assert.equal(calls.length, 1)
})

test("a load LM Studio refuses (not enough memory) says so, and what to try", async (t) => {
  mockLmStudio(t, (c) => (c.url.endsWith('/load') ? { status: 500, json: { error: { message: 'Failed to load model: insufficient memory' } } } : { json: list() }))
  await assert.rejects(ensureModelLoaded(QWEN), /couldn't load qwen\/qwen3\.6-35b-a3b with 32,768 tokens of context: Failed to load model: insufficient memory\. Try a smaller context/)
})
