import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentOfRoutedNote, routedNote } from '../../shared/handoff'
import { memoryDb } from '../../src/main/memory/paths'
import {
  finishHandoff,
  handoffAgentsSince,
  logRequest,
  markRequest,
  markReworked,
  recordReview,
  reviewOutcomes,
  setReviewFixResult,
  startHandoff,
  workByKind,
  workSummary
} from '../../src/main/memory/store'
import { chooseRoutes, handoffNote, saysLastFailed } from '../../src/main/orchestrator/routing'

const all = { codex: true, cline: true, local: true }

test('Starwright picks who gets a hand-off from how hard it is, and who can take work', () => {
  const pick = (difficulty: 'simple' | 'moderate' | 'hard', kind = 'feature', extra: Partial<Parameters<typeof chooseRoutes>[0]> = {}) =>
    chooseRoutes({ difficulty, kind: kind as never, available: all, codexLow: false, ...extra })
  assert.deepEqual(pick('simple'), ['local', 'cline', 'codex'], 'simple work: free first')
  assert.deepEqual(pick('moderate'), ['codex', 'cline', 'local'])
  assert.deepEqual(pick('moderate', 'tests'), ['local', 'cline', 'codex'], 'tests count as simple unless said to be hard')
  assert.deepEqual(pick('hard'), ['codex', 'cline'], 'never the local model for hard work')
  assert.deepEqual(pick('hard', 'feature', { codexLow: true }), ['cline', 'codex'], 'a nearly used-up Codex goes last')
  assert.deepEqual(pick('simple', 'feature', { asked: 'codex' }), ['codex', 'local', 'cline'], 'the agent the user asked for goes first')
  assert.deepEqual(pick('hard', 'feature', { asked: 'local' }), ['local', 'codex', 'cline'], 'even for hard work, if asked')
  assert.deepEqual(pick('simple', 'feature', { available: { codex: true, cline: false, local: false } }), ['codex'])
  assert.deepEqual(pick('hard', 'feature', { available: { codex: false, cline: false, local: true } }), [], 'nobody: Claude does it')
})

test("the hand-off note names only the agents that can take work, and asks Claude to split big jobs", () => {
  const note = handoffNote({ codex: true, cline: false, local: true })
  assert.match(note, /run_subtask/)
  assert.match(note, /the local model \(free, on this computer\) or Codex/)
  assert.doesNotMatch(note, /Cline/)
  assert.match(note, /Split bigger jobs/)
})

test('the chat card learns the agent from the progress note', () => {
  assert.equal(agentOfRoutedNote(routedNote('Local model', 'simple', 'tests')), 'Local model')
  assert.equal(agentOfRoutedNote(routedNote('Cline', 'moderate', 'bugfix')), 'Cline')
  assert.equal(agentOfRoutedNote('Reading src/app.js'), null)
})

test('plain words saying the last change failed are caught', () => {
  for (const yes of ['that broke the login', 'it still doesn\'t work', 'You missed the footer', 'same error as before', 'not fixed']) {
    assert.ok(saysLastFailed(yes), yes)
  }
  for (const no of ['add a footer', 'make the title blue', 'now add tests for the shop']) assert.ok(!saysLastFailed(no), no)
})

test('quality records: redone hand-offs, kinds of task, fixes that held, and your reactions', () => {
  const db = memoryDb()
  const P = 'routed-quality-project'
  const since = new Date(Date.now() - 60_000).toISOString()

  // The local model writes the tests; Claude then changes the same file: that hand-off was redone.
  const first = startHandoff(db, P, 'local', 'write tests', 'req', { kind: 'tests', difficulty: 'simple' })
  finishHandoff(db, first, { status: 'done', report: 'r', files: ['tests/shop.test.js'], checksOk: true })
  const second = startHandoff(db, P, 'codex', 'feature', 'req', { kind: 'feature', difficulty: 'moderate' })
  finishHandoff(db, second, { status: 'done', report: 'r', files: ['src/shop.js'], checksOk: true })
  markReworked(db, P, ['tests\\shop.test.js'], since) // Windows separators match too
  assert.deepEqual(handoffAgentsSince(db, P, since), { codex: 1, local: 1 })

  const byKind = workByKind(db, since, P)
  assert.deepEqual(
    byKind.find((k) => k.route === 'local'),
    { route: 'local', kind: 'tests', total: 1, failed: 0, checksFailed: 0, reworked: 1 }
  )
  assert.equal(byKind.find((k) => k.route === 'codex')?.reworked, 0)

  // A review of work Claude and the local model built; the fixes afterwards still failed the checks.
  const review = recordReview(db, { projectId: P, reviewer: 'codex', builtBy: ['claude', 'local'], findings: [{ severity: 'medium' }] })
  setReviewFixResult(db, review, false)

  // The request they built: you said it was wrong, then pressed Undo.
  const row = {
    at: new Date().toISOString(),
    projectId: P,
    mode: 'build',
    balance: null,
    route: null,
    size: 'normal',
    model: null,
    text: 'add a shop',
    outcome: 'done',
    seconds: 1,
    claudeSteps: 1,
    tools: { edit: 1 },
    handoffs: 1,
    claude: { fresh: 0, cached: 0, output: 0 },
    codex: { fresh: 0, cached: 0, output: 0 },
    cline: { fresh: 0, cached: 0, output: 0 },
    builtBy: ['claude', 'local', 'codex'],
    snapshot: 'snap-1',
    review: 'reviewed'
  }
  logRequest(db, row)
  logRequest(db, { ...row, snapshot: 'snap-2', builtBy: ['claude'], review: 'skipped: quick edit or plan' })
  markRequest(db, P, 'complaint') // the latest request
  markRequest(db, P, 'undone', 'snap-1') // the one Undo went back to

  const work = workSummary(db, since, P)
  assert.deepEqual(work.local.handoffs.reworked, 1)
  assert.deepEqual(work.local.reviewed, { total: 1, serious: 1, fixesChecked: 1, fixesFailed: 1 })
  assert.deepEqual(work.local.requests, { built: 1, complaints: 0, undone: 1 })
  assert.deepEqual(work.claude.requests, { built: 2, complaints: 1, undone: 1 })
  assert.deepEqual(reviewOutcomes(db, since, P), { reviewed: 1, 'skipped: quick edit or plan': 1 })
})

test('a hand-off passes to the next agent only when one fails without changing anything', async () => {
  const { tryInOrder } = await import('../../src/main/delegation/codexTool')
  const result = (ok: boolean, changed = 0, stopped = false, text = ok ? 'done' : 'LM Studio is not running') => ({
    content: [{ type: 'text' as const, text }],
    isError: !ok,
    outcome: { ok, stopped, changed }
  })
  const tried: string[] = []
  const passed = await tryInOrder(['local', 'cline', 'codex'], async (route) => {
    tried.push(route)
    return route === 'codex' ? result(true) : result(false)
  }, 'simple tests')
  assert.deepEqual(tried, ['local', 'cline', 'codex'])
  assert.match(passed.content[0].text, /gave this simple tests task to Codex after the local model couldn't do it \(LM Studio is not running\); Cline couldn't do it/)
  assert.equal(passed.isError, false)

  // A failure that already changed files stops there: the next agent would build on a half-done change.
  tried.length = 0
  const half = await tryInOrder(['local', 'codex'], async (route) => (tried.push(route), result(false, 2)), 'simple feature')
  assert.deepEqual(tried, ['local'])
  assert.equal(half.isError, true)

  // Stopped by the user: nobody else is tried.
  tried.length = 0
  await tryInOrder(['cline', 'codex'], async (route) => (tried.push(route), result(false, 0, true)), 'simple docs')
  assert.deepEqual(tried, ['cline'])
})
