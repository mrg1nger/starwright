import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryDb } from '../../src/main/memory/paths'
import { finishHandoff, logRequest, logUsage, recordReview, startHandoff, workSummary } from '../../src/main/memory/store'
import { workSection } from '../../src/main/usage/report'

const P = 'work-meters-project'
const zero = { fresh: 0, cached: 0, output: 0 }

test('who did the work: building, leading, reviews, background jobs and how hand-offs went, per route', () => {
  const db = memoryDb()
  const since = new Date(Date.now() - 60_000).toISOString()
  const usage = (kind: Parameters<typeof logUsage>[1]['kind'], agent: Parameters<typeof logUsage>[1]['agent'], n = 1): void => {
    for (let i = 0; i < n; i++) logUsage(db, { projectId: P, kind, agent, fresh: 10, cached: 0, output: 1 })
  }
  usage('request', 'claude', 3)
  usage('takeover', 'codex')
  usage('review', 'codex', 2)
  usage('scribe', 'claude', 2)
  usage('scribe', 'lmstudio', 3) // LM Studio is the local model
  usage('codemap', 'cline')

  // Claude edited files itself in one of two requests.
  const request = (tools: Record<string, number>): void =>
    logRequest(db, {
      at: new Date().toISOString(),
      projectId: P,
      mode: 'build',
      balance: null,
      route: null,
      size: 'normal',
      model: null,
      text: 'x',
      outcome: 'done',
      seconds: 1,
      claudeSteps: 3,
      tools,
      handoffs: 0,
      claude: zero,
      codex: zero,
      cline: zero
    })
  request({ edit: 2, read: 1 })
  request({ read: 4 })

  const handoff = (agent: string, status: 'done' | 'error', checksOk: boolean | null): void =>
    finishHandoff(db, startHandoff(db, P, agent, 'brief', null), { status, report: 'r', files: null, checksOk })
  handoff('codex', 'done', true)
  handoff('codex', 'done', false)
  handoff('local', 'done', true)
  handoff('local', 'error', null)
  handoff('cline', 'done', null)
  startHandoff(db, P, 'codex', 'still running', null) // not counted until it's over

  recordReview(db, { projectId: P, reviewer: 'codex', builtBy: ['claude', 'local'], findings: [{ severity: 'high' }, { severity: 'low' }] })
  recordReview(db, { projectId: P, reviewer: 'codex', builtBy: ['claude'], findings: [{ severity: 'low' }] })

  const work = workSummary(db, since, P)
  assert.equal(work.claude.lead, 3)
  assert.equal(work.codex.lead, 1, 'a takeover is Codex in charge')
  assert.equal(work.claude.build, 1, 'one request where Claude edited files itself')
  assert.equal(work.codex.build, 2)
  assert.equal(work.local.build, 2)
  assert.equal(work.cline.build, 1)
  assert.deepEqual(work.codex.handoffs, { total: 2, failed: 0, checksRun: 2, checksFailed: 1, reworked: 0 })
  assert.deepEqual(work.local.handoffs, { total: 2, failed: 1, checksRun: 1, checksFailed: 0, reworked: 0 })
  assert.equal(work.codex.review, 2)
  assert.equal(work.claude.background, 2)
  assert.equal(work.local.background, 3)
  assert.equal(work.cline.background, 1)
  assert.deepEqual(work.claude.reviewed, { total: 2, serious: 1, fixesChecked: 0, fixesFailed: 0 }, 'only high or medium findings count as serious')
  assert.deepEqual(work.local.reviewed, { total: 1, serious: 1, fixesChecked: 0, fixesFailed: 0 })

  const text = workSection(work).join('\n')
  assert.match(text, /Building \(Claude editing itself, or a hand-off\): Claude 17% \(1\) · Codex 33% \(2\) · Cline 17% \(1\) · Local model 33% \(2\)/)
  assert.match(text, /Codex 2 \(0 failed; checks failed 1 of 2 run; 0 redone\)/)
  assert.match(text, /Local model 1 of 1/)
})
