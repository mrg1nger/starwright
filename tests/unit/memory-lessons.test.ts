import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setHelperJobForTests, type HelperJob } from '../../src/main/helpers/helperJob'
import { helperTempDir, helperTempEnv } from '../../src/main/delegation/helperTemp'
import { verifyChanges } from '../../src/main/review/checks'
import { keyFactsChanged } from '../../src/main/memory/brief'
import { CLEANUP_RULE, HANDOFF_ENDING, NO_BROWSER_RULE } from '../../src/main/memory/context'
import { memoryDb } from '../../src/main/memory/paths'
import { hasLessons, runSavePass, runScribe, type TurnRecord } from '../../src/main/memory/scribe'
import { addMessage, finishHandoff, listFacts, rememberFact, startHandoff, updateFact } from '../../src/main/memory/store'
import { isThrowawayProcedure } from '../../src/main/memory/wording'

// 0.29.1, from a test build on a real install (2026-11-27): a helper's test emptied the whole temp
// folder; the local note-taker let that lesson, and the helpers' findings, go; a feature was saved
// as a "preference"; Claude's own check was saved as a procedure; the brief said the old port for an hour.

after(() => setHelperJobForTests(undefined))

test("work run for a project gets a private temp folder, and what's left there for a day is cleared", () => {
  const dir = helperTempDir('lessons-project')
  assert.ok(dir.startsWith(join(tmpdir(), 'starwright-helpers')), dir)
  assert.deepEqual(helperTempEnv('lessons-project'), { TEMP: dir, TMP: dir, TMPDIR: dir })
  const old = join(dir, 'old')
  const fresh = join(dir, 'fresh')
  mkdirSync(old, { recursive: true })
  writeFileSync(fresh, 'x')
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3_600_000)
  utimesSync(old, twoDaysAgo, twoDaysAgo)
  helperTempDir('lessons-project')
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(fresh), true)
  assert.match(helperTempDir('C:\\Projects\\My App'), /starwright-helpers[\\/][0-9a-f]{16}$/, 'a path becomes a safe name')
  assert.ok(HANDOFF_ENDING.startsWith(CLEANUP_RULE) && /only ever delete what they created themselves/.test(CLEANUP_RULE))
  assert.match(NO_BROWSER_RULE, /no browser tools.*don't install, download or script a browser.*left for Claude/s, 'the local model and Cline leave browser checks to Claude')
})

test("the project's tests run with that temp folder, so a clean-up that empties os.tmpdir() can't reach the real one", async () => {
  const project = mkdtempSync(join(tmpdir(), 'vibeapp-lessons-'))
  writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(require(\'os\').tmpdir()); process.exit(1)"' } }))
  writeFileSync(join(project, 'a.js'), 'module.exports = 1\n')
  const outcome = await verifyChanges(project, ['a.js'])
  assert.match(outcome.summary, /starwright-helpers/, outcome.summary)
})

test('a request has lessons when helpers found things out or the assistant reports a mistake or risk', () => {
  assert.equal(hasLessons({ replies: ['Done: added the button.'] }), false)
  assert.equal(hasLessons({ replies: ['**One thing you should know:** a test deleted the contents of your temp folder.'] }), true)
  assert.equal(hasLessons({ replies: ["That's a real problem: two backups in the same second overwrote each other."] }), true)
  assert.equal(hasLessons({ replies: ['Done.'], learned: ['Express 4 does not catch rejected promises.'] }), true)
})

test("Claude's own check with a temporary server is not a procedure; a real routine still is", () => {
  assert.equal(
    isThrowawayProcedure(`Procedure - ShelfLog build and verify: npm install; npm test; $env:DATA_FILE="$env:TEMP\\shelflog-review\\books.json"; $p = Start-Process node -ArgumentList 'server.js'; Stop-Process -Id $p.Id; Remove-Item -Recurse -Force "$env:TEMP\\shelflog-review"`),
    true
  )
  assert.equal(isThrowawayProcedure('Procedure - Build and deploy: npm run build && scp app.tgz box:/tmp/ && ssh box "tar xzf /tmp/app.tgz"'), false)
})

const turn = (request: string, replies: string[], extra: Partial<TurnRecord> = {}): TurnRecord => ({ request, replies, actions: [], stopped: false, hadError: false, ...extra })

function answers(structured: Record<string, unknown>, jobs: HelperJob[] = []): void {
  setHelperJobForTests(async (job) => {
    jobs.push(job)
    return { text: '', by: 'haiku', structured: { add: [], update: [], forget: [], relevant: [], told: [], ...structured } }
  })
}

test('a request with a mistake in it goes to a stronger note-taker, with room for the lesson, and is told it is worth a gotcha', async () => {
  const jobs: HelperJob[] = []
  answers(
    {
      add: [
        { text: 'Test clean-up must only delete its own fs.mkdtemp folder, never the temp folder itself.', category: 'gotcha', key: false, global: false, files: [], standing: false }
      ]
    },
    jobs
  )
  const r = await runScribe('lessons-incident', turn('Build it', ['**One thing you should know:** a test wiped your temp folder. Fixed it to use its own fs.mkdtemp folder.']))
  assert.equal(r.added, 1)
  assert.equal(jobs[0].strong, true)
  assert.match(jobs[0].prompt, /Always worth a "gotcha"/)
  assert.match(jobs[0].prompt, /save at most 5 facts/)

  answers({}, jobs)
  await runScribe('lessons-incident', turn('Add a button', ['Done.']))
  assert.equal(jobs[1].strong, false)
  assert.match(jobs[1].prompt, /save at most 3 facts/)
})

test('a feature the user asked for is saved as a decision, not a standing rule; "always" makes it one', async () => {
  const p = 'lessons-category'
  const asPreference = (text: string) => ({ add: [{ text, category: 'preference', key: false, global: false, files: [], standing: true }] })
  answers(asPreference('Writes need an x-api-key header when SHELFLOG_API_KEY is set.'))
  await runScribe(p, turn('Add optional write protection: if SHELFLOG_API_KEY is set, writes need an x-api-key header.', ['Done.']))
  answers(asPreference('Commit messages are written in English.'))
  await runScribe(p, turn('From now on, always write commit messages in English.', ['Will do.']))
  const facts = listFacts(memoryDb(), p)
  assert.equal(facts.find((f) => /x-api-key/.test(f.text))?.category, 'decision')
  assert.equal(facts.find((f) => /English/.test(f.text))?.category, 'preference')
})

test("the last look before a fresh session reads what the hand-offs said was worth knowing", async () => {
  const p = 'lessons-save-pass'
  addMessage(memoryDb(), p, 'user', 'Build the server.')
  addMessage(memoryDb(), p, 'assistant', 'Built it.')
  const id = startHandoff(memoryDb(), p, 'local', 'Write the server', null)
  finishHandoff(memoryDb(), id, { status: 'done', report: 'Done.\n\nWorth knowing next time:\n- Express 4 does not catch rejected promises in async routes: use try/catch and next(err).', files: [] })
  const jobs: HelperJob[] = []
  answers({}, jobs)
  await runSavePass(p)
  assert.match(jobs[0].prompt, /WHAT THE HELPERS FOUND OUT[\s\S]*Express 4 does not catch rejected promises/)
  assert.equal(jobs[0].strong, true)
})

test('a changed key fact makes the brief due for rewriting', () => {
  const p = 'lessons-brief'
  const rules = rememberFact(memoryDb(), p, 'The server listens on PORT, or 4321.', 'user', { category: 'preference', key: true }).fact
  const other = rememberFact(memoryDb(), p, 'Books are kept in data/books.json.', 'user', { category: 'about', key: false }).fact
  const writtenFrom = { [rules.id]: rules.updatedAt, [other.id]: other.updatedAt }
  assert.equal(keyFactsChanged(p, writtenFrom), false)
  updateFact(memoryDb(), other.id, { text: 'Books are kept in storage/books.json.' })
  assert.equal(keyFactsChanged(p, writtenFrom), false, 'only key facts count')
  updateFact(memoryDb(), rules.id, { text: 'The server listens on PORT, or 5050.' })
  assert.equal(keyFactsChanged(p, writtenFrom), true)
})

test("Cline's hand-in note never starts an answer, and a brief that has it is cleaned", async () => {
  const { finalAnswer, withoutHandInNote } = await import('../../src/main/cli/clineExec')
  const { cleanBrief } = await import('../../src/main/memory/brief')
  assert.equal(withoutHandInNote('Submission recorded (verified): WHAT IT IS\ntally'), 'WHAT IT IS\ntally')
  assert.equal(withoutHandInNote('Submission recorded. Done.'), 'Done.')
  assert.equal(withoutHandInNote('WHAT IT IS\nNo note here.'), 'WHAT IT IS\nNo note here.')
  assert.equal(finalAnswer('Submission recorded (verified): WHAT IT IS\ntally', undefined), 'WHAT IT IS\ntally')
  const { text, dropped } = cleanBrief('Submission recorded (verified): WHAT IT IS\ntally counts words.', { userSaid: [], procedures: [] })
  assert.equal(text, 'WHAT IT IS\ntally counts words.')
  assert.equal(dropped[0].why, "is Cline's note that it handed the answer in")
})
