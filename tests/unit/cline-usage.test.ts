import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLINE_USAGE_URL, fetchClineUsage, parseClineLimits } from '../../src/main/cline/clineUsage'
import { chooseRoutes } from '@shared/balance'

const all = { codex: true, cline: true, local: true }

test("ClinePass limits are read from Cline's answer, in 5-hour, weekly, monthly order", () => {
  const windows = parseClineLimits({
    success: true,
    data: {
      limits: [
        { type: 'monthly', percentUsed: 27, resetsAt: '2026-12-13T18:00:00Z' },
        { type: 'five_hour', percentUsed: 29.4, resetsAt: 1_794_950_000 },
        { type: 'weekly', percentUsed: 56, resetsAt: 1_794_950_000_000 },
        { type: 'daily_burst', percentUsed: 3, resetsAt: null }
      ]
    }
  })
  assert.deepEqual(
    windows.map((w) => [w.label, w.usedPercent]),
    [['5-hour', 29.4], ['Weekly', 56], ['Monthly', 27], ['daily burst', 3]]
  )
  assert.equal(windows[0].resetsAt, 1_794_950_000_000, 'epoch seconds become ms')
  assert.equal(windows[1].resetsAt, 1_794_950_000_000, 'epoch ms stay')
  assert.equal(windows[2].resetsAt, Date.parse('2026-12-13T18:00:00Z'), 'ISO dates are read')
  assert.equal(windows[3].resetsAt, null)
})

test('fractions (0.29 for 29%) are read as percentages, and odd values are kept in range', () => {
  const windows = parseClineLimits({ success: true, data: { limits: [{ type: 'five_hour', percentUsed: 0.29 }, { type: 'weekly', percentUsed: 0 }] } })
  assert.deepEqual(windows.map((w) => w.usedPercent), [29, 0])
  assert.equal(parseClineLimits({ success: true, data: { limits: [{ type: 'weekly', percentUsed: 140 }] } })[0].usedPercent, 100)
  assert.equal(parseClineLimits({ success: true, data: { limits: [{ type: 'weekly', percentUsed: 'n/a' }] } }).length, 0)
})

test("an answer that isn't usage limits is an error, not empty meters", () => {
  assert.throws(() => parseClineLimits(null))
  assert.throws(() => parseClineLimits({ success: false, data: { limits: [] } }))
  assert.throws(() => parseClineLimits({ success: true, data: {} }))
})

test("the check sends the key only to Cline, and explains Cline's refusals", async (t) => {
  const seen: { url: string; auth: string | null }[] = []
  let status = 200
  t.mock.method(globalThis, 'fetch', async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url, auth: init.headers.Authorization })
    return new Response(JSON.stringify({ success: true, data: { limits: [{ type: 'weekly', percentUsed: 56, resetsAt: null }] } }), { status })
  })
  const ok = await fetchClineUsage('test-key-1234')
  assert.equal(ok.status, 'ok')
  assert.equal(ok.cli, 'cline')
  assert.deepEqual(ok.windows.map((w) => w.usedPercent), [56])
  assert.deepEqual(seen, [{ url: CLINE_USAGE_URL, auth: 'Bearer test-key-1234' }])

  status = 401
  await assert.rejects(fetchClineUsage('bad'), /turned the API key down/)
  status = 429
  await assert.rejects(fetchClineUsage('k'), /check less often/)
})

test('with ClinePass nearly used up, Cline goes last but can still take work nobody else can', () => {
  const pick = (difficulty: 'simple' | 'moderate' | 'hard', available = all) =>
    chooseRoutes({ difficulty, kind: 'feature', available, codexLow: false, clineLow: true, faders: { claude: 1, codex: 3, cline: 4, local: 3 } })
  assert.deepEqual(pick('moderate'), ['codex', 'local', 'cline'])
  assert.deepEqual(pick('hard'), ['codex', 'cline'])
  assert.deepEqual(pick('hard', { codex: false, cline: true, local: true }), ['cline'], 'the only one left')
})
