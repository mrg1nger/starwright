import { loadTranscript } from '../projects/transcript'
import { memoryDb } from './paths'
import {
  addMessage,
  outdatedNotes,
  outdatedSuffix,
  countMessages,
  getMeta,
  noteFactUses,
  recentHandoffs,
  setMeta,
  transaction,
  type Handoff
} from './store'
import { factsForRequest, filesForRequest, type AttachedFact } from './meaning'

// What agents are shown without having to ask: facts and files that look
// relevant to the request (found by a local search by meaning, so it costs no
// tokens), the user's own words, and what earlier hand-offs did.

/**
 * Asked at the end of every hand-off, so what a helper found out on the way (a pitfall, how
 * something has to be run) can be remembered: the note-taker only sees Claude's side otherwise.
 */
export const LEARNED_HEADING = 'Worth knowing next time:'
export const LEARNED_ASK = `When you are done, end your final message with a line "${LEARNED_HEADING}" followed by at most 3 short bullet points: things about this project you found out while working that are not obvious from the code and that the next agent would need (a pitfall you hit, a command that has to be run a certain way, where something is set up). Not what you did, and never a secret's value. If there is nothing, write "${LEARNED_HEADING} nothing".`

/** Said in every hand-off: a test's clean-up once emptied the whole temp folder (2026-11-27). */
export const CLEANUP_RULE =
  'Tests and scripts you write must only ever delete what they created themselves (for example a folder made with fs.mkdtemp, removed afterwards), never the temp folder itself, anything else in it, or anything outside the project.'

/** The end of every hand-off's instructions. */
export const HANDOFF_ENDING = `${CLEANUP_RULE}\n\n${LEARNED_ASK}`

/** What a hand-off's report says under "Worth knowing next time:" (at most 3 points), or [] for nothing. */
export function learnedFrom(report: string | null | undefined): string[] {
  if (!report) return []
  const at = report.toLowerCase().lastIndexOf(LEARNED_HEADING.toLowerCase().replace(/:$/, ''))
  if (at < 0) return []
  const rest = report.slice(at).replace(/^[^:\n]*:?/, '')
  // The points run to the first blank line after them (the saved report has the checks after it).
  const points: string[] = []
  for (const raw of rest.split(/\n/)) {
    const l = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim()
    if (!l) {
      if (points.length) break
      continue
    }
    if (/^(nothing|none|n\/a)\b\.?$/i.test(l) || l.startsWith('[')) break
    points.push(l.length > 300 ? `${l.slice(0, 299)}…` : l)
    if (points.length === 3) break
  }
  return points
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Remembered facts and files that look related to `text`, or undefined if nothing does. The facts are
 * noted as given to `agent` (see fact_uses). Never throws.
 */
export async function prefetchBlock(projectId: string, text: string, agent: string): Promise<string | undefined> {
  try {
    const db = memoryDb()
    const facts = await factsForRequest(db, projectId, text, 5)
    const files = await filesForRequest(db, projectId, text, 5)
    noteFactUses(db, projectId, facts.filter((f) => !f.cameWith).map((f) => f.id), 'pushed', agent)
    noteFactUses(db, projectId, facts.filter((f) => f.cameWith).map((f) => f.id), 'brought', agent)
    if (!facts.length && !files.length) return undefined
    const parts: string[] = []
    if (facts.length) {
      const outdated = outdatedNotes(db, facts.map((f) => f.id))
      const cameWith = (f: AttachedFact): string => (f.cameWith ? ` (brought along: often needed with ${f.cameWith})` : '')
      parts.push(`Remembered facts:\n${facts.map((f) => `- [${f.category}] ${f.text} (id ${f.id})${cameWith(f)}${outdatedSuffix(outdated.get(f.id))}`).join('\n')}`)
    }
    if (files.length) {
      parts.push(`Files that may be involved:\n${files.map((f) => `- ${f.path}: ${f.summary}`).join('\n')}`)
    }
    return `[VibeApp note: these look relevant to this request. They come from a search, so treat them as hints and verify before relying on them.\n${parts.join('\n')}]`
  } catch (err) {
    console.warn('Pre-fetching context failed:', (err as Error).message)
    return undefined
  }
}

function describeHandoff(h: Handoff): string {
  const files = h.files?.length
    ? ` Files: ${h.files.slice(0, 6).join(', ')}${h.files.length > 6 ? ` and ${h.files.length - 6} more` : ''}.`
    : ''
  const result = h.report ? ` Result: ${oneLine(h.report, 200)}` : ''
  return `- #${h.id} (${h.status}): ${oneLine(h.brief, 160)}${files}${result}`
}

/** The last few hand-offs, so a new one doesn't start from zero. */
export function recentHandoffsBlock(projectId: string, limit = 3): string | undefined {
  try {
    const items = recentHandoffs(memoryDb(), projectId, limit)
    if (!items.length) return undefined
    return `Recent hand-offs in this project (oldest first; the handoffs tool has the full reports):\n${items.map(describeHandoff).join('\n')}`
  } catch {
    return undefined
  }
}

export function recordUserMessage(projectId: string, text: string, note?: string): void {
  try {
    ensureHistoryImported(projectId)
    addMessage(memoryDb(), projectId, 'user', text, note)
  } catch (err) {
    console.warn('Saving the message to history failed:', (err as Error).message)
  }
}

export function recordAssistantMessage(projectId: string, text: string): void {
  try {
    addMessage(memoryDb(), projectId, 'assistant', text)
  } catch (err) {
    console.warn('Saving the reply to history failed:', (err as Error).message)
  }
}

/**
 * One-time move of a project's existing chat log into the searchable
 * history. Done before the first new message is recorded, so order holds.
 */
export function ensureHistoryImported(projectId: string): void {
  const db = memoryDb()
  const key = `history_imported:${projectId}`
  if (getMeta(db, key)) return
  transaction(db, () => {
    if (countMessages(db, projectId) === 0) {
      for (const entry of loadTranscript(projectId)) {
        if (entry.direction === 'user' && entry.text) {
          addMessage(db, projectId, 'user', entry.text, entry.attachment, '')
        } else if (entry.direction === 'event' && entry.event?.type === 'assistant_text') {
          addMessage(db, projectId, 'assistant', entry.event.text, undefined, '')
        }
      }
    }
    setMeta(db, key, new Date().toISOString())
  })
}

/** What Codex is told before the task: relevant memory, earlier hand-offs, the user's own words. */
export async function handoffContext(
  projectId: string,
  brief: string,
  request: { text: string; element?: string; images: string[] } | undefined,
  agent: string
): Promise<string> {
  const parts: string[] = []
  const relevant = await prefetchBlock(projectId, `${request?.text ?? ''} ${brief}`, agent)
  if (relevant) parts.push(relevant.replace(/^\[VibeApp note: /, 'Context: ').replace(/\]$/, ''))
  const handoffs = recentHandoffsBlock(projectId)
  if (handoffs) parts.push(handoffs)
  if (request?.text) {
    const lines = [`The user's original request, in their own words (Claude's task below is its reading of it):\n"""\n${request.text}\n"""`]
    if (request.element) lines.push(request.element)
    if (request.images.length) {
      lines.push(`The user also attached ${request.images.length === 1 ? 'an image' : `${request.images.length} images`}, attached to this prompt; the originals are at:\n${request.images.map((p) => `- ${p}`).join('\n')}`)
    }
    parts.push(lines.join('\n'))
  }
  return parts.join('\n\n')
}
