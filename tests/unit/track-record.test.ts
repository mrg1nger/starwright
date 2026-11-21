import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryDb } from '../../src/main/memory/paths'
import {
  finishHandoff,
  handoffModelsSince,
  handoffMovesSince,
  latestHandoffModel,
  recordReview,
  startHandoff,
  trackRows,
  workByKind
} from '../../src/main/memory/store'
import {
  TRACK_DAYS,
  applyTrackRecord,
  assess,
  moveTag,
  orderNote,
  recordText,
  verdictOf,
  versionAtLeast,
  whoOf,
  type Track,
  type TrackRow
} from '../../src/main/delegation/trackRecord'
import { fillHandoffModels, trackLines, trackSummary } from '../../src/main/delegation/trackReport'
import { codexRunModel, matchCodexRuns, parseSessionName } from '../../src/main/cli/codexSessions'

const row = (over: Partial<TrackRow> = {}): TrackRow => ({ status: 'done', checksOk: 1, reworked: 0, report: 'r', version: '0.21.0', model: 'm1', ...over })

test('versions compare by number, and a record with no version is older than any', () => {
  assert.ok(versionAtLeast('0.19.2', '0.19.2'))
  assert.ok(versionAtLeast('0.20.0', '0.19.2'))
  assert.ok(versionAtLeast('0.19.10', '0.19.2'), 'numbers, not text')
  assert.ok(!versionAtLeast('0.19.1', '0.19.2'))
  assert.ok(!versionAtLeast(null, '0.19.2'))
  assert.ok(versionAtLeast('0.0.0-test', '0.0.0'))
})

test('what counts against an agent: failures, failed checks, redone work; not a Stop or a refusal', () => {
  assert.equal(verdictOf(row()), 'good')
  assert.equal(verdictOf(row({ checksOk: null })), 'good', 'no checks ran')
  assert.equal(verdictOf(row({ status: 'error' })), 'bad')
  assert.equal(verdictOf(row({ checksOk: 0 })), 'bad')
  assert.equal(verdictOf(row({ reworked: 1 })), 'bad')
  assert.equal(verdictOf(row({ status: 'stopped' })), null, 'the user stopped it')
  assert.equal(verdictOf(row({ status: 'error', report: 'Done half.\n[Starwright refused one thing Cline tried: pushing]' })), null)
})

test('the record: last 5 of a kind, on its current model, since its last fix', () => {
  const bad = row({ status: 'error' })
  // Newest first.
  let t = assess('codex', 'feature', [bad, bad, row(), bad, row(), bad, bad])
  assert.deepEqual([t.bad, t.of], [3, 5], 'only the last five count')
  t = assess('cline', 'feature', [bad, bad, row({ status: 'error', version: '0.19.1' }), row({ status: 'error', version: null })])
  assert.deepEqual([t.bad, t.of, t.since], [2, 2, '0.19.2'], "failures before Cline's fix don't count")
  t = assess('local', 'tests', [bad, bad, row({ status: 'error', model: 'm0' }), row({ status: 'error', model: 'm0' })], 'm1')
  assert.deepEqual([t.bad, t.of], [2, 2], "another model's failures don't count: a new model starts clean")
  t = assess('codex', 'feature', [row({ model: null, status: 'error' })], null)
  assert.deepEqual([t.bad, t.of], [1, 1], 'with no model known, all its records count')
})

test('an agent that keeps failing goes behind the next one, never one asked for by name', () => {
  const track = (route: Track['route'], bad: number): Track => ({ route, kind: 'feature', bad, of: 5 })
  let out = applyTrackRecord(['local', 'cline', 'codex'], { local: track('local', 3), cline: track('cline', 1), codex: track('codex', 0) })
  assert.deepEqual(out.routes, ['cline', 'local', 'codex'], 'one place down, still before Codex')
  assert.deepEqual(out.moved.map((m) => m.route), ['local'])
  out = applyTrackRecord(['local', 'cline', 'codex'], { local: track('local', 3), cline: track('cline', 4), codex: track('codex', 0) })
  assert.deepEqual(out.routes, ['codex', 'local', 'cline'], 'both behind the first that does well, keeping their order')
  out = applyTrackRecord(['codex', 'cline'], { codex: track('codex', 0), cline: track('cline', 5) })
  assert.deepEqual(out.routes, ['codex', 'cline'], 'already last: nothing to move')
  assert.equal(out.moved.length, 0, "and it isn't reported as moved")
  out = applyTrackRecord(['local', 'cline', 'codex'], { local: track('local', 5) }, 'local')
  assert.deepEqual(out.routes, ['local', 'cline', 'codex'], 'asked for by name')
  out = applyTrackRecord(['cline', 'codex'], { cline: track('cline', 2) })
  assert.deepEqual(out.routes, ['cline', 'codex'], 'two bad of five is not enough')
})

test('the words: chat, header, and the records', () => {
  const t: Track = { route: 'cline', kind: 'feature', model: 'model-x', bad: 3, of: 5, since: '0.19.2' }
  assert.equal(whoOf(t), 'Cline (model-x)')
  assert.equal(whoOf({ route: 'local' }, false), 'the local model')
  assert.equal(recordText(t), '3 of its last 5 feature hand-offs failed or were redone, since 0.19.2')
  assert.equal(moveTag(t), 'cline:model-x feature 3/5')
  assert.equal(orderNote(['codex', 'cline', 'local'], [t]), 'codex, cline↓ (feature 3/5), local')
})

test('hand-off records keep the version, the model and the moves; the track record and report come from them', async () => {
  const db = memoryDb()
  const P = 'track-record-project'
  const since = new Date(Date.now() - 60_000).toISOString()
  const add = (agent: string, kind: string, status: 'done' | 'error', model: string | null, version = '0.21.0', extra: { order?: string; movedDown?: string } = {}) => {
    const id = startHandoff(db, P, agent, 'brief', 'req', { kind, difficulty: 'simple', version, ...extra })
    finishHandoff(db, id, { status, report: 'r', files: [], checksOk: null, model, effort: agent === 'codex' ? 'high' : null })
    return id
  }
  // Cline on model-x: 3 failed features since its fix, 2 before it (not counted).
  add('cline', 'trk-feature', 'error', 'model-x', '0.19.0')
  add('cline', 'trk-feature', 'error', 'model-x', '0.19.1')
  add('cline', 'trk-feature', 'done', 'model-x')
  add('cline', 'trk-feature', 'error', 'model-x')
  add('cline', 'trk-feature', 'error', 'model-x')
  add('cline', 'trk-feature', 'error', 'model-x')
  // The local model: 2 failed tests, not enough.
  add('local', 'trk-tests', 'error', 'qwen')
  add('local', 'trk-tests', 'error', 'qwen')
  add('local', 'trk-tests', 'done', 'qwen')
  // A hand-off the record changed: Cline was moved down, Codex took it.
  add('codex', 'trk-feature', 'done', 'gpt-x', '0.21.0', { order: 'codex, cline↓ (trk-feature 3/4), local', movedDown: 'cline:model-x trk-feature 3/4' })

  assert.equal(latestHandoffModel(db, 'cline'), 'model-x')
  const window = new Date(Date.now() - TRACK_DAYS * 86_400_000).toISOString()
  const cline = assess('cline', 'trk-feature', trackRows(db, 'cline', 'trk-feature', window), latestHandoffModel(db, 'cline'))
  assert.deepEqual([cline.bad, cline.of], [3, 4])

  assert.deepEqual(handoffMovesSince(db, P, since), ['cline:model-x trk-feature 3/4'])
  assert.ok(handoffModelsSince(db, P, since).includes('cline:model-x'))
  assert.ok(handoffModelsSince(db, P, since).includes('codex:gpt-x'))
  const codexRow = db.prepare("SELECT model, effort, app_version, order_note FROM handoffs WHERE project_id = ? AND agent = 'codex'").get(P) as Record<string, string>
  assert.deepEqual({ ...codexRow }, { model: 'gpt-x', effort: 'high', app_version: '0.21.0', order_note: 'codex, cline↓ (trk-feature 3/4), local' })

  // A review records the models of the hand-offs that built the change.
  const review = recordReview(db, { projectId: P, reviewer: 'codex', builtBy: ['cline'], builtModels: handoffModelsSince(db, P, since), findings: [] })
  const built = JSON.parse((db.prepare('SELECT built_models FROM review_log WHERE id = ?').get(review) as { built_models: string }).built_models) as string[]
  assert.ok(built.includes('cline:model-x'))

  // The report: per kind and model, and the track record.
  const byKind = workByKind(db, since, P)
  assert.ok(byKind.some((k) => k.route === 'cline' && k.model === 'model-x' && k.kind === 'trk-feature' && k.total === 6))
  const summary = trackSummary(db, P)
  assert.ok(summary.moved.some((m) => m.route === 'cline' && m.kind === 'trk-feature' && m.model === 'model-x'))
  assert.ok(summary.watching.some((m) => m.route === 'local' && m.kind === 'trk-tests' && m.bad === 2))
  const lines = trackLines(summary).join('\n')
  assert.match(lines, /^## Track record \(last 30 days; 3 bad of an agent's last 5 hand-offs of a kind moves it down; counting since its last fix: Cline from 0\.19\.2, Local model from 0\.20\.1\)/)
  assert.match(lines, /- Moved down now: .*Cline \(model-x\) for trk-feature \(3 of 4\)/)
  assert.match(lines, /- Some bad lately: .*The local model \(qwen\) trk-tests 2 of 3/)
  assert.match(lines, /- Changed who got the task: 1 time; those went to Codex 1 done, 0 failed/)
})

test("earlier hand-offs get their model: Cline's and the local model's from the token log, Codex's from its session files", async () => {
  const db = memoryDb()
  const P = 'track-fill-project'
  db.prepare("DELETE FROM meta WHERE key = 'filled_handoff_models'").run()
  const at = (offsetMs: number) => new Date(Date.now() - 3_600_000 + offsetMs).toISOString()
  const old = (agent: string, start: number, end: number) => {
    const id = Number(
      db.prepare("INSERT INTO handoffs (project_id, agent, brief, status, started_at, finished_at, task_kind) VALUES (?, ?, 'b', 'done', ?, ?, 'feature')").run(P, agent, at(start), at(end))
        .lastInsertRowid
    )
    return id
  }
  const local = old('local', 0, 60_000)
  const cline = old('cline', 120_000, 180_000)
  const usage = db.prepare("INSERT INTO usage_log (at, project_id, kind, agent, model) VALUES (?, ?, 'handoff', ?, ?)")
  usage.run(at(55_000), P, 'lmstudio', 'qwen/qwen3.6-35b-a3b')
  usage.run(at(175_000), P, 'cline', 'cline-model')
  usage.run(at(400_000), P, 'cline', 'later-model') // another run, outside the hand-off

  // Codex: a session file for the hand-off, and its command reviewer's beside it (not the one).
  const codexStart = new Date(Date.now() - 3_600_000 + 300_000)
  const codex = old('codex', 300_000, 360_000)
  const root = mkdtempSync(join(tmpdir(), 'codex-sessions-'))
  const pad = (n: number) => String(n).padStart(2, '0')
  const dir = join(root, String(codexStart.getFullYear()), pad(codexStart.getMonth() + 1), pad(codexStart.getDate()))
  mkdirSync(dir, { recursive: true })
  const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  const session = (offsetS: number, id: string, model: string) =>
    writeFileSync(
      join(dir, `rollout-${stamp(new Date(codexStart.getTime() + offsetS * 1000))}-${id}.jsonl`),
      [
        JSON.stringify({ type: 'session_meta', payload: { id, instructions: 'x'.repeat(5000) } }),
        JSON.stringify({ type: 'turn_context', payload: { model, effort: 'high' } })
      ].join('\n')
    )
  session(2, 'reviewer-thread', 'codex-auto-review')
  session(3, 'work-thread', 'gpt-5.6-sol')

  assert.deepEqual(parseSessionName('rollout-2026-11-19T08-54-39-01a1f484-6591.jsonl')?.id, '01a1f484-6591')
  const matched = await matchCodexRuns([{ id: codex, startedAt: codexStart.toISOString() }], root)
  assert.deepEqual(matched.get(codex), { model: 'gpt-5.6-sol', effort: 'high' })
  assert.equal(await codexRunModel('reviewer-thread', root), null, "the command reviewer isn't the model that did the work")

  const filled = await fillHandoffModels(db)
  assert.ok(filled.usage >= 2)
  const modelOf = (id: number) => (db.prepare('SELECT model FROM handoffs WHERE id = ?').get(id) as { model: string | null }).model
  assert.equal(modelOf(local), 'qwen/qwen3.6-35b-a3b')
  assert.equal(modelOf(cline), 'cline-model')
  const again = await fillHandoffModels(db)
  assert.deepEqual(again, { usage: 0, codex: 0 }, 'only once')
})
