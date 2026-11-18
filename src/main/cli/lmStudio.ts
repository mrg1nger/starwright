import { app } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getSettings } from '../settings/store'
import type { TokenCounts } from '../usage/tokens'
import type { LmStudioModel, LmStudioStatus } from '@shared/types'

// LM Studio: a model running on the user's own computer, reached through the
// local server LM Studio starts (Developer → Start Server, port 1234 by default).
// It speaks the OpenAI chat API, so VibeApp's background jobs (short text in,
// JSON out, no tools) can run there for free instead of on Haiku or ClinePass.

export const LM_STUDIO_DEFAULT_URL = 'http://localhost:1234'

/** The server's address without a trailing slash or /v1 (people paste either). */
export function lmStudioBase(url?: string | null): string {
  const raw = (url ?? '').trim() || LM_STUDIO_DEFAULT_URL
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  return withScheme.replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/api\/v0$/i, '')
}

interface V0Model {
  id: string
  type?: string
  state?: string
  loaded_context_length?: number
  max_context_length?: number
}

/** The chat models LM Studio has (not its embedding models), loaded ones first. */
export function chatModelsFrom(v0: V0Model[] | undefined, v1: { id: string }[] | undefined): LmStudioModel[] {
  const models: LmStudioModel[] = v0
    ? v0
        .filter((m) => m.type !== 'embeddings')
        .map((m) => ({ id: m.id, loaded: m.state === 'loaded', contextLength: m.loaded_context_length ?? m.max_context_length }))
    : (v1 ?? []).filter((m) => !/embed/i.test(m.id)).map((m) => ({ id: m.id, loaded: false }))
  return models.sort((a, b) => Number(b.loaded) - Number(a.loaded) || a.id.localeCompare(b.id))
}

/** The model a job uses: the chosen one, otherwise the one loaded now, otherwise the first (LM Studio loads it on demand). */
export function pickModel(models: LmStudioModel[], chosen: string | null): string | undefined {
  if (chosen) return chosen
  return (models.find((m) => m.loaded) ?? models[0])?.id
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

/** Whether LM Studio's server answers at this address, and the chat models it has. Never throws. */
export async function lmStudioStatus(url?: string | null): Promise<LmStudioStatus> {
  const base = lmStudioBase(url ?? getSettings().lmStudioUrl)
  try {
    // LM Studio's own list says which models are loaded; the OpenAI-style one is the fallback.
    let v0: V0Model[] | undefined
    let v1: { id: string }[] | undefined
    try {
      v0 = ((await getJson(`${base}/api/v0/models`, 3000)) as { data?: V0Model[] }).data
    } catch {
      v1 = ((await getJson(`${base}/v1/models`, 3000)) as { data?: { id: string }[] }).data
    }
    const models = chatModelsFrom(v0, v1)
    return { running: true, url: base, models }
  } catch (err) {
    const message = (err as Error).name === 'TimeoutError' ? 'no answer within 3 s' : (err as Error).message
    return { running: false, url: base, models: [], error: `LM Studio's server isn't answering at ${base} (${message}).` }
  }
}

// Background jobs ask whether LM Studio is there before each run; the answer is
// kept briefly so a burst of jobs doesn't probe the server every time.
let cached: { key: string; at: number; status: LmStudioStatus } | undefined

/** Background jobs on LM Studio: turned on in Settings, the server is answering, and there's a chat model to use. */
export async function lmStudioReady(): Promise<boolean> {
  return getSettings().lmStudioHelpers && (await lmStudioAvailable())
}

/** Coding hand-offs to the local model: the same, with their own switch. */
export async function localHandoffsReady(): Promise<boolean> {
  return getSettings().localHandoffs && (await lmStudioAvailable())
}

/** The server is answering and there's a chat model to use (looked at most every 15-30 s). */
export async function lmStudioAvailable(): Promise<boolean> {
  const settings = getSettings()
  const key = lmStudioBase(settings.lmStudioUrl)
  const fresh = cached && cached.key === key && Date.now() - cached.at < (cached.status.running ? 30_000 : 15_000)
  if (!fresh) cached = { key, at: Date.now(), status: await lmStudioStatus(key) }
  return cached!.status.running && !!pickModel(cached!.status.models, settings.lmStudioModel)
}

// ---- loading the model ------------------------------------------------------------------
//
// LM Studio loads a model on the first request for it ("just in time"), but with the model's own
// default settings, often a much smaller context than Starwright plans for, and only if that
// option is on. So Starwright loads the model itself first, with the context set in Settings, and
// knows the size it's working with. LM Studio's REST API (0.4 and later): GET /api/v1/models lists
// each model with its loaded_instances; POST /api/v1/models/load loads one.

/** Context to load with when Settings has none (32k: what hand-offs need). */
export const DEFAULT_LOAD_CONTEXT = 32_768
/** A 20 GB model from a slow disk can take minutes. */
const LOAD_TIMEOUT_MS = 10 * 60_000

export interface V1Model {
  key: string
  type?: string
  max_context_length?: number
  variants?: string[]
  selected_variant?: string
  loaded_instances?: { id: string; config?: { context_length?: number } }[]
}

export interface ModelReady {
  /** The context the model is loaded with, when LM Studio says. */
  contextLength?: number
  /** Starwright loaded it just now (with how long it took). */
  loadedNow: boolean
  seconds?: number
}

const loading = new Map<string, Promise<ModelReady>>()

/** The model's entry in LM Studio's list (by its key, or one of its variants). */
export function findV1Model(models: V1Model[], model: string): V1Model | undefined {
  return models.find((m) => m.key === model || m.selected_variant === model || m.variants?.includes(model))
}

/**
 * Makes sure the model is loaded, loading it with Settings' context if it isn't, and says what
 * context it has. An LM Studio without this API: nothing is done (it loads the model on demand).
 * Only one load runs at a time per model, and a model with a loaded copy is never loaded again
 * (a second copy would need the memory twice). Throws when LM Studio can't load it.
 */
export function ensureModelLoaded(model: string, onLoading?: (contextLength: number) => void): Promise<ModelReady> {
  const settings = getSettings()
  const base = lmStudioBase(settings.lmStudioUrl)
  const key = `${base} ${model}`
  const running = loading.get(key)
  if (running) {
    onLoading?.(0)
    return running
  }
  const work = (async (): Promise<ModelReady> => {
    let list: V1Model[]
    try {
      const res = await fetch(`${base}/api/v1/models`, { signal: AbortSignal.timeout(5_000) })
      if (!res.ok) return { loadedNow: false } // an older LM Studio: it loads on demand
      list = ((await res.json()) as { models?: V1Model[] }).models ?? []
    } catch {
      return { loadedNow: false } // the request itself will say what's wrong
    }
    const entry = findV1Model(list, model)
    if (!entry) return { loadedNow: false }
    const instance = entry.loaded_instances?.[0]
    if (instance) {
      // Starwright's own copy, still there: used now, so its idle time starts again.
      const own = readOwnLoads()[key]
      if (own && entry.loaded_instances!.some((i) => i.id === own.instanceId)) touchModel(model)
      return { loadedNow: false, contextLength: instance.config?.context_length }
    }
    const wanted = Math.max(2_048, Math.floor(settings.lmStudioContextLength || DEFAULT_LOAD_CONTEXT))
    const contextLength = entry.max_context_length ? Math.min(wanted, entry.max_context_length) : wanted
    onLoading?.(contextLength)
    let res: Response
    try {
      res = await fetch(`${base}/api/v1/models/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: entry.key, context_length: contextLength, echo_load_config: true }),
        signal: AbortSignal.timeout(LOAD_TIMEOUT_MS)
      })
    } catch (err) {
      throw new Error((err as Error).name === 'TimeoutError' ? `LM Studio took more than 10 minutes to load ${model}.` : `Couldn't reach LM Studio to load ${model} (${(err as Error).message}).`)
    }
    const text = await res.text()
    if (!res.ok) {
      let reason = text.slice(0, 300)
      try {
        const json = JSON.parse(text) as { error?: string | { message?: string } }
        reason = typeof json.error === 'string' ? json.error : (json.error?.message ?? reason)
      } catch {
        // not JSON: the text as it is
      }
      throw new Error(`LM Studio couldn't load ${model} with ${contextLength.toLocaleString()} tokens of context: ${reason || `HTTP ${res.status}`}. Try a smaller context in Settings → LM Studio.`)
    }
    forgetLmStudioStatus()
    let loaded: { instance_id?: string; load_time_seconds?: number; load_config?: { context_length?: number } } = {}
    try {
      loaded = JSON.parse(text)
    } catch {
      // loaded, but the answer wasn't JSON: go by what was asked for
    }
    // Written down as Starwright's, so it can be unloaded once it's been unused a while.
    const loads = readOwnLoads()
    loads[key] = { base, model, instanceId: loaded.instance_id ?? entry.key, lastUsed: Date.now() }
    writeOwnLoads(loads)
    startIdleWatch()
    return { loadedNow: true, contextLength: loaded.load_config?.context_length ?? contextLength, seconds: loaded.load_time_seconds }
  })().finally(() => loading.delete(key))
  loading.set(key, work)
  return work
}

// ---- unloading it again ------------------------------------------------------------------
//
// A model loaded through the API has no idle timer in LM Studio (only ones it loads on demand do),
// so it would stay in memory for good. Starwright unloads the copies it loaded itself once they've
// gone unused for Settings' time, never while a job is using one, and never a copy loaded by hand.
// The list is kept on disk so a restart doesn't lose track of what's Starwright's.

interface OwnLoad {
  base: string
  model: string
  instanceId: string
  lastUsed: number
}

const ownLoadsFile = (): string => join(app.getPath('userData'), 'lmstudio-loads.json')

function readOwnLoads(): Record<string, OwnLoad> {
  try {
    if (existsSync(ownLoadsFile())) return JSON.parse(readFileSync(ownLoadsFile(), 'utf-8')) as Record<string, OwnLoad>
  } catch {
    // unreadable: nothing known to be Starwright's
  }
  return {}
}

function writeOwnLoads(loads: Record<string, OwnLoad>): void {
  try {
    if (Object.keys(loads).length) writeFileSync(ownLoadsFile(), JSON.stringify(loads), 'utf-8')
    else rmSync(ownLoadsFile(), { force: true })
  } catch {
    // not fatal: at worst it stays loaded
  }
}

const inUse = new Map<string, number>()
const modelKey = (model: string): string => `${lmStudioBase(getSettings().lmStudioUrl)} ${model}`

/** The model was just used: its idle time starts again (only matters for a copy Starwright loaded). */
export function touchModel(model: string): void {
  const loads = readOwnLoads()
  const own = loads[modelKey(model)]
  if (!own) return
  own.lastUsed = Date.now()
  writeOwnLoads(loads)
}

/** A job is using the model: it isn't unloaded until the returned function is called. */
export function holdModel(model: string): () => void {
  const key = modelKey(model)
  inUse.set(key, (inUse.get(key) ?? 0) + 1)
  touchModel(model)
  let released = false
  return () => {
    if (released) return
    released = true
    inUse.set(key, Math.max(0, (inUse.get(key) ?? 1) - 1))
    touchModel(model)
  }
}

/**
 * Unloads Starwright's copies that have gone unused for Settings' time. Forgets ones that are gone
 * (ejected in LM Studio). Returns the models unloaded.
 */
export async function unloadIdleModels(now = Date.now()): Promise<string[]> {
  const minutes = getSettings().lmStudioUnloadMinutes
  const loads = readOwnLoads()
  const unloaded: string[] = []
  for (const [key, own] of Object.entries(loads)) {
    if ((inUse.get(key) ?? 0) > 0 || loading.has(key)) continue
    let list: V1Model[]
    try {
      const res = await fetch(`${own.base}/api/v1/models`, { signal: AbortSignal.timeout(5_000) })
      if (!res.ok) continue
      list = ((await res.json()) as { models?: V1Model[] }).models ?? []
    } catch {
      continue // LM Studio isn't answering: try again later
    }
    const entry = findV1Model(list, own.model)
    if (!entry?.loaded_instances?.some((i) => i.id === own.instanceId)) {
      delete loads[key] // ejected (or LM Studio restarted): not Starwright's to unload any more
      continue
    }
    if (!(minutes > 0) || now - own.lastUsed < minutes * 60_000) continue
    try {
      const res = await fetch(`${own.base}/api/v1/models/unload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance_id: own.instanceId }),
        signal: AbortSignal.timeout(60_000)
      })
      if (!res.ok) continue
    } catch {
      continue
    }
    delete loads[key]
    unloaded.push(own.model)
  }
  // Written back over a fresh read: a load or use meanwhile is kept.
  const latest = readOwnLoads()
  for (const key of Object.keys(latest)) {
    if (!(key in loads) && !(latest[key].lastUsed > now)) delete latest[key]
  }
  writeOwnLoads(latest)
  if (unloaded.length) forgetLmStudioStatus()
  return unloaded
}

let idleTimer: NodeJS.Timeout | undefined

/** Checks every minute while Starwright has a copy loaded (started at launch and after each load). */
export function startIdleWatch(): void {
  if (idleTimer || !Object.keys(readOwnLoads()).length) return
  idleTimer = setInterval(() => {
    void unloadIdleModels()
      .then((models) => {
        if (models.length) console.log(`Unloaded ${models.join(', ')} from LM Studio (unused for ${getSettings().lmStudioUnloadMinutes} min).`)
        if (!Object.keys(readOwnLoads()).length && idleTimer) {
          clearInterval(idleTimer)
          idleTimer = undefined
        }
      })
      .catch(() => undefined)
  }, 60_000)
  idleTimer.unref?.()
}

/** Forget the last look at the server (after a failure or a settings change). */
export function forgetLmStudioStatus(): void {
  cached = undefined
}

export interface LmStudioRun {
  system: string
  prompt: string
  /** JSON Schema the answer must follow (LM Studio holds the model to it). */
  schema?: Record<string, unknown>
  /** Let a thinking model think first; off by default (about ten times faster). */
  thinking?: boolean
  model?: string
  timeoutMs?: number
  /** 0.2 unless said (background jobs want the steady answer). */
  temperature?: number
  /** Stops the request (the Chat tab's Stop). */
  signal?: AbortSignal
}

export interface LmStudioResult {
  text: string
  model: string
  usage: TokenCounts
}

interface ChatResponse {
  model?: string
  choices?: { message?: { content?: string | null }; finish_reason?: string }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
  error?: { message?: string } | string
}

/** Token counts from an OpenAI-style `usage` block. */
export function countsFromChatUsage(usage: ChatResponse['usage'], model?: string): TokenCounts {
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0
  return {
    fresh: Math.max(0, (usage?.prompt_tokens ?? 0) - cachedTokens),
    cached: cachedTokens,
    output: usage?.completion_tokens ?? 0,
    steps: 1,
    model
  }
}

/** One request to LM Studio. Throws with a reason when it can't answer. */
export async function runLmStudio(run: LmStudioRun): Promise<LmStudioResult> {
  const settings = getSettings()
  const base = lmStudioBase(settings.lmStudioUrl)
  let model = run.model ?? settings.lmStudioModel ?? undefined
  if (!model) {
    const status = await lmStudioStatus(base)
    if (!status.running) throw new Error(status.error)
    model = pickModel(status.models, null)
    if (!model) throw new Error('LM Studio has no chat model downloaded.')
  }
  // Loaded with the context Starwright plans for, rather than whatever LM Studio would pick.
  await ensureModelLoaded(model)
  const release = holdModel(model)
  try {
    return await askLmStudio(run, base, model)
  } finally {
    release()
  }
}

async function askLmStudio(run: LmStudioRun, base: string, model: string): Promise<LmStudioResult> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: run.system },
      { role: 'user', content: run.prompt }
    ],
    temperature: run.temperature ?? 0.2,
    stream: false,
    ...(run.schema ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: run.schema } } } : {}),
    // Thinking models (Qwen3 and the like) spend most of their time thinking; "none" skips it.
    ...(run.thinking ? {} : { reasoning_effort: 'none' })
  }
  const send = async (payload: Record<string, unknown>): Promise<{ status: number; json: ChatResponse }> => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: run.signal
        ? AbortSignal.any([run.signal, AbortSignal.timeout(run.timeoutMs ?? 4 * 60_000)])
        : AbortSignal.timeout(run.timeoutMs ?? 4 * 60_000)
    })
    const text = await res.text()
    let json: ChatResponse
    try {
      json = JSON.parse(text) as ChatResponse
    } catch {
      json = { error: text.slice(0, 300) || res.statusText }
    }
    return { status: res.status, json }
  }
  let reply: Awaited<ReturnType<typeof send>>
  try {
    reply = await send(body)
    // An older LM Studio or another server may not know reasoning_effort: try once without it.
    if (reply.status === 400 && 'reasoning_effort' in body && /reasoning/i.test(errorText(reply.json))) {
      const { reasoning_effort: _dropped, ...rest } = body
      reply = await send(rest)
    }
  } catch (err) {
    if (run.signal?.aborted) throw new Error('Stopped.')
    forgetLmStudioStatus()
    if ((err as Error).name === 'TimeoutError') throw new Error('LM Studio took too long to answer.')
    throw new Error(`Couldn't reach LM Studio at ${base} (${(err as Error).message}).`)
  }
  const usage = countsFromChatUsage(reply.json.usage, reply.json.model ?? model)
  if (reply.status >= 400 || reply.json.error) {
    throw Object.assign(new Error(`LM Studio refused the job: ${errorText(reply.json) || `HTTP ${reply.status}`}`), { usage })
  }
  const choice = reply.json.choices?.[0]
  const text = (choice?.message?.content ?? '').trim()
  if (!text) {
    const why = choice?.finish_reason === 'length' ? ' (it ran out of room: load the model with a longer context)' : ''
    throw Object.assign(new Error(`LM Studio returned nothing${why}.`), { usage })
  }
  return { text, model: reply.json.model ?? model, usage }
}

function errorText(json: ChatResponse): string {
  return typeof json.error === 'string' ? json.error : (json.error?.message ?? '')
}

/** A tiny live run for Settings: is the server up and does the model answer? */
export async function checkLmStudio(): Promise<{ ok: boolean; message: string; model?: string; seconds: number }> {
  const started = Date.now()
  const seconds = (): number => Math.round((Date.now() - started) / 100) / 10
  forgetLmStudioStatus()
  try {
    const result = await runLmStudio({
      system: 'You are a connection check. Reply with exactly the word asked for.',
      prompt: 'Reply with the single word READY.',
      timeoutMs: 3 * 60_000
    })
    // The first request after LM Studio starts loads the model, which can take a while.
    return { ok: true, message: `LM Studio answered in ${seconds()} s (${result.model}).`, model: result.model, seconds: seconds() }
  } catch (err) {
    return { ok: false, message: (err as Error).message, seconds: seconds() }
  }
}
