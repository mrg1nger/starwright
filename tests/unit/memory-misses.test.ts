import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { setHelperJobForTests, type HelperJob } from '../../src/main/helpers/helperJob'
import { prefetchBlock } from '../../src/main/memory/context'
import { recallFacts } from '../../src/main/memory/meaning'
import { memoryDb } from '../../src/main/memory/paths'
import { missKind, runScribe, type TurnRecord } from '../../src/main/memory/scribe'
import {
  addMessage,
  factUsesBetween,
  getFact,
  judgeFactUses,
  memoryReport,
  noteFactUses,
  pruneFactUses,
  recordMiss,
  rememberFact,
  unusedFacts
} from '../../src/main/memory/store'
import { memoryLines } from '../../src/main/usage/report'

// Is memory getting smarter or just bigger? Starwright notes which facts were put in front of which
// agent, the note-taker judges afterwards which of them mattered, and when the user tells an agent
// something memory already held, that's recorded as missed (never given), ignored (given) or
// restated (said up front).

after(() => setHelperJobForTests(undefined))

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString()
const fact = (scope: string, text: string, category: 'decision' | 'about' = 'decision') =>
  rememberFact(memoryDb(), scope, text, 'user', { category }).fact

/** Scribe answers this, once. */
function answer(structured: Record<string, unknown>, prompts: string[] = []): void {
  setHelperJobForTests(async (job: HelperJob) => {
    prompts.push(job.prompt)
    return { text: '', by: 'haiku', structured: { add: [], update: [], forget: [], relevant: [], told: [], ...structured } }
  })
}

const turn = (request: string, startedAt: string, endedAt: string): TurnRecord => ({
  request,
  replies: ['Done.'],
  actions: [],
  stopped: false,
  hadError: false,
  startedAt,
  endedAt
})

test('what is given is noted per agent and way, never key facts, and the window finds it', () => {
  const db = memoryDb()
  const p = 'p-uses'
  const a = fact(p, 'Deploys go through the staging server first.')
  const key = fact(p, 'The project is a tile-based puzzle game.', 'about')
  assert.ok(getFact(db, key.id)!.key, 'about facts are key')
  noteFactUses(db, p, [a.id, a.id, key.id], 'pushed', 'claude', iso(5000))
  noteFactUses(db, p, [a.id], 'recalled', 'codex', iso(1000))
  noteFactUses(db, p, [a.id], 'pushed', 'claude', iso(60 * 60 * 1000))
  assert.deepEqual(factUsesBetween(db, p, iso(10_000), iso(0)), [
    { factId: a.id, how: 'pushed', agent: 'claude' },
    { factId: a.id, how: 'recalled', agent: 'codex' }
  ])
  assert.equal(judgeFactUses(db, p, iso(10_000), iso(0), [a.id]), 2)
  assert.equal(judgeFactUses(db, p, iso(10_000), iso(0), []), 0, 'judged once only')
})

test('a request pushes facts and says so; the note-taker looking is not a use', async () => {
  const db = memoryDb()
  const p = 'p-push'
  const f = fact(p, 'Sprites are drawn at 32 pixels per tile.')
  const block = await prefetchBlock(p, 'what size are the sprites per tile?', 'claude')
  assert.match(block ?? '', /32 pixels per tile/)
  assert.deepEqual(factUsesBetween(db, p, iso(60_000), iso(-1000)), [{ factId: f.id, how: 'pushed', agent: 'claude' }])
  const before = getFact(db, f.id)!.useCount
  await recallFacts(db, p, 'sprites pixels tile', 10, false)
  assert.equal(getFact(db, f.id)!.useCount, before, 'not counted')
  await recallFacts(db, p, 'sprites pixels tile')
  assert.equal(getFact(db, f.id)!.useCount, before + 1, 'an agent looking is')
})

test('the note-taker judges what was given and records what the user had to say again', async () => {
  const db = memoryDb()
  const p = 'p-misses'
  const port = fact(p, 'The dev server runs on port 5173.')
  const tabs = fact(p, 'Code is indented with tabs.')
  const deploy = fact(p, 'Deploys need the VPN switched on first.')
  const about = fact(p, 'The project is a recipe site.', 'about')

  // The request before: the port was given to Claude, the VPN wasn't.
  const first = turn('Start the dev server.', iso(120_000), iso(100_000))
  noteFactUses(db, p, [port.id], 'pushed', 'claude', iso(110_000))
  answer({})
  await runScribe(p, first)

  // This request: the user corrects twice and mentions tabs up front; tabs is given now.
  const start = iso(50_000)
  noteFactUses(db, p, [tabs.id], 'pushed', 'claude', iso(40_000))
  const prompts: string[] = []
  answer(
    {
      relevant: [tabs.id, 'not-given'],
      told: [
        { id: port.id, correcting: true },
        { id: deploy.id, correcting: true },
        { id: tabs.id, correcting: false },
        { id: about.id, correcting: true },
        { id: 'made-up', correcting: true }
      ]
    },
    prompts
  )
  const result = await runScribe(p, turn('No, it runs on 5173 as before, the VPN has to be on, and use tabs.', start, iso(10_000)))
  assert.match(prompts[0], new RegExp(`FACTS THE ASSISTANT WAS GIVEN in this request[^\\n]*\\n- \\[${tabs.id}\\]`))
  assert.equal(result.judged, 1)
  assert.equal(result.relevant, 1)
  // At most three a request, so the key fact (ignored: every request has it) is past the limit.
  assert.deepEqual(result.misses, { ignored: 1, missed: 1, restated: 1 })
  const rows = db.prepare('SELECT fact_id, kind FROM memory_misses WHERE project_id = ? ORDER BY id').all(p) as { fact_id: string; kind: string }[]
  assert.deepEqual(
    rows.map((r) => [r.fact_id, r.kind]),
    [
      [port.id, 'ignored'],
      [deploy.id, 'missed'],
      [tabs.id, 'restated']
    ]
  )
  const judged = db.prepare('SELECT relevant FROM fact_uses WHERE project_id = ? AND fact_id = ?').get(p, tabs.id) as { relevant: number }
  assert.equal(judged.relevant, 1)

  const report = memoryReport(db, iso(86_400_000), p)
  assert.deepEqual(report.misses, { missed: 1, ignored: 1, restated: 1 })
  assert.equal(report.given.pushed.total, 2)
  assert.deepEqual(report.top.map((t) => t.factId).sort(), [deploy.id, port.id].sort())
})

test('a key fact the user had to repeat was in front of the agent', () => {
  assert.equal(missKind(true, true), 'ignored')
  assert.equal(missKind(true, false), 'missed')
  assert.equal(missKind(false, false), 'restated')
  assert.equal(missKind(false, true), 'restated')
})

test('a correction from the user says so on the fact it replaced', async () => {
  const db = memoryDb()
  const p = 'p-from-user'
  const old = fact(p, 'Images live in the assets folder.')
  answer({ update: [{ id: old.id, text: 'Images live in the public folder.', files: [], fromUser: true }] })
  await runScribe(p, turn('Images are in public, not assets.', iso(20_000), iso(1000)))
  assert.equal(getFact(db, old.id)!.forgottenReason, 'corrected automatically (from what the user said)')
})

test('a fact search keeps missing is not retired as unused', () => {
  const db = memoryDb()
  const p = 'p-unused-missed'
  const old = new Date(Date.now() - 90 * 86_400_000).toISOString()
  const quiet = fact(p, 'The old splash screen fades in over two seconds.')
  const missed = fact(p, 'Releases need the changelog written first.')
  for (const f of [quiet, missed]) db.prepare('UPDATE facts SET updated_at = ?, last_used_at = NULL WHERE id = ?').run(old, f.id)
  for (let i = 0; i < 30; i++) addMessage(db, p, 'user', `request ${i}`)
  recordMiss(db, p, missed.id, 'missed', 'Write the changelog before releasing!')
  assert.deepEqual(unusedFacts(db, p).map((f) => f.id), [quiet.id])
})

test('old records are dropped, and the report reads plainly', () => {
  const db = memoryDb()
  const p = 'p-prune'
  const f = fact(p, 'The API key is read from the environment.')
  noteFactUses(db, p, [f.id], 'pushed', 'claude', new Date(Date.now() - 200 * 86_400_000).toISOString())
  recordMiss(db, p, f.id, 'missed', 'old', new Date(Date.now() - 200 * 86_400_000).toISOString())
  pruneFactUses(db)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM fact_uses WHERE project_id = ?').get(p) as { n: number }).n, 0)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memory_misses WHERE project_id = ?').get(p) as { n: number }).n, 0)

  const lines = memoryLines(
    {
      misses: { missed: 2, ignored: 1, restated: 4 },
      weeks: [
        { week: '2026-11-16', missed: 1, ignored: 0, restated: 1 },
        { week: '2026-11-23', missed: 1, ignored: 1, restated: 3 }
      ],
      given: { pushed: { total: 40, judged: 20, relevant: 9 }, brought: { total: 6, judged: 4, relevant: 1 }, recalled: { total: 12, judged: 0, relevant: 0 } },
      recalls: { codex: 4, claude: 8 },
      top: [{ factId: 'x', text: 'Releases need the changelog written first.', missed: 2, ignored: 0 }]
    },
    7
  )
  assert.equal(lines[0], '## Memory (last 7 days; counted from 0.27.0)')
  assert.match(lines[1], /40 pushed with requests, 45% of 20 judged mattered · 6 brought along by links, 25% of 4 judged mattered · 12 looked up by agents$/)
  assert.equal(lines[2], '- Look-ups by agent: Claude 8 · Codex 4')
  assert.match(lines[3], /2 missed \(it wasn't given to the agent\), 1 ignored .* 4 said up front/)
  assert.match(lines[4], /^- By week: 2026-11-16 1 missed/)
  assert.equal(lines[5], '- Missed or ignored: "Releases need the changelog written first." (2 missed, 0 ignored)')
  const none = memoryLines({ misses: { missed: 0, ignored: 0, restated: 0 }, weeks: [], given: { pushed: { total: 0, judged: 0, relevant: 0 }, brought: { total: 0, judged: 0, relevant: 0 }, recalled: { total: 0, judged: 0, relevant: 0 } }, recalls: {}, top: [] }, 7)
  assert.deepEqual(none.slice(1), ['- Facts given to agents: none yet', '- You told an agent what memory already held: never, so far'])
})
