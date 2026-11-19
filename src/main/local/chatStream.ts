// One streamed request to LM Studio's OpenAI-style chat endpoint, so Starwright can tell a model
// still reading its context (silent until the first token) from one that's writing, and from one
// that has stopped. LM Studio's native /api/v1/chat reports reading progress, but it refuses
// caller-defined tools (tested 2026-11-19: "Unrecognized key(s) in object: 'tools'"), and the
// local agent works only through its tools, so it stays on /v1/chat/completions.

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatReply {
  model?: string
  choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string } | string
}

export interface StreamProgress {
  phase: 'reading' | 'writing'
  /** Since the request was sent. */
  elapsedMs: number
  /** Writing: when the first token came. */
  firstTokenMs?: number
  /** Writing: pieces received so far (about one token each). */
  pieces: number
}

export interface StreamedReply {
  reply: ChatReply
  /** How long the model read before its first token: the time its context took. Undefined when it didn't stream. */
  firstTokenMs?: number
  totalMs: number
}

/** Why the watchdog ended a request. */
export class StreamStopped extends Error {
  constructor(
    readonly why: 'slow-read' | 'stalled',
    readonly afterMs: number
  ) {
    super(why === 'slow-read' ? `still reading after ${Math.round(afterMs / 1000)} s` : `no output for ${Math.round(afterMs / 1000)} s`)
  }
}

export interface StreamOptions {
  signal?: AbortSignal
  /** Ends the request when it reads (no token yet) longer than this. Undefined: no limit. */
  readLimitMs?: number
  /** Ends the request when it goes this long without output once it has started writing. */
  stallMs: number
  onProgress?: (progress: StreamProgress) => void
  /** How often onProgress is called (ms). */
  progressEveryMs?: number
}

/**
 * Sends body with stream: true and puts the reply back together as a non-streamed one. A server that
 * answers with plain JSON instead is read as it is. Throws StreamStopped when the watchdog ends it,
 * and the fetch's own errors (an abort, a timeout) as they are.
 */
export async function streamChat(url: string, body: Record<string, unknown>, options: StreamOptions): Promise<StreamedReply> {
  const started = Date.now()
  const watchdog = new AbortController()
  let stopped: StreamStopped | undefined
  let firstTokenMs: number | undefined
  let lastPieceAt = started
  let pieces = 0

  const tick = (): void => {
    const now = Date.now()
    const elapsed = now - started
    if (firstTokenMs === undefined && options.readLimitMs !== undefined && elapsed > options.readLimitMs) {
      stopped = new StreamStopped('slow-read', elapsed)
    } else if (firstTokenMs !== undefined && now - lastPieceAt > options.stallMs) {
      stopped = new StreamStopped('stalled', now - lastPieceAt)
    }
    if (stopped) watchdog.abort(stopped)
  }
  const checks = setInterval(tick, Math.max(10, Math.min(1000, Math.floor(Math.min(options.stallMs, options.readLimitMs ?? Infinity) / 4))))
  const progress = options.onProgress
    ? setInterval(() => {
        options.onProgress!({
          phase: firstTokenMs === undefined ? 'reading' : 'writing',
          elapsedMs: Date.now() - started,
          firstTokenMs,
          pieces
        })
      }, options.progressEveryMs ?? 2000)
    : undefined

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
      signal: options.signal ? AbortSignal.any([options.signal, watchdog.signal]) : watchdog.signal
    })
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok || !res.body || !type.includes('text/event-stream')) {
      const reply = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as ChatReply
      if (!res.ok && !reply.error) reply.error = `HTTP ${res.status}`
      return { reply, totalMs: Date.now() - started }
    }

    let content = ''
    const calls: ToolCall[] = []
    let finish: string | undefined
    let usage: ChatReply['usage']
    let model: string | undefined
    let error: ChatReply['error']
    const decoder = new TextDecoder()
    let buffer = ''
    const take = (data: string): void => {
      if (data === '[DONE]') return
      let chunk: {
        model?: string
        error?: ChatReply['error']
        usage?: ChatReply['usage']
        choices?: {
          delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }
          finish_reason?: string | null
        }[]
      }
      try {
        chunk = JSON.parse(data)
      } catch {
        return
      }
      if (chunk.error) error = chunk.error
      if (chunk.model) model = chunk.model
      if (chunk.usage) usage = chunk.usage
      const choice = chunk.choices?.[0]
      if (choice?.finish_reason) finish = choice.finish_reason
      const delta = choice?.delta
      if (!delta) return
      if (delta.content || delta.reasoning_content || delta.tool_calls?.length) {
        const now = Date.now()
        firstTokenMs ??= now - started
        lastPieceAt = now
        pieces++
      }
      if (delta.content) content += delta.content
      for (const part of delta.tool_calls ?? []) {
        const at = part.index ?? calls.length
        const call = (calls[at] ??= { id: '', type: 'function', function: { name: '', arguments: '' } })
        if (part.id) call.id = part.id
        if (part.function?.name) call.function.name += part.function.name
        if (part.function?.arguments) call.function.arguments += part.function.arguments
      }
    }
    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true })
      let end: number
      while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const event = buffer.slice(0, end)
        buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '')
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) take(data)
      }
    }
    if (buffer.trim().startsWith('data:')) take(buffer.trim().slice(5).trimStart())

    const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call-${i}` }))
    const reply: ChatReply = {
      model,
      choices: [{ message: { content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }],
      usage,
      ...(error ? { error } : {})
    }
    return { reply, firstTokenMs, totalMs: Date.now() - started }
  } catch (err) {
    if (stopped) throw stopped
    throw err
  } finally {
    clearInterval(checks)
    if (progress) clearInterval(progress)
  }
}

/** The live line for a step, while it runs. */
export function progressText(p: StreamProgress, estimate?: { tokens: number; perSecond: number }): string {
  const seconds = Math.round(p.elapsedMs / 1000)
  if (p.phase === 'reading') {
    if (estimate && estimate.tokens > 0 && estimate.perSecond > 0) {
      const share = Math.min(95, Math.max(1, Math.round(((p.elapsedMs / 1000) * estimate.perSecond * 100) / estimate.tokens)))
      return `Local model reading its context, about ${share}% (${seconds} s)`
    }
    return `Local model reading its context (${seconds} s)`
  }
  const writing = (p.elapsedMs - (p.firstTokenMs ?? 0)) / 1000
  const rate = writing >= 1 ? `, ${Math.round(p.pieces / writing)} tok/s` : ''
  return `Local model writing: ${p.pieces.toLocaleString()} tokens${rate} (${seconds} s)`
}

/** The finished line for a step that took a while. */
export function stepSummary(firstTokenMs: number | undefined, totalMs: number, outputTokens: number, readTokens: number): string {
  if (firstTokenMs === undefined) return `Local model step took ${Math.round(totalMs / 1000)} s`
  const writing = (totalMs - firstTokenMs) / 1000
  const rate = writing >= 1 ? ` (${Math.round(outputTokens / writing)} tok/s)` : ''
  // An estimate from the conversation's size (LM Studio reports the whole prompt, not what was new).
  const read = readTokens > 0 ? `about ${readTokens.toLocaleString()} new tokens` : 'its context'
  return `Local model read ${read} in ${Math.round(firstTokenMs / 1000)} s, then wrote ${outputTokens.toLocaleString()} tokens in ${Math.round(writing)} s${rate}`
}
