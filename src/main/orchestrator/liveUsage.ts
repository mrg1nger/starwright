// Tokens while a reply is still being written, from the SDK's stream events
// (includePartialMessages). Each API call starts with message_start, which says exactly how much
// it read; what it writes arrives as deltas, counted at about 4 characters a token, until its
// message_delta gives the exact count. Helper agents (parent_tool_use_id set) stream their own
// calls alongside: what they write counts, but the size read is the main conversation's.

export interface LiveCounts {
  /** The main conversation's size at its latest step (tokens read, cached or not). */
  read: number
  /** Written so far: exact for finished steps, estimated for the ones still being written. */
  written: number
  /** API calls so far, helper agents' included. */
  steps: number
}

interface StreamEventLike {
  type: string
  message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string }
  usage?: { output_tokens?: number }
}

const CHARS_PER_TOKEN = 4

export class LiveUsage {
  private read = 0
  private steps = 0
  /** Written in finished steps. */
  private done = 0
  /** The step each stream (main or a helper agent) is writing now. */
  private current = new Map<string, { chars: number; exact?: number }>()

  /** One stream event; true when the counts changed. */
  onStream(event: StreamEventLike, parentToolUseId: string | null | undefined): boolean {
    const key = parentToolUseId ?? ''
    switch (event.type) {
      case 'message_start': {
        this.finish(key)
        this.current.set(key, { chars: 0 })
        this.steps++
        const u = event.message?.usage
        if (!parentToolUseId && u) {
          this.read = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        }
        return true
      }
      case 'content_block_delta': {
        const d = event.delta
        const text = d?.text ?? d?.partial_json ?? d?.thinking ?? ''
        if (!text) return false
        const step = this.current.get(key) ?? { chars: 0 }
        step.chars += text.length
        this.current.set(key, step)
        return true
      }
      case 'message_delta': {
        const out = event.usage?.output_tokens
        if (out === undefined) return false
        const step = this.current.get(key) ?? { chars: 0 }
        step.exact = out
        this.current.set(key, step)
        return true
      }
      default:
        return false
    }
  }

  private finish(key: string): void {
    const step = this.current.get(key)
    if (step) this.done += this.writtenBy(step)
    this.current.delete(key)
  }

  private writtenBy(step: { chars: number; exact?: number }): number {
    return step.exact ?? Math.ceil(step.chars / CHARS_PER_TOKEN)
  }

  counts(): LiveCounts {
    let written = this.done
    for (const step of this.current.values()) written += this.writtenBy(step)
    return { read: this.read, written, steps: this.steps }
  }

  /** A turn ended: the next stream events are a new one's. */
  reset(): void {
    this.read = 0
    this.steps = 0
    this.done = 0
    this.current.clear()
  }
}

/** At most one call per `everyMs`, the last one always delivered (a trailing call). */
export function throttle(fn: () => void, everyMs: number): { call: () => void; flush: () => void; cancel: () => void } {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = (): void => {
    timer = undefined
    last = Date.now()
    fn()
  }
  return {
    call: () => {
      if (timer) return
      const wait = everyMs - (Date.now() - last)
      if (wait <= 0) run()
      else timer = setTimeout(run, wait)
    },
    flush: () => {
      if (timer) clearTimeout(timer)
      run()
    },
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
    }
  }
}
