import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import type { LiveTokens, LiveUsageUpdate, VibeEvent } from '@shared/types'
import { updateSettings } from '../../src/main/settings/store'
import { runCodexExec } from '../../src/main/cli/codexExec'
import { runCline } from '../../src/main/cli/clineExec'
import { stopHostedCline } from '../../src/main/cli/clineAcp'
import { codexTokenReader, pollTokens } from '../../src/main/delegation/liveTokens'
import { makeProject, projectId, testSession, turn } from '../support/fixtures'

after(() => stopHostedCline())

// Tokens while work runs, from the real tools: Claude's stream (Haiku), Codex's session file and
// hosted Cline's session file, each seen growing before the run ends. Small runs on each plan.

test("Claude's tokens arrive while it writes, and end close to the request's own count", { timeout: 300_000 }, async (t) => {
  updateSettings({ claudeModel: 'haiku', autoMemory: false })
  const s = testSession(t, projectId('live'), makeProject())
  const live: Extract<LiveUsageUpdate, { kind: 'claude' }>[] = []
  s.on('live', (u: LiveUsageUpdate) => u.kind === 'claude' && live.push(u))
  const events = await turn(s, 'Read shop.js, then write about 300 words on how a shop like this could be improved. No headings.')
  const usage = events.find((e): e is Extract<VibeEvent, { type: 'usage' }> => e.type === 'usage')
  assert.ok(usage, 'a usage line at the end')
  assert.ok(live.length >= 3, `several live updates (${live.length})`)
  const last = live[live.length - 1]
  assert.ok(live.some((u) => u.written > 0 && u.written < last.written), 'the written count grew during the reply')
  assert.ok(last.read > 1000, `the conversation's size is known (${last.read})`)
  assert.equal(new Set(live.map((u) => u.turn)).size, 1, 'one turn')
  // The last figures are exact: the same as the request's own count.
  assert.equal(last.written, usage.output, `live ${last.written} vs final ${usage.output}`)
  console.log(`Claude: ${live.length} updates, ${last.steps} steps, wrote ${last.written}, context ${last.read}`)
})

test("a Codex run's tokens show from its session file before it ends", { timeout: 400_000 }, async () => {
  const dir = makeProject()
  const seen: LiveTokens[] = []
  let stop: (() => void) | undefined
  const result = await runCodexExec({
    prompt: 'List the files here, read shop.js, then add a comment line "// checked" at the top of shop.js. Reply in one line.',
    cwd: dir,
    timeoutMs: 300_000,
    onThread: (id) => {
      const startedAt = new Date()
      stop = pollTokens(codexTokenReader(id, startedAt), (tk) => seen.push(tk), 500)
    }
  })
  const endedAt = seen.length
  stop?.()
  assert.equal(result.exitCode, 0, result.finalMessage)
  assert.ok(seen.length >= 1, 'tokens seen')
  assert.ok(endedAt >= 1, `seen while it ran (${endedAt} before it ended)`)
  const last = seen[seen.length - 1]
  const turnDone = result.events.find((e) => e.type === 'turn.completed') as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined
  if (turnDone?.usage) assert.equal(last.written, turnDone.usage.output_tokens, 'ends on the same total as its own event')
  console.log(`Codex: ${seen.length} updates (${endedAt} while running), last ${JSON.stringify(last)}`)
})

test("a hosted Cline run's tokens show from its session file before it ends", { timeout: 400_000 }, async () => {
  const dir = makeProject()
  const seen: LiveTokens[] = []
  const result = await runCline({
    prompt: 'List the files here, read shop.js, then add a comment line "// checked" at the top of shop.js. Reply in one line.',
    mode: 'build',
    cwd: dir,
    timeoutMs: 300_000,
    onTokens: (tk) => seen.push(tk)
  })
  assert.ok(result.ok, result.error)
  // The last look when it ends gives one: more than one means some came while it ran.
  assert.ok(seen.length >= 2, `tokens seen while it ran (${seen.length} updates)`)
  const last = seen[seen.length - 1]
  assert.equal(last.written, result.usage.output, 'ends on the same total as the run reports')
  console.log(`Cline: ${seen.length} updates, last ${JSON.stringify(last)}, final ${JSON.stringify(result.usage)}`)
})
