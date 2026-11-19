import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { estimateReadTokens, fitsLocalContext, pathsIn } from '../../src/main/delegation/taskSize'

const result = (ok: boolean, changed: number, text: string, before = 'snap-before') => ({
  content: [{ type: 'text' as const, text }],
  isError: !ok,
  outcome: { ok, stopped: false, changed, before }
})

test('a hand-off that failed after changing files is undone, and the next agent starts clean with its report', async () => {
  const { tryInOrder } = await import('../../src/main/delegation/codexTool')
  const undone: string[] = []
  const tried: { route: string; note?: string }[] = []
  const done = await tryInOrder(
    ['local', 'codex'],
    async (route, _last, _carryOn, note) => {
      tried.push({ route, note })
      return route === 'local' ? result(false, 3, 'The local model kept reading the same files again.\nIt found the bug in routes.js line 40.', 'snap-1') : result(true, 2, 'Fixed it.', 'snap-2')
    },
    'simple bugfix',
    { undo: async (snapshot) => (undone.push(snapshot), true) }
  )
  assert.deepEqual(undone, ['snap-1'], 'back to the snapshot from before the failed hand-off')
  assert.deepEqual(tried.map((t) => t.route), ['local', 'codex'])
  assert.equal(tried[0].note, undefined)
  assert.match(tried[1].note ?? '', /the local model tried this task first and couldn't finish; its changes were undone/i)
  assert.match(tried[1].note ?? '', /found the bug in routes\.js line 40/, 'what it found is passed on')
  assert.equal(done.isError, false)
  assert.match(done.content[0].text, /to Codex after the local model couldn't finish \(The local model kept reading the same files again\.\) and its changes were undone/)
})

test('after a second go that also failed, the undo goes back to before the first; the last agent, or a failed undo, keeps the changes', async () => {
  const { tryInOrder } = await import('../../src/main/delegation/codexTool')
  const undone: string[] = []
  const calls: string[] = []
  await tryInOrder(
    ['cline', 'codex'],
    async (route, _l, carryOn) => {
      calls.push(`${route}${carryOn ? ' carry on' : ''}`)
      if (route === 'codex') return result(true, 1, 'Done.')
      return carryOn ? result(false, 5, 'Cline timed out after 10 minutes', 'snap-after-first-go') : result(false, 4, 'Cline timed out after 10 minutes', 'snap-original')
    },
    'moderate feature',
    { undo: async (snapshot) => (undone.push(snapshot), true) }
  )
  assert.deepEqual(calls, ['cline', 'cline carry on', 'codex'])
  assert.deepEqual(undone, ['snap-original'])

  // The last agent's half-done change stays for Claude to look at.
  undone.length = 0
  const last = await tryInOrder(['codex'], async () => result(false, 2, 'Codex failed.'), 'hard feature', { undo: async (s) => (undone.push(s), true) })
  assert.deepEqual(undone, [])
  assert.equal(last.isError, true)

  // Undo didn't work: stop there, as before, rather than build on top.
  calls.length = 0
  await tryInOrder(['local', 'codex'], async (route) => (calls.push(route), result(false, 2, 'Broke.')), 'simple feature', { undo: async () => false })
  assert.deepEqual(calls, ['local'])
})

test('the header says when the local model was skipped for a task too big for it', async () => {
  const { tryInOrder } = await import('../../src/main/delegation/codexTool')
  const done = await tryInOrder(['cline'], async () => result(true, 1, 'Wrote SUMMARY.md.'), 'simple docs', {
    skipped: ['skipping the local model (the files named come to about 70k tokens, more than half its 96,000 tokens of context)']
  })
  assert.match(done.content[0].text, /to Cline after skipping the local model \(the files named come to about 70k tokens/)
})

test("a task's size comes from the files and folders it names, inside the project only", () => {
  assert.deepEqual(pathsIn('Fix src/app.js and server\\routes.ts, see README.md (v1.2.3, https://example.com).'), ['src/app.js', 'server\\routes.ts', 'README.md'])
  const dir = mkdtempSync(join(tmpdir(), 'vibeapp-unit-size-'))
  try {
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'node_modules'))
    for (let i = 1; i <= 20; i++) writeFileSync(join(dir, 'src', `mod${i}.js`), 'x'.repeat(12_250))
    writeFileSync(join(dir, 'node_modules', 'big.js'), 'x'.repeat(1_000_000))
    writeFileSync(join(dir, 'a.js'), 'x'.repeat(3_500))

    assert.equal(estimateReadTokens(dir, 'Change a.js').tokens, 1_000)
    // The 20-file task on Lazarus: about 70k tokens, more than half a 96k context.
    const all = estimateReadTokens(dir, 'Summarise every file.', ['src'])
    assert.equal(all.tokens, 70_000)
    assert.deepEqual(all.counted, ['src'])
    assert.equal(fitsLocalContext(all.tokens, 96_000), false)
    assert.equal(fitsLocalContext(estimateReadTokens(dir, 'Change a.js').tokens, 32_768), true)
    // Counted once, dependency folders skipped, nothing outside the project.
    assert.equal(estimateReadTokens(dir, 'Look at src/mod1.js', ['src', 'src/mod2.js']).tokens, 70_000)
    assert.equal(estimateReadTokens(dir, 'x', ['.']).tokens, 71_000)
    assert.equal(estimateReadTokens(dir, 'x', ['../outside.js', 'missing.js']).tokens, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
