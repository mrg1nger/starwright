// Spots a message that is only a question about the project, so it can be
// answered by the cheap Ask path instead of the full coding session. It is
// deliberately cautious: when unsure, the message stays a normal Build request.

const ACK = /^(?:ok|okay|looks good|looks great|great|good|thanks|thank you|thx|nice|cool|awesome|perfect|got it|sounds good|yep|yes|alright)\W*$/i

const CHANGE_WORDS =
  /\b(add|change|make|fix|build|create|update|remove|delete|implement|refactor|rename|write|install|deploy|publish|replace|improve|redesign|tweak|adjust|increase|decrease|enable|disable|convert|integrate|optimi[sz]e|commit|push|revert|undo|generate|rewrite|swap|hook up|wire up|set up|clean up)\b/i

const QUESTION_PREFIX = /^(?:quick question|just a question|question|real quick|just wondering|curious)\b[\s:,.-]*/i

const QUESTION_WORD =
  /^(?:what|what's|whats|which|who|whom|whose|where|when|why|how|is|are|was|were|do|does|did|can|could|would|will|should|has|have|any|tell me)\b/i

const MAX_CHARS = 400

const TODO_LIST = String.raw`(?:my|the|our|this project'?s)\s+(?:to-?\s?do|todo)(?:\s+list)?`

/**
 * A short message that only asks to put something on (or tick it off) the
 * user's own to-do list: "add X to my to-do list", "tick off X on my to-do
 * list". Keeping a list isn't changing the project, so the cheap path can do
 * it. Anything else that mentions a to-do list ("add a to-do list to my app")
 * stays a Build request.
 */
export function isTodoListRequest(text: string): boolean {
  const t = text.trim().replace(/[.!]+$/, '')
  if (!t || t.length > 300 || /\n/.test(t)) return false
  const add = new RegExp(String.raw`^(?:please\s+)?(?:add|put|note|jot down|stick)\b.+\b(?:to|on|onto|in)\s+${TODO_LIST}(?:\s+for later)?(?:,?\s+please)?$`, 'i')
  const tick = new RegExp(String.raw`^(?:please\s+)?(?:tick|check|cross|mark)\s+(?:off\s+)?.+\b(?:off|done|as done)?\s*(?:on|from|in)\s+${TODO_LIST}(?:,?\s+please)?$`, 'i')
  return add.test(t) || tick.test(t)
}

/** True when the whole message is a plain question (nothing asked to be changed). */
export function isPlainQuestion(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > MAX_CHARS || !trimmed.includes('?')) return false
  if (CHANGE_WORDS.test(trimmed)) return false
  // Code or paths mean it's about specifics; leave those to the full session.
  if (/```/.test(trimmed)) return false

  const sentences = trimmed.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)
  let questions = 0
  for (const sentence of sentences) {
    if (ACK.test(sentence)) continue
    const body = sentence.replace(QUESTION_PREFIX, '').trim()
    const looksLikeQuestion = QUESTION_WORD.test(body) || (sentence.endsWith('?') && body.length > 0)
    // "Can you ..."/"could you ..." asking for an action is a request, not a question.
    if (/^(?:can|could|would|will) you\b/i.test(body)) return false
    if (!looksLikeQuestion) return false
    questions++
  }
  return questions > 0
}

/** What the question path answers when the question needs a command run, so the message goes on as a build request. */
export const NEEDS_BUILD = '[needs a build request]'

const LIVE = "something live that the project's files can't tell you (a server's or VM's state, a database's contents, a running app, what a command or script would print)"

/**
 * For the question path, which can only read: a question about live state ("how many VMs are on the
 * server?") isn't answered with "I have no access". Sent from Build (auto), it goes on as a build
 * request; asked in Ask mode, the answer says Build will do it.
 */
export function liveQuestionRule(auto: boolean): string {
  return auto
    ? `You can't run commands. If answering needs ${LIVE}, don't say you have no access and don't guess: reply with exactly ${NEEDS_BUILD} and nothing else. Starwright then sends the message on as a build request, where commands can be run.`
    : `You can't run commands. If answering needs ${LIVE}, don't say you have no access: say in one line that it needs a command run, and that sending it in Build mode will do that.`
}

/** The question path's answer says the message needs a build request (only a short answer: never one that just mentions it). */
export function needsBuild(answer: string): boolean {
  const trimmed = answer.trim()
  return trimmed.length <= 200 && trimmed.toLowerCase().includes(NEEDS_BUILD)
}

/** The note that tells Claude (or Codex) about questions answered the cheap way just before a Build or Plan message. */
export function askNoteText(asks: { question: string; answer: string }[]): string | undefined {
  if (!asks.length) return undefined
  const clip = (s: string, max: number): string => {
    const flat = s.trim()
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
  }
  const lines = asks.map((a) => `Q: ${clip(a.question, 500)}\nA: ${clip(a.answer, 1200)}`)
  return `[VibeApp note: just before this message, the user asked ${asks.length === 1 ? 'this question' : 'these questions'} in Ask mode, which was answered separately (you didn't see it). Their message may refer to it:\n${lines.join('\n\n')}]`
}
