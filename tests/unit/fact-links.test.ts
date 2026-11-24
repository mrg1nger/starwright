import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import type { DatabaseSync } from 'node:sqlite'
import { factsForRequest, recallFacts, setEmbedderForTests, withPartners } from '../../src/main/memory/meaning'
import { prefetchBlock } from '../../src/main/memory/context'
import { noteFactsUsedTogether } from '../../src/main/memory/links'
import { memoryDb } from '../../src/main/memory/paths'
import {
  carryFactLinks,
  deleteFact,
  eraseProjectFromMemory,
  factsThatMattered,
  forgetFact,
  GLOBAL_SCOPE,
  getFact,
  linkFactFiles,
  linkPartners,
  linkStrength,
  LINK_HALF_LIFE_DAYS,
  LINK_HUB_FILE_FACTS,
  LINK_MAX_FACTS,
  listFacts,
  openMemory,
  rememberFact,
  strengthenLinks,
  withGoesWith
} from '../../src/main/memory/store'

// Facts that matter in the same requests are linked, and a fact found for a request brings its
// strongest partners along. Searched by keyword here (no language model), which is enough to
// find the first fact; the partner is worded nothing like the request on purpose.
setEmbedderForTests(null)

const DAY = 24 * 60 * 60 * 1000
const tempDb = (): DatabaseSync => openMemory(join(mkdtempSync(join(tmpdir(), 'vibeapp-links-')), 'memory.db'))
const save = (db: DatabaseSync, scope: string, text: string, key = false): string => rememberFact(db, scope, text, 'user', { category: 'setup', key }).fact.id
const linked = (db: DatabaseSync, id: string): string[] => linkPartners(db, [id], new Set(), 10).map((p) => p.id)

test('a pair counts once it has mattered together twice, and fades without use', () => {
  const db = tempDb()
  const a = save(db, 'p', 'Releases are published with npm run release.')
  const b = save(db, 'p', 'The build fails unless ELECTRON_RUN_AS_NODE is cleared first.')
  const now = Date.now()
  assert.equal(strengthenLinks(db, 'p', [a, b], new Date(now - 2 * DAY)), 1)
  assert.deepEqual(linked(db, a), [], 'once is chance')
  strengthenLinks(db, 'p', [b, a, a], new Date(now - DAY))
  assert.deepEqual(linked(db, a), [b], 'twice is a link')
  assert.deepEqual(linked(db, b), [a], 'both ways')
  // Two half-lives without counting again: a quarter of the weight, below the bar.
  assert.deepEqual(linkPartners(db, [a], new Set(), 10, now + 2 * LINK_HALF_LIFE_DAYS * DAY), [])
  assert.ok(Math.abs(linkStrength(2, new Date(now).toISOString(), now + LINK_HALF_LIFE_DAYS * DAY) - 1) < 1e-9)
  // Pairs left out: one fact alone, or so many facts that the request says nothing about which go together.
  assert.equal(strengthenLinks(db, 'p', [a]), 0)
  const many = Array.from({ length: LINK_MAX_FACTS + 1 }, (_, i) => save(db, 'p', `Fact number ${i} about something else entirely.`))
  assert.equal(strengthenLinks(db, 'p', many), 0)
})

test('a request where many facts mattered links each pair less', () => {
  const db = tempDb()
  const small = [save(db, 'p', 'One small thing.'), save(db, 'p', 'Another small thing.')]
  const big = Array.from({ length: 10 }, (_, i) => save(db, 'p', `Big request fact ${i}.`))
  for (let i = 0; i < 2; i++) {
    strengthenLinks(db, 'p', small)
    strengthenLinks(db, 'p', big)
  }
  assert.deepEqual(linked(db, small[0]), [small[1]], 'two requests with two facts: linked')
  assert.deepEqual(linked(db, big[0]), [], 'two requests with ten facts: not yet')
  for (let i = 0; i < 3; i++) strengthenLinks(db, 'p', big)
  assert.equal(linked(db, big[0]).length, 9, 'five requests with ten facts: linked')
})

test('what mattered: facts written during the request and facts about the files it changed, but not a file many facts are about', async () => {
  const db = tempDb()
  const before = save(db, 'p', 'An old fact nobody touched.')
  const aboutShop = save(db, 'p', 'Shop prices live in shop.js.')
  const otherProject = save(db, 'q', 'Shop prices in the other project.')
  linkFactFiles(db, aboutShop, [{ path: 'shop.js', lines: 10 }])
  linkFactFiles(db, otherProject, [{ path: 'shop.js', lines: 10 }])
  const hub = Array.from({ length: LINK_HUB_FILE_FACTS + 1 }, (_, i) => save(db, 'p', `Store fact ${i}.`))
  for (const id of hub) linkFactFiles(db, id, [{ path: 'store.ts', lines: 2000 }])
  await new Promise((resolve) => setTimeout(resolve, 5))
  const since = new Date().toISOString()
  const written = save(db, 'p', 'Potions now cost 30 gold.')
  const global = save(db, GLOBAL_SCOPE, 'The user likes short answers.')
  const gone = save(db, 'p', 'Something said and then forgotten.')
  forgetFact(db, gone, 'test')
  const found = factsThatMattered(db, 'p', since, ['shop.js', 'store.ts', 'shop.js'])
  assert.deepEqual(found.sort(), [aboutShop, written].sort())
  assert.ok(!found.includes(before) && !found.includes(otherProject) && !found.includes(global))
})

test('a corrected or merged fact keeps its links', () => {
  const db = tempDb()
  const a = save(db, 'p', 'Deploys go to the VPS over SSH.')
  const b = save(db, 'p', 'The VPS needs the firewall port opened first.')
  const c = save(db, 'p', 'Deploy fact said again.')
  strengthenLinks(db, 'p', [a, b])
  strengthenLinks(db, 'p', [a, b])
  carryFactLinks(db, a, c)
  assert.deepEqual(linked(db, c), [b])
  // Merged into a fact that already had a weaker link: they add up.
  const d = save(db, 'p', 'Another way of saying it.')
  strengthenLinks(db, 'p', [d, b])
  carryFactLinks(db, c, d)
  const partner = linkPartners(db, [d], new Set(), 10)
  assert.equal(partner[0].id, b)
  assert.ok(partner[0].strength > 2.9, String(partner[0].strength))
  // A fact deleted for good takes its links with it.
  deleteFact(db, b)
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM fact_links WHERE a = ? OR b = ?').get(b, b) as { n: number }).n), 0)
})

test("a fact found for a request brings its partner along, saying which it came with; never a key, forgotten or other project's fact", async () => {
  const db = memoryDb()
  const project = `links-${Date.now()}`
  const release = save(db, project, 'Releases are published with the release script after the version is bumped.')
  const gotcha = save(db, project, 'The build fails unless ELECTRON_RUN_AS_NODE is cleared first.')
  const keyFact = save(db, project, 'The app is an Electron desktop program.', true)
  const forgotten = save(db, project, 'An old signing step that no longer applies.')
  for (let i = 0; i < 2; i++) strengthenLinks(db, project, [release, gotcha, keyFact, forgotten])
  forgetFact(db, forgotten, 'test')

  const facts = await factsForRequest(db, project, 'how do we publish a release?')
  assert.deepEqual(
    facts.map((f) => [f.id, f.cameWith]),
    [
      [release, undefined],
      [gotcha, release]
    ]
  )
  assert.equal(getFact(db, gotcha)!.useCount, 1, 'brought along counts as looked up')

  const block = await prefetchBlock(project, 'how do we publish a release?')
  assert.match(block ?? '', new RegExp(`ELECTRON_RUN_AS_NODE is cleared first\\. \\(id ${gotcha}\\) \\(brought along: often needed with ${release}\\)`))

  // An agent's own search gets it too.
  const recalled = await recallFacts(db, project, 'release script')
  assert.deepEqual(recalled.map((f) => f.id), [release, gotcha])

  // Another project's search never gets this project's facts, linked or not.
  assert.deepEqual(withPartners(db, `${project}-other`, [getFact(db, release)!], 3).map((f) => f.id), [release])

  // A request about nothing remembered brings nothing.
  assert.deepEqual(await factsForRequest(db, project, 'yes please'), [])
  eraseProjectFromMemory(db, project)
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM fact_links WHERE project_id = ?').get(project) as { n: number }).n), 0)
})

test('the end of a request links what mattered in it, and the Memory screen shows it', async () => {
  const db = memoryDb()
  const project = `links-end-${Date.now()}`
  const aboutShop = save(db, project, 'Shop prices live in shop.js.')
  linkFactFiles(db, aboutShop, [{ path: 'shop.js', lines: 10 }])
  let written = ''
  for (let i = 0; i < 2; i++) {
    const since = new Date(Date.now() - 1).toISOString()
    written ||= save(db, project, 'Prices are rounded to whole gold.')
    if (i) db.prepare('UPDATE facts SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), written)
    assert.equal(noteFactsUsedTogether(project, since, ['shop.js']), 1)
  }
  assert.equal(noteFactsUsedTogether(project, undefined, ['shop.js']), 0, "a request whose start isn't known links nothing")
  const shown = withGoesWith(db, listFacts(db, project))
  assert.deepEqual(shown.find((f) => f.id === aboutShop)?.goesWith, [written])
  assert.deepEqual(shown.find((f) => f.id === written)?.goesWith, [aboutShop])
  eraseProjectFromMemory(db, project)
})
