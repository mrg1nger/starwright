import { createHash } from 'crypto'
import type { MemoryFact, MemoryHealth, MemoryHealthAction, MemoryHealthIssue, MemoryHealthKind } from '@shared/types'
import { detectSecrets } from '@shared/secretPatterns'
import { helpersAllowed, runHelperJob, type JsonSchema } from '../helpers/helperJob'
import { listProjects } from '../projects/store'
import { briefSupport, cleanBrief, getBrief, setBriefText } from './brief'
import { allFactVectors } from './meaning'
import { memoryDb } from './paths'
import {
  carryFactFiles,
  carryFactLinks,
  forgetFact,
  getFact,
  getMeta,
  GLOBAL_SCOPE,
  listFacts,
  rememberFact,
  setMeta,
  updateFact,
  vectorSimilarity,
  type ScopedVector
} from './store'
import { isThrowawayProcedure, procedureName, procedureRisk } from './wording'

// Memory's health check: the review of what's saved that a person would do now and then, done by
// Starwright. It finds the brief repeating its own instructions, facts saved twice in other words,
// test steps saved as procedures, and the same lesson learned in several projects, and suggests a
// fix for each. Nothing changes until the user picks one (Memory screen → Health). Finding is done
// without a model; a background job only drafts the wording of a merge or of a fact for all projects.

/**
 * Facts this alike (by meaning) are suggested as one. Measured on real memory: other wordings of
 * one fact scored 0.948-0.953 and the same fact saved twice 0.986-0.988; related but different
 * facts reached 0.932. (From 0.97, with the details kept, the note-taker replaces them itself.)
 */
export const SUGGEST_SAME = 0.94
const CHECK_EVERY_MS = 24 * 60 * 60_000
/** At most this many suggestions of one kind in one memory: the rest wait for the next check. */
const MAX_PER_KIND = 8
const DISMISSED_KEPT = 500

const healthKey = (scope: string): string => `health:${scope}`
const DISMISSED = 'health_dismissed'
const DRAFTS = 'health_drafts'
const STATS = 'health_stats'

interface Stats {
  applied: Partial<Record<MemoryHealthKind, number>>
  dismissed: Partial<Record<MemoryHealthKind, number>>
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = getMeta(memoryDb(), key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

const writeJson = (key: string, value: unknown): void => setMeta(memoryDb(), key, JSON.stringify(value))

export function storedHealth(scope: string): MemoryHealth {
  const h = readJson<MemoryHealth>(healthKey(scope), { checkedAt: null, issues: [] })
  return { checkedAt: h.checkedAt ?? null, issues: Array.isArray(h.issues) ? h.issues : [] }
}

function dismissed(): Set<string> {
  return new Set(readJson<string[]>(DISMISSED, []))
}

const digest = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 12)
const pairId = (kind: MemoryHealthKind, ids: string[]): string => `${kind}:${[...ids].sort().join('+')}`
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const factOf = (f: MemoryFact, project?: string): NonNullable<MemoryHealthIssue['facts']>[number] => ({
  id: f.id,
  text: f.text,
  key: f.key,
  ...(project ? { project } : {})
})

/** Two approved-plan facts (or two dated decisions) are different decisions, however alike they read. */
function differentDecisions(a: string, b: string): boolean {
  const plan = (t: string): string | undefined => /plan #(\d+)/i.exec(t)?.[1]
  const date = (t: string): string | undefined => /\b(20\d\d-\d\d-\d\d)\b/.exec(t)?.[1]
  return (!!plan(a) && !!plan(b) && plan(a) !== plan(b)) || (!!date(a) && !!date(b) && date(a) !== date(b))
}

// ---- finding --------------------------------------------------------------------------------

function briefIssue(projectId: string): MemoryHealthIssue | undefined {
  const brief = getBrief(projectId)
  if (!brief?.text.trim()) return undefined
  const { text, dropped } = cleanBrief(brief.text, briefSupport(projectId))
  if (!dropped.length || !text) return undefined
  const echoes = dropped.filter((d) => d.why.startsWith('repeats')).length
  const notRules = dropped.filter((d) => d.why.startsWith("isn't")).length
  const commands = dropped.length - echoes - notRules
  const parts = [
    echoes ? `${echoes} line${echoes === 1 ? '' : 's'} repeating Starwright's own instructions for writing it` : '',
    notRules ? `${notRules} "rule${notRules === 1 ? '' : 's'}" you never gave` : '',
    commands ? `${commands} whole command line${commands === 1 ? '' : 's'} already saved as a procedure` : ''
  ].filter(Boolean)
  return {
    id: `brief:${projectId}:${digest(dropped.map((d) => d.line).join('\n'))}`,
    kind: 'brief',
    scope: projectId,
    title: echoes ? "The project brief repeats Starwright's own instructions" : 'The project brief has lines that don\'t belong in it',
    detail: `Every agent is given the brief with every request. It has ${parts.join(', ')}.`,
    lines: dropped,
    proposed: text,
    actions: ['rewrite-brief']
  }
}

/** Which of two facts to keep when they're merged: a key one, then the more used, then the older. */
function keeperFirst(a: MemoryFact, b: MemoryFact): [MemoryFact, MemoryFact] {
  if (a.key !== b.key) return a.key ? [a, b] : [b, a]
  if (a.useCount !== b.useCount) return a.useCount > b.useCount ? [a, b] : [b, a]
  return a.createdAt <= b.createdAt ? [a, b] : [b, a]
}

function duplicateIssues(projectId: string, vectors: ScopedVector[]): MemoryHealthIssue[] {
  const mine = vectors.filter((v) => v.scope === projectId)
  const pairs: { a: ScopedVector; b: ScopedVector; similarity: number }[] = []
  for (let i = 0; i < mine.length; i++) {
    for (let j = i + 1; j < mine.length; j++) {
      const similarity = vectorSimilarity(mine[i].v, mine[j].v)
      if (similarity >= SUGGEST_SAME && !differentDecisions(mine[i].fact.text, mine[j].fact.text)) pairs.push({ a: mine[i], b: mine[j], similarity })
    }
  }
  const used = new Set<string>()
  const issues: MemoryHealthIssue[] = []
  for (const p of pairs.sort((x, y) => y.similarity - x.similarity)) {
    if (used.has(p.a.fact.id) || used.has(p.b.fact.id)) continue
    used.add(p.a.fact.id).add(p.b.fact.id)
    const [keep, other] = keeperFirst(p.a.fact, p.b.fact)
    issues.push({
      id: pairId('duplicate', [keep.id, other.id]),
      kind: 'duplicate',
      scope: projectId,
      title: 'Two facts say the same thing',
      detail: `They mean almost the same (${Math.round(p.similarity * 100)}% alike), so agents are given both, and correcting one leaves the other wrong. Merged, one fact keeps the details of both.`,
      facts: [factOf(keep), factOf(other)],
      actions: ['merge']
    })
    if (issues.length >= MAX_PER_KIND) break
  }
  return issues
}

function procedureIssues(projectId: string): MemoryHealthIssue[] {
  const issues: MemoryHealthIssue[] = []
  for (const f of listFacts(memoryDb(), projectId)) {
    const risk = procedureRisk(f.text)
    if (!risk) continue
    if (isThrowawayProcedure(f.text)) {
      issues.push({
        id: pairId('procedure', [f.id]),
        kind: 'procedure',
        scope: projectId,
        title: `A step for trying something out, saved as a procedure${f.key ? ' and a key fact' : ''}`,
        detail: `"${clip(procedureName(f.text) || 'This procedure', 80)}" ${risk.testOnly ? 'uses a test key' : risk.deletes ? 'deletes things' : 'was for trying something out'}, and isn't how the project is run.${f.key ? ' As a key fact, every agent is given it with every request.' : ''}`,
        facts: [factOf(f)],
        actions: f.key ? ['unmark-key', 'forget'] : ['forget']
      })
    } else if (risk.deletes && f.key) {
      issues.push({
        id: pairId('procedure', [f.id]),
        kind: 'procedure',
        scope: projectId,
        title: 'A procedure that deletes things is a key fact',
        detail: 'Key facts are given to every agent with every request. A procedure is better found when a request needs it, above all one that deletes files.',
        facts: [factOf(f)],
        actions: ['unmark-key']
      })
    }
    if (issues.length >= MAX_PER_KIND) break
  }
  return issues
}

/** Lessons (pitfalls, setup, the user's ways) saved alike in two or more projects. */
function globalIssues(vectors: ScopedVector[], names: Map<string, string>): MemoryHealthIssue[] {
  const lessons = vectors.filter(
    (v) => v.scope !== GLOBAL_SCOPE && ['gotcha', 'setup', 'preference'].includes(v.fact.category) && procedureName(v.fact.text) === null
  )
  const globals = vectors.filter((v) => v.scope === GLOBAL_SCOPE)
  // Groups of alike facts from different projects (each fact joins the group of anything it's alike to).
  const group = new Map<string, number>()
  const members: ScopedVector[][] = []
  for (let i = 0; i < lessons.length; i++) {
    for (let j = i + 1; j < lessons.length; j++) {
      const [a, b] = [lessons[i], lessons[j]]
      if (a.scope === b.scope || vectorSimilarity(a.v, b.v) < SUGGEST_SAME) continue
      const ga = group.get(a.fact.id)
      const gb = group.get(b.fact.id)
      if (ga === undefined && gb === undefined) {
        group.set(a.fact.id, members.length).set(b.fact.id, members.length)
        members.push([a, b])
      } else if (ga !== undefined && gb === undefined) {
        group.set(b.fact.id, ga)
        members[ga].push(b)
      } else if (gb !== undefined && ga === undefined) {
        group.set(a.fact.id, gb)
        members[gb].push(a)
      } else if (ga !== gb) {
        for (const m of members[gb!]) group.set(m.fact.id, ga!)
        members[ga!].push(...members[gb!])
        members[gb!] = []
      }
    }
  }
  const issues: MemoryHealthIssue[] = []
  for (const g of members) {
    const projects = new Set(g.map((m) => m.scope))
    if (projects.size < 2) continue
    // Already one fact for all projects: nothing to suggest.
    if (globals.some((gl) => g.some((m) => vectorSimilarity(gl.v, m.v) >= SUGGEST_SAME))) continue
    const names_ = [...projects].map((p) => names.get(p) ?? p)
    issues.push({
      id: pairId('global', g.map((m) => m.fact.id)),
      kind: 'global',
      scope: GLOBAL_SCOPE,
      title: `The same lesson is saved in ${projects.size} projects`,
      detail: `${names_.join(', ')} each learned it separately. Kept once in the memory for all projects, every project gets it, including the next one.`,
      facts: g.map((m) => factOf(m.fact, names.get(m.scope) ?? m.scope)),
      actions: ['make-global']
    })
    if (issues.length >= MAX_PER_KIND) break
  }
  return issues
}

// ---- drafting the wording -------------------------------------------------------------------

const DRAFT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    drafts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'text'],
        additionalProperties: false
      }
    }
  },
  required: ['drafts'],
  additionalProperties: false
}

/** Every number in the draft (a port, a version) must be in what it was written from. */
function honest(draft: string, sources: string[]): boolean {
  const all = sources.join('\n')
  return (draft.match(/\b\d{2,}(?:\.\d+)*\b/g) ?? []).every((n) => all.includes(n))
}

/** The wording a merge or a fact for all projects would save: drafted by a background job, kept between checks. */
async function draftWordings(issues: MemoryHealthIssue[]): Promise<void> {
  const drafts = readJson<Record<string, string>>(DRAFTS, {})
  const needed = issues.filter((i) => (i.kind === 'duplicate' || i.kind === 'global') && i.facts?.length && !drafts[i.id])
  if (needed.length && (await helpersAllowed().catch(() => false))) {
    const items = needed.slice(0, 12).map((i) => ({
      id: i.id,
      task: i.kind === 'duplicate' ? 'merge' : 'for all projects',
      facts: i.facts!.map((f) => f.text)
    }))
    const prompt = `Facts an AI coding assistant remembered need rewording. For each item, write ONE fact:
- "merge": the facts say the same thing; write one fact that keeps every useful detail of all of them, and nothing they don't say.
- "for all projects": several projects learned the same lesson; write it once so it applies to any project: leave out the project's own name, paths and service names, keep the lesson and what to do.
One or two sentences (a procedure keeps its steps). Never add details that aren't in the facts. Never include a secret's value. Answer with the item's id and the text.

Items:
${items.map((i) => JSON.stringify(i)).join('\n')}`
    try {
      const answer = await runHelperJob({ kind: 'tidy', prompt, schema: DRAFT_SCHEMA })
      const got = (answer.structured as { drafts?: { id: string; text: string }[] } | undefined)?.drafts ?? []
      for (const d of got) {
        const issue = needed.find((i) => i.id === d.id)
        const text = typeof d.text === 'string' ? d.text.trim().slice(0, 1000) : ''
        if (issue && text && !detectSecrets(text).length && honest(text, issue.facts!.map((f) => f.text))) drafts[issue.id] = text
      }
      writeJson(DRAFTS, Object.fromEntries(Object.entries(drafts).slice(-200)))
    } catch (err) {
      console.warn('Drafting memory fixes failed:', (err as Error).message)
    }
  }
  // Without a draft, the fullest wording there is (so the fix never loses a detail it could keep).
  for (const i of issues) {
    if (i.kind !== 'duplicate' && i.kind !== 'global') continue
    i.proposed = drafts[i.id] ?? [...(i.facts ?? [])].sort((a, b) => b.text.length - a.text.length)[0]?.text
  }
}

// ---- checking -------------------------------------------------------------------------------

const running = new Set<string>()

function store(scope: string, issues: MemoryHealthIssue[]): MemoryHealth {
  const skip = dismissed()
  const health: MemoryHealth = { checkedAt: new Date().toISOString(), issues: issues.filter((i) => !skip.has(i.id)) }
  writeJson(healthKey(scope), health)
  return health
}

/** Checks one project's memory, and the memory for all projects. Returns both. */
export async function checkMemoryHealth(projectId: string): Promise<{ project: MemoryHealth; global: MemoryHealth }> {
  if (running.has(projectId)) return { project: storedHealth(projectId), global: storedHealth(GLOBAL_SCOPE) }
  running.add(projectId)
  try {
    const db = memoryDb()
    const names = new Map(listProjects().map((p) => [p.id, p.name]))
    const all = await allFactVectors(db, null).catch(() => null)
    const vectors = all?.vectors ?? []
    const skip = dismissed()
    const project = [...(briefIssue(projectId) ? [briefIssue(projectId)!] : []), ...duplicateIssues(projectId, vectors), ...procedureIssues(projectId)]
    const global = globalIssues(vectors, names)
    await draftWordings([...project, ...global].filter((i) => !skip.has(i.id)))
    return { project: store(projectId, project), global: store(GLOBAL_SCOPE, global) }
  } finally {
    running.delete(projectId)
  }
}

/** The stored check for a project, and the suggestions for all projects (those involving this one first). */
export function memoryHealth(projectId: string): { project: MemoryHealth; global: MemoryHealth } {
  return { project: storedHealth(projectId), global: storedHealth(GLOBAL_SCOPE) }
}

/** Checks in the background when the last check is a day old. Never throws. */
export function maybeCheckHealth(projectId: string): void {
  try {
    const last = storedHealth(projectId).checkedAt
    if (last && Date.now() - Date.parse(last) < CHECK_EVERY_MS) return
    checkMemoryHealth(projectId).catch((err) => console.warn('Memory health check failed:', (err as Error).message))
  } catch (err) {
    console.warn('Memory health check failed:', (err as Error).message)
  }
}

function bump(kind: MemoryHealthKind, how: keyof Stats): void {
  const stats = readJson<Stats>(STATS, { applied: {}, dismissed: {} })
  stats[how] = { ...stats[how], [kind]: (stats[how]?.[kind] ?? 0) + 1 }
  writeJson(STATS, stats)
}

export function healthStats(): Stats {
  return readJson<Stats>(STATS, { applied: {}, dismissed: {} })
}

function take(scope: string, issueId: string): MemoryHealthIssue | undefined {
  const health = storedHealth(scope)
  const issue = health.issues.find((i) => i.id === issueId)
  if (issue) writeJson(healthKey(scope), { ...health, issues: health.issues.filter((i) => i.id !== issueId) })
  return issue
}

/** Hides a suggestion for good. */
export function dismissHealthIssue(scope: string, issueId: string): boolean {
  const issue = take(scope, issueId)
  if (!issue) return false
  writeJson(DISMISSED, [...dismissed(), issueId].slice(-DISMISSED_KEPT))
  bump(issue.kind, 'dismissed')
  return true
}

/** Does what the suggestion says. Throws when it no longer applies (a fact was changed or removed since). */
export function applyHealthFix(scope: string, issueId: string, action: MemoryHealthAction): string {
  const issue = storedHealth(scope).issues.find((i) => i.id === issueId)
  if (!issue) throw new Error('That suggestion is no longer there. Check again for new ones.')
  if (!issue.actions.includes(action)) throw new Error("That isn't one of the fixes suggested for this.")
  const db = memoryDb()
  const live = (issue.facts ?? []).map((f) => getFact(db, f.id))
  if (issue.kind !== 'brief' && live.some((f, i) => !f || f.forgottenAt || f.text !== issue.facts![i].text)) {
    take(scope, issueId)
    throw new Error('One of these facts has changed since the check, so the suggestion was dropped. Check again.')
  }
  const facts = live as MemoryFact[]
  let done: string
  switch (action) {
    case 'rewrite-brief': {
      if (!issue.proposed || !setBriefText(issue.scope, issue.proposed)) throw new Error("There's no brief to rewrite.")
      done = 'The brief was rewritten without those lines.'
      break
    }
    case 'merge': {
      const [keep, ...others] = facts
      updateFact(db, keep.id, { text: issue.proposed ?? keep.text, key: facts.some((f) => f.key) })
      for (const other of others) {
        forgetFact(db, other.id, `merged into ${keep.id} (health check)`, keep.id)
        carryFactFiles(db, other.id, keep.id)
        carryFactLinks(db, other.id, keep.id)
      }
      done = 'Merged into one fact. The other is under "Show forgotten".'
      break
    }
    case 'unmark-key': {
      for (const f of facts) updateFact(db, f.id, { key: false })
      done = "It's no longer a key fact: agents find it when a request needs it."
      break
    }
    case 'forget': {
      for (const f of facts) forgetFact(db, f.id, "health check: a step for trying something out, not how the project is run")
      done = 'Forgotten. It can be restored from "Show forgotten".'
      break
    }
    case 'make-global': {
      const saved = rememberFact(db, GLOBAL_SCOPE, issue.proposed ?? facts[0].text, 'tidy', { category: facts[0].category, key: false }).fact
      for (const f of facts) forgetFact(db, f.id, 'moved to the memory for all projects (health check)', saved.id)
      done = `Saved once for all projects; the ${facts.length} project copies are under "Show forgotten" in each.`
      break
    }
    default:
      throw new Error('Unknown fix.')
  }
  take(scope, issueId)
  bump(issue.kind, 'applied')
  return done
}

/** For the usage report: what the last checks found, across every project checked. */
export interface HealthSummary {
  projectsChecked: number
  byKind: Partial<Record<MemoryHealthKind, { issues: number; projects: string[] }>>
  stats: Stats
}

export function healthSummary(projectId?: string): HealthSummary {
  const names = new Map(listProjects().map((p) => [p.id, p.name]))
  const scopes = projectId ? [projectId, GLOBAL_SCOPE] : [...names.keys(), GLOBAL_SCOPE]
  const byKind: HealthSummary['byKind'] = {}
  let checked = 0
  for (const scope of scopes) {
    const h = storedHealth(scope)
    if (h.checkedAt && scope !== GLOBAL_SCOPE) checked++
    for (const i of h.issues) {
      const k = (byKind[i.kind] ??= { issues: 0, projects: [] })
      k.issues++
      const where = i.kind === 'global' ? (i.facts ?? []).map((f) => f.project ?? '') : [names.get(i.scope) ?? i.scope]
      for (const w of where) if (w && !k.projects.includes(w)) k.projects.push(w)
    }
  }
  return { projectsChecked: checked, byKind, stats: healthStats() }
}
