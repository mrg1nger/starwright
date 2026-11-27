import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { detectSecrets } from '@shared/secretPatterns'
import { helpersAllowed, runHelperJob } from '../helpers/helperJob'
import { recentNotableCommands } from './commands'
import { memoryDb } from './paths'
import { getMeta, GLOBAL_SCOPE, listCodeFiles, listFacts, recentMessages, setMeta } from './store'
import { coverage, procedureName } from './wording'

// A short, structured "what a newcomer needs to know" document for each
// project, kept in the database and shown at the start of every new session.
// Facts are a list; this is the same knowledge arranged so someone can pick
// the project up from it. Rewritten rarely, from what's already saved.

export interface Brief {
  text: string
  updatedAt: string
}

interface StoredBrief extends Brief {
  /** Digest of what it was written from, so an unchanged project isn't rewritten. */
  basis: string
  /** Each fact it was written from (id → last change), to count how much has changed since. */
  facts?: Record<string, string>
  /** Digest of the rest (commands, scripts, notable files). */
  other?: string
}

export const MAX_WORDS = 500
/** Longer than this after asking for MAX_WORDS, it's cut back at a heading. */
const HARD_MAX_WORDS = 650
/**
 * Rewritten at most this often, and only once enough has changed: facts
 * change on almost every request, and rewriting on each (84 times in a week
 * on one project) cost far more than an up-to-the-minute brief is worth.
 */
const MIN_GAP_MS = 3 * 60 * 60_000
export const MIN_CHANGES = 3
const MIN_FACTS = 6

const key = (projectId: string): string => `brief:${projectId}`

/**
 * How the brief is to be written. Kept as a list so a brief that repeats them can be caught: a model
 * asked to quote "the user's standing rules" closely has been known to quote these instead.
 */
export const BRIEF_RULES = [
  `At most ${MAX_WORDS} words, plain text, no preamble. Use these headings, leaving out any you have no material for: WHAT IT IS; HOW IT'S BUILT; RUN, TEST, DEPLOY (what each routine is and the shape of its steps in one or two lines, for example "build an archive, copy it to the server over ssh, unpack, restart the service, check the site"; name the key tools, hosts and service names; do not copy whole command lines, because the exact steps are saved as facts starting "Procedure -" that can be looked up with recall); SERVICES AND ENVIRONMENTS; CONVENTIONS AND RULES; STATUS (what exists and what is in progress); PITFALLS.`,
  'CONVENTIONS AND RULES holds only the standing rules the USER gave, quoted closely: they are among the facts marked "preference". A decision, an approved plan or one of these instructions is not a rule of the user\'s. If the user gave none, leave the heading out.',
  'State only what the material supports. Never invent ports, hosts, paths, versions or commands. If something is unknown, leave it out.',
  'Never include secrets, keys, passwords or tokens. Refer to them by environment variable name only.',
  "If a previous brief is given, keep what is still true and update it; don't start over. Stay within the word limit even if the previous brief was longer: condense, merge and drop the least useful details first.",
  'These rules are for you: never repeat them in the brief.'
]

const isHeading = (line: string): boolean => /^[A-Z][A-Z ,&'/-]+:?$/.test(line.trim())

/** What a brief's lines can be checked against: rules the user gave, and the saved procedures. */
export interface BriefSupport {
  /** The user's preference facts (this project's and all projects') and their recent messages. */
  userSaid: string[]
  /** The procedure facts ("Procedure - …"). */
  procedures: string[]
}

export function briefSupport(projectId: string): BriefSupport {
  const db = memoryDb()
  const facts = [...listFacts(db, projectId), ...listFacts(db, GLOBAL_SCOPE)]
  let messages: string[] = []
  try {
    messages = recentMessages(db, projectId, 200)
      .filter((m) => m.role === 'user')
      .map((m) => m.text.slice(0, 3000))
  } catch {
    messages = []
  }
  return {
    userSaid: [...facts.filter((f) => f.category === 'preference').map((f) => f.text), ...messages],
    procedures: facts.filter((f) => procedureName(f.text) !== null).map((f) => f.text)
  }
}

/** A run of commands (cd … && node …; 2>&1; nohup), as opposed to a sentence that names a tool. */
const COMMAND_RUN = /&&|\|\||;\s|2>&1|\bnohup\b/

/**
 * Takes out of a brief what shouldn't be in it: lines repeating the rules above, lines under
 * CONVENTIONS AND RULES that aren't anything the user said, and whole command lines already saved as
 * a procedure (they become a pointer to it). Returns the brief and what was taken out, and why.
 */
export function cleanBrief(text: string, support: BriefSupport): { text: string; dropped: { line: string; why: string }[] } {
  const dropped: { line: string; why: string }[] = []
  const out: string[] = []
  let section = ''
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (isHeading(t)) {
      section = t.replace(/:$/, '').toUpperCase()
      out.push(line)
      continue
    }
    if (!t) {
      out.push(line)
      continue
    }
    const body = t.replace(/^[-•*]\s*/, '').replace(/^["“'](.*)["”']\.?$/, '$1')
    const userSaid = support.userSaid.some((s) => coverage(body, s) >= 0.7)
    if (!userSaid && body.split(/\s+/).length >= 4 && BRIEF_RULES.some((r) => coverage(body, r) >= 0.8)) {
      dropped.push({ line: t, why: "repeats Starwright's own instructions for writing the brief" })
      continue
    }
    if (section.startsWith('CONVENTIONS') && !userSaid) {
      dropped.push({ line: t, why: "isn't a rule you gave" })
      continue
    }
    const shortened = pointAtProcedure(line, support.procedures)
    if (shortened !== line) {
      dropped.push({ line: t, why: 'copies a whole command line that is saved as a procedure' })
      out.push(shortened)
      continue
    }
    out.push(line)
  }
  // A heading left with nothing under it goes too.
  const kept = out.filter((line, i) => {
    if (!isHeading(line)) return true
    for (let j = i + 1; j < out.length; j++) {
      if (isHeading(out[j])) return false
      if (out[j].trim()) return true
    }
    return false
  })
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), dropped }
}

/** "- Start it: cd x && node y. Handles z." → "- Start it: the exact commands are saved as a procedure. Handles z." when they are. */
function pointAtProcedure(line: string, procedures: string[]): string {
  const m = /^(\s*(?:[-•*]\s*)?[^:]{2,60}:\s+)(.*)$/.exec(line)
  if (!m || !procedures.length) return line
  const [, label, rest] = m
  // The command is the first sentence; what follows it (what the script does) stays.
  const split = /\.\s+(?=[A-Z])/.exec(rest)
  const command = split ? rest.slice(0, split.index) : rest
  const after = split ? rest.slice(split.index + 1).trim() : ''
  if (command.length < 40 || !COMMAND_RUN.test(command)) return line
  if (!procedures.some((p) => coverage(command, p) >= 0.6)) return line
  return `${label}the exact commands are saved as a procedure (look it up with recall).${after ? ` ${after}` : ''}`
}

function read(projectId: string): StoredBrief | undefined {
  try {
    const raw = getMeta(memoryDb(), key(projectId))
    return raw ? (JSON.parse(raw) as StoredBrief) : undefined
  } catch {
    return undefined
  }
}

/** Replaces the brief's text and nothing else (a fix the user chose); it's rewritten as usual later. */
export function setBriefText(projectId: string, text: string): Brief | undefined {
  const stored = read(projectId)
  if (!stored || !text.trim()) return undefined
  const saved: StoredBrief = { ...stored, text: text.trim(), updatedAt: new Date().toISOString() }
  setMeta(memoryDb(), key(projectId), JSON.stringify(saved))
  return { text: saved.text, updatedAt: saved.updatedAt }
}

export function getBrief(projectId: string): Brief | undefined {
  const stored = read(projectId)
  return stored ? { text: stored.text, updatedAt: stored.updatedAt } : undefined
}

/** The brief as a block for an agent's instructions, or undefined if there isn't one yet. */
export function briefBlock(projectId: string): string | undefined {
  const brief = getBrief(projectId)
  return brief?.text.trim() ? brief.text.trim() : undefined
}

function packageScripts(projectPath: string): string {
  try {
    const file = join(projectPath, 'package.json')
    if (!existsSync(file)) return ''
    const pkg = JSON.parse(readFileSync(file, 'utf-8')) as { name?: string; scripts?: Record<string, string> }
    return Object.entries(pkg.scripts ?? {})
      .slice(0, 15)
      .map(([name, cmd]) => `${name}: ${String(cmd).slice(0, 120)}`)
      .join('\n')
  } catch {
    return ''
  }
}

const NOTABLE_FILES = ['deploy.sh', 'Dockerfile', 'docker-compose.yml', 'Makefile', 'vercel.json', 'netlify.toml', 'fly.toml', 'Procfile', '.github/workflows']

function gather(
  projectId: string,
  projectPath: string
): { prompt: string; basis: string; factCount: number; facts: Record<string, string>; other: string } {
  const db = memoryDb()
  const facts = listFacts(db, projectId)
  const lines = facts
    .slice(0, 80)
    .map((f) => `- (${f.category}${f.key ? ', key' : ''}) ${f.text.slice(0, 600)}`)
    .join('\n')
  const files = listCodeFiles(db, projectId, 60)
    .map((f) => `${f.path}: ${f.summary}`)
    .join('\n')
  const commands = recentNotableCommands(projectId, 15).join('\n')
  const scripts = packageScripts(projectPath)
  const present = NOTABLE_FILES.filter((f) => existsSync(join(projectPath, f))).join(', ')
  const previous = read(projectId)?.text ?? ''

  const prompt = `You maintain the project brief for a software project: a short document that lets a capable newcomer (an AI assistant starting a fresh session with no memory of the work so far) pick the project up. Write it from the material below only.

Rules:
${BRIEF_RULES.map((r) => `- ${r}`).join('\n')}

Remembered facts:
${lines || '(none)'}

Source files (path: what it is):
${files || '(not mapped yet)'}

package.json scripts:
${scripts || '(none)'}

Notable files present: ${present || '(none)'}

Commands that were run recently:
${commands || '(none)'}

Previous brief:
${previous || '(none)'}`

  const basis = createHash('sha1')
    .update(JSON.stringify([facts.map((f) => [f.id, f.updatedAt, f.forgottenAt]), commands, scripts, present]))
    .digest('hex')
  const factMap = Object.fromEntries(facts.map((f) => [f.id, f.updatedAt]))
  const other = createHash('sha1').update(JSON.stringify([commands, scripts, present])).digest('hex')
  return { prompt, basis, factCount: facts.length, facts: factMap, other }
}

/** How many facts were added, changed or removed since the brief was written (plus one if the rest changed). */
export function changesSince(
  stored: { facts?: Record<string, string>; other?: string } | undefined,
  now: { facts: Record<string, string>; other: string }
): number {
  if (!stored?.facts) return Number.POSITIVE_INFINITY // written before this was tracked
  let changed = 0
  for (const [id, at] of Object.entries(now.facts)) if (stored.facts[id] !== at) changed++
  for (const id of Object.keys(stored.facts)) if (!(id in now.facts)) changed++
  if (stored.other !== now.other) changed++
  return changed
}

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length

/** Cuts an over-long brief back to whole sections within the hard limit (headings are lines in capitals). */
export function capBrief(text: string, maxWords = HARD_MAX_WORDS): string {
  if (wordCount(text) <= maxWords) return text
  // Whole sections (a heading and what follows it) while they fit; the first one is cut short if it alone is too long.
  const sections: string[][] = []
  for (const line of text.split('\n')) {
    if (/^[A-Z][A-Z ,&'/-]+:?$/.test(line.trim()) || !sections.length) sections.push([line])
    else sections[sections.length - 1].push(line)
  }
  const out: string[] = []
  let words = 0
  for (const section of sections) {
    const n = wordCount(section.join(' '))
    if (words + n <= maxWords) {
      out.push(...section)
      words += n
    } else if (!out.length) {
      out.push(`${section.join('\n').split(/\s+/).slice(0, maxWords).join(' ')}…`)
      break
    } else {
      break
    }
  }
  return out.join('\n').trim()
}

const running = new Set<string>()

/** Writes (or updates) the brief. Resolves to the new brief, or undefined when nothing needed doing. */
export async function refreshBrief(
  projectId: string,
  projectPath: string,
  options: { force?: boolean; minChanges?: number } = {}
): Promise<Brief | undefined> {
  if (running.has(projectId)) return undefined
  const { prompt, basis, factCount, facts, other } = gather(projectId, projectPath)
  const stored = read(projectId)
  if (!options.force) {
    if (stored?.basis === basis) return undefined
    // Too long (written before the limit was kept) counts as reason enough to rewrite it.
    const tooLong = !!stored && wordCount(stored.text) > HARD_MAX_WORDS
    if (stored && !tooLong && changesSince(stored, { facts, other }) < (options.minChanges ?? 1)) return undefined
  }
  if (factCount < 2 && !stored) return undefined // nothing to base one on yet
  running.add(projectId)
  try {
    const answer = await runHelperJob({ kind: 'brief', projectId, prompt })
    // What a model gets wrong in a brief is taken out before anyone is given it.
    const text = cleanBrief(capBrief(answer.text), briefSupport(projectId)).text
    if (!text) return undefined
    // A brief that picked up something secret-looking is dropped, not saved.
    if (detectSecrets(text).length) return undefined
    const saved: StoredBrief = { text, updatedAt: new Date().toISOString(), basis, facts, other }
    setMeta(memoryDb(), key(projectId), JSON.stringify(saved))
    return { text, updatedAt: saved.updatedAt }
  } finally {
    running.delete(projectId)
  }
}

const lastTry = new Map<string, number>()
const KEY_CHANGE_GAP_MS = 5 * 60_000

/** Whether a key fact is new or changed since the brief was written from these facts (id → last change). */
export function keyFactsChanged(projectId: string, writtenFrom: Record<string, string>): boolean {
  return listFacts(memoryDb(), projectId).some((f) => f.key && writtenFrom[f.id] !== f.updatedAt)
}

/** Refreshes in the background when it's worth it and Claude has room. Never throws. */
export function maybeRefreshBrief(projectId: string, projectPath: string): void {
  try {
    if (running.has(projectId)) return
    const existing = read(projectId)
    // A key fact changed since it was written (a correction, like a new port): every request is
    // given the brief, so it shouldn't say the old thing for hours. Still at most every few minutes.
    const keyChanged = !!existing?.facts && keyFactsChanged(projectId, existing.facts)
    const since = Date.now() - (lastTry.get(projectId) ?? 0)
    if (since < (keyChanged ? KEY_CHANGE_GAP_MS : MIN_GAP_MS)) return
    if (!existing && listFacts(memoryDb(), projectId).length < MIN_FACTS) return
    lastTry.set(projectId, Date.now())
    helpersAllowed()
      .then((allowed) => (allowed ? refreshBrief(projectId, projectPath, { minChanges: keyChanged ? 1 : MIN_CHANGES }) : undefined))
      .catch((err) => console.warn('Project brief refresh failed:', (err as Error).message))
  } catch (err) {
    console.warn('Project brief check failed:', (err as Error).message)
  }
}
