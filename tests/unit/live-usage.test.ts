import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LiveUsage, throttle } from '../../src/main/orchestrator/liveUsage'
import { codexTokenReader, pollTokens } from '../../src/main/delegation/liveTokens'
import { elapsedText, liveSummary } from '@shared/live'
import type { LiveTokens } from '@shared/types'

const start = (input: number, cacheRead = 0, cacheWrite = 0) => ({
  type: 'message_start',
  message: { usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: 1 } }
})
const text = (t: string) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } })
const json = (t: string) => ({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: t } })
const end = (out: number) => ({ type: 'message_delta', usage: { output_tokens: out } })

test("Claude's tokens: estimated while a step is written, exact when it ends, and the size it read", () => {
  const live = new LiveUsage()
  assert.equal(live.onStream(start(20, 140_000, 3000), null), true)
  assert.deepEqual(live.counts(), { read: 143_020, written: 0, steps: 1 })
  live.onStream(text('a'.repeat(400)), null)
  assert.equal(live.counts().written, 100, 'about 4 characters a token while it streams')
  live.onStream(json('{"file_path":"x"}'.repeat(10)), null)
  assert.equal(live.counts().written, 100 + Math.ceil(170 / 4), 'tool input counts too')
  live.onStream(end(180), null)
  assert.equal(live.counts().written, 180, 'the exact count replaces the estimate')
  // The next step: what it read is the new size; what was written adds up.
  live.onStream(start(5, 146_000), null)
  live.onStream(text('b'.repeat(40)), null)
  assert.deepEqual(live.counts(), { read: 146_005, written: 190, steps: 2 })
  assert.equal(live.onStream({ type: 'content_block_stop' }, null), false, 'nothing to count')
})

test("a helper agent's writing counts, but the size read is the main conversation's", () => {
  const live = new LiveUsage()
  live.onStream(start(10, 100_000), null)
  live.onStream(start(8000), 'toolu_helper')
  live.onStream(text('c'.repeat(80)), 'toolu_helper')
  live.onStream(text('d'.repeat(40)), null)
  assert.deepEqual(live.counts(), { read: 100_010, written: 30, steps: 2 })
  live.onStream(end(25), 'toolu_helper')
  live.onStream(end(12), null)
  assert.equal(live.counts().written, 37)
  live.reset()
  assert.deepEqual(live.counts(), { read: 0, written: 0, steps: 0 })
})

test('live counts go out a few times a second at most, the last always', async () => {
  let calls = 0
  const t = throttle(() => calls++, 50)
  t.call()
  t.call()
  t.call()
  assert.equal(calls, 1, 'the first goes at once')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(calls, 2, 'the rest as one, after the wait')
  t.call()
  t.flush()
  assert.equal(calls, 3, 'flush sends now, and cancels the one waiting')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(calls, 3)
})

test("a Codex hand-off's tokens come from its session file as it grows, earlier runs taken off", () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-live-'))
  try {
    const now = new Date()
    const local = (d: Date) => {
      const p = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
    }
    const dir = join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
    mkdirSync(dir, { recursive: true })
    const id = '01a205ed-fe62-7d00-ae04-63529be19d83'
    const file = join(dir, `rollout-${local(now)}-${id}.jsonl`)
    const line = (at: Date, input: number, output: number) =>
      JSON.stringify({ timestamp: at.toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output } } } }) + '\n'
    // A resumed thread: its file already has an earlier run's totals.
    const before = new Date(now.getTime() - 60_000)
    writeFileSync(file, JSON.stringify({ type: 'session_meta' }) + '\n' + line(before, 50_000, 900))
    const read = codexTokenReader(id, now, root)
    assert.equal(read(), null, 'nothing from this run yet')
    const later = new Date(now.getTime() + 2000)
    appendFileSync(file, line(later, 70_000, 1100))
    assert.deepEqual(read(), { read: 20_000, written: 200, steps: 1 })
    // The same totals again aren't a step; half a line waits for the rest.
    const again = line(later, 70_000, 1100)
    const next = line(new Date(now.getTime() + 4000), 95_000, 1400)
    appendFileSync(file, again + next.slice(0, 40))
    assert.deepEqual(read(), { read: 20_000, written: 200, steps: 1 })
    appendFileSync(file, next.slice(40))
    assert.deepEqual(read(), { read: 45_000, written: 500, steps: 2 })
    assert.equal(codexTokenReader('not-there', now, root)(), null, 'no file: nothing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('polling passes on only a change, and a last look when stopped', async () => {
  const seen: LiveTokens[] = []
  let now: LiveTokens | null = null
  const stop = pollTokens(() => now, (t) => seen.push(t), 20)
  await new Promise((r) => setTimeout(r, 50))
  now = { read: 10, written: 1, steps: 1 }
  await new Promise((r) => setTimeout(r, 70))
  now = { read: 30, written: 5, steps: 2 }
  stop()
  assert.deepEqual(seen, [
    { read: 10, written: 1, steps: 1 },
    { read: 30, written: 5, steps: 2 }
  ])
})

test("the chat's line sums Claude's turns and shows the latest size", () => {
  assert.deepEqual(liveSummary({}), { written: 0, context: 0 })
  assert.deepEqual(
    liveSummary({ 3: { read: 120_000, written: 900, steps: 4 }, 4: { read: 0, written: 0, steps: 0 }, 5: { read: 128_000, written: 300, steps: 1 } }),
    { written: 1200, context: 128_000 }
  )
  assert.deepEqual(liveSummary({ 7: { read: 90_000, written: 10, steps: 1 }, 8: { read: 0, written: 0, steps: 0 } }).context, 90_000)
  assert.equal(elapsedText(4_200), '4s')
  assert.equal(elapsedText(65_000), '1m 05s')
})
