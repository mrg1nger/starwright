import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DelegationActivity } from '@shared/types'
import { forgetLmStudioStatus, lmStudioStatus } from '../../src/main/cli/lmStudio'
import { runLocalAgent } from '../../src/main/local/localAgent'
import { updateSettings } from '../../src/main/settings/store'

// The local agent alone (no Claude) on the real LM Studio, streaming: its tool calls come back in
// pieces and are put together, and a long step shows a live line while it reads and writes, then
// what it took. Needs LM Studio's server running with a model loaded; skipped otherwise. Free.

const MINUTES = 60_000

test('the local agent streams from the real LM Studio: tool calls work, and long steps show reading and writing', { timeout: 10 * MINUTES }, async (t) => {
  const status = await lmStudioStatus('http://localhost:1234')
  const loaded = status.models.find((m) => m.loaded)
  if (!status.running || !loaded) return t.skip('LM Studio is not running with a model loaded')
  updateSettings({ lmStudioUrl: 'http://localhost:1234', lmStudioModel: loaded.id })
  forgetLmStudioStatus()

  const cwd = mkdtempSync(join(tmpdir(), 'local-stream-'))
  // Enough to read that the step takes a few seconds.
  const functions = Array.from({ length: 60 }, (_, i) => `export function step${i + 1}(value) {\n  // Adds ${i + 1} and doubles it.\n  return (value + ${i + 1}) * 2\n}\n`)
  writeFileSync(join(cwd, 'steps.js'), functions.join('\n'))

  const seen: DelegationActivity[] = []
  const result = await runLocalAgent({
    task: 'Read steps.js, then create count.txt containing only the number of functions it exports.',
    cwd,
    model: loaded.id,
    progressAfterMs: 1000,
    timeoutMs: 8 * MINUTES,
    onActivity: (a) => seen.push({ ...a })
  })
  const live = seen.filter((a) => a.id.startsWith('local-live-'))
  console.log(live.filter((a) => a.done).map((a) => `  ${a.id}: ${a.text}`).join('\n'))
  console.log(`  ${result.steps} steps, ${result.usage.fresh + result.usage.cached} prompt tokens, ${result.usage.output} output`)
  assert.equal(result.ok, true, result.error)
  assert.ok(existsSync(join(cwd, 'count.txt')), 'count.txt was created through a streamed tool call')
  assert.equal(readFileSync(join(cwd, 'count.txt'), 'utf8').trim(), '60')
  assert.ok(seen.some((a) => a.text.startsWith('Read steps.js')), 'read_file ran')
  assert.ok(live.some((a) => !a.done && /^Local model (reading its context|writing: \d+ tokens)/.test(a.text)), 'a live line while a step ran')
  assert.ok(live.some((a) => a.done && /^Local model read .* in \d+ s, then wrote \d+ tokens/.test(a.text)), 'what a long step took')
})
