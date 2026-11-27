import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { setHelperJobForTests, type HelperJob } from '../../src/main/helpers/helperJob'
import type { Embedder } from '../../src/main/memory/embedder'
import { BRIEF_RULES, cleanBrief, getBrief } from '../../src/main/memory/brief'
import { LEARNED_ASK, learnedFrom } from '../../src/main/memory/context'
import { applyHealthFix, checkMemoryHealth, dismissHealthIssue, healthSummary } from '../../src/main/memory/health'
import { setEmbedderForTests } from '../../src/main/memory/meaning'
import { memoryDb } from '../../src/main/memory/paths'
import { runScribe, SAME_FACT, type TurnRecord } from '../../src/main/memory/scribe'
import { finishHandoff, getFact, GLOBAL_SCOPE, listFacts, rememberFact, setMeta, startHandoff, updateFact } from '../../src/main/memory/store'
import { isThrowawayProcedure, procedureRisk } from '../../src/main/memory/wording'
import { healthLines } from '../../src/main/usage/report'

// The causes, and Starwright's own check of what memory has saved. The examples are from a real
// install's memory (2026-11-27): a brief that quoted the brief-writer's own rules as "the user's
// rules", the same pitfall saved twice, a test start command saved as a key procedure.

after(() => {
  setHelperJobForTests(undefined)
  setEmbedderForTests(undefined)
})

// A stand-in for the language model: texts about the same subject point the same way; a text about
// none of them gets a direction of its own (by its first word), so unrelated facts stay apart.
const SUBJECTS = [
  ['supervise', 'daemon', 'openrc'],
  ['deploy', 'tarball', 'scp'],
  ['attachment', 'attachments', 'ciphertext'],
  ['apk', 'community', 'repositories'],
  ['tabs', 'indent', 'indentation'],
  ['quota', 'storage']
]
const OTHERS = 24
const standIn: Embedder = {
  model: 'stand-in-health',
  async embed(text) {
    const v = new Float32Array(SUBJECTS.length + OTHERS)
    const words = text.toLowerCase().match(/[a-z]+/g) ?? []
    SUBJECTS.forEach((s, i) => {
      v[i] = words.some((w) => s.includes(w)) ? 1 : 0
    })
    if (!v.some(Boolean)) {
      let h = 0
      for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0
      v[SUBJECTS.length + (h % OTHERS)] = 1
    }
    const length = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
    return v.map((x) => x / length)
  }
}
setEmbedderForTests(standIn)

const BRIEF = `WHAT IT IS
WebNotes is an encrypted Markdown notes app.

RUN, TEST, DEPLOY
- Start with test key: cd "D:\\Vibe\\AstraSSH" && rm -rf data && CREDENTIALS_KEY=test-key nohup node server.js > /tmp/a.log 2>&1 & sleep 1 cat /tmp/a.log
- Deploy to server: cd "D:\\Vibe\\AstraSSH" && node scripts/deploy.js. Handles Alpine Linux by installing Node via apk.

CONVENTIONS AND RULES
- "Never include secrets, keys, passwords or tokens. Refer to them by environment variable name only."
- "State only what the material supports. Never invent ports, hosts, paths, versions or commands."
- "At most 500 words, plain text, no preamble."
- "Approved 2026-11-26: Web-based SSH client (plan #59, full text in the plans memory tool)."

PITFALLS
- Never invent a port when the docs don't say one.`

test("the brief loses lines that repeat its own instructions, rules the user never gave, and whole commands saved as procedures", () => {
  const procedures = [
    'Procedure - Start AstraSSH with test key: cd "D:\\Vibe\\AstraSSH" && rm -rf data && CREDENTIALS_KEY=test-key nohup node server.js > /tmp/a.log 2>&1 & sleep 1 cat /tmp/a.log',
    'Procedure - Deploy AstraSSH to server: cd "D:\\Vibe\\AstraSSH" && node scripts/deploy.js'
  ]
  const { text, dropped } = cleanBrief(BRIEF, { userSaid: [], procedures })
  assert.ok(!/no preamble|Never include secrets|State only what|Approved 2026/.test(text), text)
  assert.ok(!text.includes('CONVENTIONS AND RULES'), 'a heading left empty goes too')
  assert.ok(text.includes('WebNotes is an encrypted Markdown notes app.'))
  assert.ok(text.includes('- Start with test key: the exact commands are saved as a procedure'), text)
  assert.ok(text.includes('- Deploy to server: the exact commands are saved as a procedure (look it up with recall). Handles Alpine Linux'), text)
  assert.ok(text.includes("Never invent a port when the docs don't say one."), 'a real pitfall stays, though it shares words with a rule')
  assert.equal(dropped.filter((d) => d.why.startsWith('repeats')).length, 3)
  assert.equal(dropped.filter((d) => d.why.startsWith("isn't")).length, 1)
  assert.equal(dropped.filter((d) => d.why.startsWith('copies')).length, 2)

  // A rule the user did give stays, quoted however closely.
  const kept = cleanBrief('CONVENTIONS AND RULES\n- "Never include secrets in commits; refer to keys by variable name."', {
    userSaid: ['Preference: never include secrets in commits, refer to keys by their variable name.'],
    procedures: []
  })
  assert.equal(kept.dropped.length, 0)
  assert.ok(BRIEF_RULES.some((r) => r.includes('never repeat them')), 'the writer is told, too')
})

test('which procedures are steps for trying something out, and which delete things', () => {
  assert.equal(isThrowawayProcedure('Procedure - Start AstraSSH with test key: rm -rf data && CREDENTIALS_KEY=test-key node server.js'), true)
  assert.equal(isThrowawayProcedure('Procedure - Stop AstraSSH and clean data: pkill -f "node server.js"; rm -f data/connections.json'), true)
  assert.equal(isThrowawayProcedure('Procedure - Run the test suite: npm test, then npm run test:attachments'), false)
  assert.equal(isThrowawayProcedure('Procedure - Clean build and deploy: rm -rf dist && npm run build && node scripts/deploy.mjs'), false)
  assert.deepEqual(procedureRisk('Procedure - Deploy to the box: rm -rf /opt/app/old && tar xzf app.tgz'), { deletes: true, testOnly: false, routine: true })
  assert.equal(procedureRisk('The deploy uses rsync.'), null, 'not a procedure')
})

test("a hand-off's report gives what it said was worth knowing", () => {
  assert.ok(LEARNED_ASK.includes('Worth knowing next time:'))
  const report = `Fixed the upload.\n\nWorth knowing next time:\n- **The dev server** must be started with PORT set, or Vite's proxy misses it.\n- Tests need a NOTES_DIR.\n\nChecks: syntax OK in server.js`
  assert.deepEqual(learnedFrom(report), ["The dev server must be started with PORT set, or Vite's proxy misses it.", 'Tests need a NOTES_DIR.'])
  assert.deepEqual(learnedFrom('Done.\nWorth knowing next time: nothing.'), [])
  assert.deepEqual(learnedFrom('Done, nothing else.'), [])
  assert.deepEqual(learnedFrom('Worth knowing next time: the cache lives in .cache/x\n'), ['the cache lives in .cache/x'])
})

const turn = (request: string, extra: Partial<TurnRecord> = {}): TurnRecord => ({ request, replies: ['Done.'], actions: [], stopped: false, hadError: false, ...extra })

function scribeAnswers(structured: Record<string, unknown>, prompts: string[] = []): void {
  setHelperJobForTests(async (job: HelperJob) => {
    prompts.push(job.prompt)
    return { text: '', by: 'haiku', structured: { add: [], update: [], forget: [], relevant: [], told: [], ...structured } }
  })
}

test("the note-taker skips test steps as procedures, never makes a procedure key, and reads the helpers' findings", async () => {
  const p = 'health-scribe'
  const start = new Date(Date.now() - 60_000).toISOString()
  const id = startHandoff(memoryDb(), p, 'codex', 'Fix the upload', null)
  finishHandoff(memoryDb(), id, { status: 'done', report: 'Fixed.\n\nWorth knowing next time:\n- Uploads over 5 MB are refused by the proxy, not the app.', files: [] })
  const prompts: string[] = []
  scribeAnswers(
    {
      add: [
        { text: 'Procedure - Start the app with test key: rm -rf data && CREDENTIALS_KEY=test-key node server.js', category: 'setup', key: true, global: false, files: [], standing: false },
        { text: 'Procedure - Deploy to the box: npm run build && scp app.tgz box: && ssh box "tar xzf app.tgz"', category: 'setup', key: true, global: false, files: [], standing: false },
        { text: 'Uploads over 5 MB are refused by the proxy, not the app.', category: 'gotcha', key: false, global: false, files: [], standing: false }
      ]
    },
    prompts
  )
  const commands = ['rm -rf data && CREDENTIALS_KEY=test-key node server.js', 'npm run build && scp app.tgz box: && ssh box "tar xzf app.tgz"']
  const r = await runScribe(p, turn('Fix uploads and deploy', { commands, startedAt: start, endedAt: new Date(Date.now() + 1000).toISOString() }))
  assert.equal(r.added, 2)
  assert.ok(prompts[0].includes('WHAT THE HELPERS FOUND OUT'), 'the helper finding is shown')
  assert.ok(prompts[0].includes('Uploads over 5 MB are refused by the proxy'))
  const facts = listFacts(memoryDb(), p)
  assert.ok(!facts.some((f) => /test key/.test(f.text)), 'the test start is not saved')
  const deploy = facts.find((f) => f.text.startsWith('Procedure - Deploy'))
  assert.equal(deploy?.key, false, 'a procedure is never key')
  assert.ok(facts.some((f) => f.text.startsWith('Uploads over 5 MB')), "the helper's finding is saved (its number came from the helper)")
})

test('saved again with more detail, a fact replaces the old one instead of sitting beside it', async () => {
  const p = 'health-same'
  const old = rememberFact(memoryDb(), p, 'Stale supervise-daemon processes block new starts; run rc-service zap.', 'scribe', { category: 'gotcha' }).fact
  assert.ok(SAME_FACT >= 0.95)
  scribeAnswers({
    add: [
      {
        text: 'Stale supervise-daemon processes block new starts; kill the stale daemon PID (not the npm child), then run rc-service zap.',
        category: 'gotcha',
        key: false,
        global: false,
        files: [],
        standing: false
      }
    ]
  })
  const r = await runScribe(p, turn('the service will not start'))
  assert.equal(r.updated, 1)
  assert.equal(r.added, 0)
  const before = getFact(memoryDb(), old.id)!
  assert.ok(before.forgottenAt, 'the old wording is retired (restorable)')
  assert.ok(before.replacedBy)
  assert.match(getFact(memoryDb(), before.replacedBy!)!.text, /kill the stale daemon PID/)

  // Alike, but dropping a detail of the old one: both stay, and the health check suggests a merge.
  scribeAnswers({
    add: [{ text: 'The supervise-daemon blocks restarts.', category: 'gotcha', key: false, global: false, files: [], standing: false }]
  })
  const r2 = await runScribe(p, turn('again'))
  assert.equal(r2.added, 1)
  assert.equal(listFacts(memoryDb(), p).filter((f) => /supervise-daemon/.test(f.text)).length, 2)
})

test('the health check finds what went wrong, suggests a fix, and applies only what is chosen', async () => {
  const p = 'health-check'
  const db = memoryDb()
  setMeta(db, `brief:${p}`, JSON.stringify({ text: BRIEF, updatedAt: new Date().toISOString(), basis: 'x' }))
  const a = rememberFact(db, p, 'Attachment ciphertext lives in .webnotes-attachments, mirrored by note path.', 'scribe', { category: 'about' }).fact
  const b = rememberFact(db, p, 'Attachments are stored as ciphertext in a hidden tree, moved with their note.', 'scribe', { category: 'about' }).fact
  const test1 = rememberFact(db, p, 'Procedure - Start it with test key: rm -rf data && CREDENTIALS_KEY=test-key node server.js', 'scribe', { category: 'setup', key: true }).fact
  const plan1 = rememberFact(db, p, 'Approved 2026-11-16: Encrypted notes (plan #43).', 'scribe', { category: 'decision' }).fact
  rememberFact(db, p, 'Approved 2026-11-17: Stay-unlocked notes (plan #49).', 'scribe', { category: 'decision' })
  // The same lesson in two projects.
  const g1 = rememberFact(db, 'health-other-1', 'On Alpine, npm is in the community repository: uncomment it in /etc/apk/repositories.', 'scribe', { category: 'gotcha' }).fact
  const g2 = rememberFact(db, 'health-other-2', 'Alpine apk add npm fails until the community line in repositories is uncommented.', 'scribe', { category: 'gotcha' }).fact

  const jobs: HelperJob[] = []
  setHelperJobForTests(async (job) => {
    jobs.push(job)
    const ids = [...job.prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1])
    return {
      text: '',
      by: 'haiku',
      structured: {
        drafts: ids.map((id) => ({
          id,
          text: id.startsWith('global') ? 'On Alpine, npm is in the community repository: uncomment it in /etc/apk/repositories, then apk update.' : 'Attachment ciphertext lives in a hidden .webnotes-attachments tree, mirrored by note path and moved with its note.'
        }))
      }
    }
  })
  const { project, global } = await checkMemoryHealth(p)
  const find = (kind: string, id: string) => [...project.issues, ...global.issues].find((i) => i.kind === kind && (i.facts ?? []).some((f) => f.id === id))
  const brief = project.issues.find((i) => i.kind === 'brief')
  assert.ok(brief, 'the brief')
  assert.ok(brief!.lines!.some((l) => l.line.includes('no preamble')))
  const dup = find('duplicate', a.id)
  assert.ok(dup && dup.facts!.some((f) => f.id === b.id), 'the pair')
  assert.match(dup!.proposed ?? '', /hidden \.webnotes-attachments tree/, 'drafted')
  assert.ok(!project.issues.some((i) => i.kind === 'duplicate' && i.facts!.some((f) => f.id === plan1.id)), 'two approved plans are two decisions')
  const proc = find('procedure', test1.id)
  assert.deepEqual(proc?.actions, ['unmark-key', 'forget'])
  const lesson = find('global', g1.id)
  assert.ok(lesson && lesson.facts!.some((f) => f.id === g2.id), 'the same lesson in two projects')
  assert.equal(jobs.length, 1, 'one background job drafts every wording')

  // Nothing has changed yet.
  assert.equal(getFact(db, b.id)!.forgottenAt, null)
  assert.equal(getFact(db, test1.id)!.key, true)

  applyHealthFix(p, brief!.id, 'rewrite-brief')
  assert.ok(!getBrief(p)!.text.includes('no preamble'))
  applyHealthFix(p, dup!.id, 'merge')
  const merged = [a, b].map((f) => getFact(db, f.id)!)
  assert.equal(merged.filter((f) => f.forgottenAt).length, 1, 'one is retired')
  assert.match(merged.find((f) => !f.forgottenAt)!.text, /hidden \.webnotes-attachments tree/)
  applyHealthFix(p, proc!.id, 'unmark-key')
  assert.equal(getFact(db, test1.id)!.key, false)
  applyHealthFix(GLOBAL_SCOPE, lesson!.id, 'make-global')
  assert.ok(getFact(db, g1.id)!.forgottenAt && getFact(db, g2.id)!.forgottenAt)
  assert.ok(listFacts(db, GLOBAL_SCOPE).some((f) => f.text.includes('then apk update')))
  assert.throws(() => applyHealthFix(p, proc!.id, 'forget'), /no longer there/)

  // Dismissed stays dismissed; a fact changed since the check drops its suggestion.
  const again = await checkMemoryHealth(p)
  const left = again.project.issues.find((i) => i.kind === 'procedure' && i.facts![0].id === test1.id)
  assert.ok(left, 'still a test step, though no longer key')
  dismissHealthIssue(p, left!.id)
  assert.ok(!(await checkMemoryHealth(p)).project.issues.some((i) => i.id === left!.id))
  const c = rememberFact(db, p, 'Keep quota warnings under 80% of storage.', 'scribe', { category: 'preference' }).fact
  const d = rememberFact(db, p, 'Warn about the storage quota before it reaches 80%.', 'scribe', { category: 'preference' }).fact
  const pair = (await checkMemoryHealth(p)).project.issues.find((i) => i.kind === 'duplicate' && i.facts!.some((f) => f.id === c.id))!
  updateFact(db, d.id, { text: 'Warn about the storage quota before it reaches 75%.' })
  assert.throws(() => applyHealthFix(p, pair.id, 'merge'), /changed since the check/)

  // The report counts what's waiting, and what was applied and dismissed.
  const lines = healthLines({ ...healthSummary(), handoffs: { codex: 23, cline: 0 } }, { claude: 27 })
  assert.ok(lines[0].startsWith('## Memory health'))
  assert.ok(lines.some((l) => l.startsWith('- Memory look-ups by the helpers: Codex 0 in 23 hand-offs')), lines.join('\n'))
  assert.ok(lines.some((l) => /Suggestions so far: 4 applied, 1 dismissed/.test(l)), lines.join('\n'))
})

test('a kind of problem in several projects is flagged as likely Starwright\'s own doing', () => {
  const lines = healthLines({
    projectsChecked: 8,
    byKind: { brief: { issues: 3, projects: ['WebNotes', 'AstraSSH', 'HV-Control'] }, duplicate: { issues: 2, projects: ['WebNotes'] } },
    stats: { applied: {}, dismissed: {} }
  })
  assert.ok(lines.some((l) => /brief .*: 3 projects \(WebNotes, AstraSSH, HV-Control\): in several projects, so likely Starwright's own doing/.test(l)), lines.join('\n'))
  assert.ok(lines.some((l) => /Facts saved twice in other words: 2 pairs \(WebNotes\)$/.test(l)), lines.join('\n'))
})
