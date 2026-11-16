import type { AppSettings, TaskDifficulty, TaskKind } from '@shared/types'
import { claudeHelpersAllowed, peekUsage, percentLeft } from '../usage/usage'
import { requestClassifier, type Classification } from './classifier'
import { BALANCE_LABELS, applyBalance, fadersOf, fadersText, leanFor, leanFromFaders, orderByFaders, stepOfLean, workModeOf, type HelperRoute, type WorkFaders } from '@shared/balance'
import { clineUnavailable, resolveClineLaunch } from '../cli/clineExec'
import { localHandoffsReady } from '../cli/lmStudio'

export interface RouteDecision {
  /** Model to use for this message; null = the user's chosen model (or account default). */
  model: string | null
  /** Shown under the message when smart switching changed something. */
  label?: string
  reason?: string
  /** Why Haiku labelled the request the way it did (shown on hover). */
  detail?: string
  /** Extra guidance for Claude, sent ahead of the user's message. */
  note?: string
  /** Too small to be worth a Codex review. */
  skipReview: boolean
  /** How big Haiku (or the keyword rules) judged the request to be. */
  size: 'quick' | 'normal' | 'complex'
  /** The message says the previous result was wrong or broken (charged to whoever built it). */
  fixesLast: boolean
}

/** Below this share of a plan window left, start saving Claude usage. */
const CLAUDE_LOW = 25
/** Below this share left, stop sending work to Codex. */
const CODEX_LOW = 15

// Fallback when Haiku can't answer in time: small, self-contained tweaks
// (styling, wording, sizes). Deliberately narrow.
const QUICK_EDIT =
  /\b(colou?rs?|fonts?|text|wording|words?|typos?|spelling|rename|labels?|titles?|headings?|padding|margins?|spacing|bigger|smaller|larger|wider|narrower|taller|shorter|sizes?|align(ed)?|cent(er|re)(ed)?|bold|italic|underline|icons?|emojis?|borders?|rounded|corners?|shadows?|background|copy|placeholder|capitali[sz]e)\b/i
const NOT_QUICK =
  /\b(build|create|make an?|implement|add(ing)? (an?|new|support)|feature|refactor|debug|why|crash(es|ing)?|broken|break|doesn'?t|isn'?t|won'?t|error|bug|database|auth|log ?in|sign ?up|api|deploy|test|install|set ?up|integrat\w*|migrat\w*|performance|security|every|all (the )?pages|whole|entire)\b/i

/** Plain words saying the last change didn't work, for when Haiku doesn't judge the message. */
const FIXES_LAST =
  /\b(still (not|doesn'?t|isn'?t|broken|wrong|failing|the same)|(it|that|this|you) (broke|broken|didn'?t work|doesn'?t work|isn'?t working|is wrong|missed)|not fixed|didn'?t fix|same (error|problem|bug|issue))\b/i

export function saysLastFailed(text: string): boolean {
  return FIXES_LAST.test(text)
}

export function isQuickEdit(text: string): boolean {
  return text.length <= 160 && !text.includes('\n') && QUICK_EDIT.test(text) && !NOT_QUICK.test(text)
}

function keywordClassification(text: string, images: number): Classification {
  // A screenshot usually means "make it look like this": rarely a quick edit.
  return { size: isQuickEdit(text) && images === 0 ? 'quick' : 'normal', codex: 'none', reason: '' }
}

const CHEAP_MODELS = /haiku|sonnet/i

/**
 * Helpers check their own work: found on a real install that after a one-step
 * hand-off Claude spent 50 steps testing in a browser and 15 deploying by
 * hand, each step re-reading the whole conversation.
 */
export const CODEX_CHECKS_NOTE =
  "Put how to check the work in the hand-off too (which tests to run, and for anything visible a check in the browser with the Playwright tools if you have them, naming the address and what to try), so the agent tests what it built and reports the results. Judge the result from its report, the files changed, the diff and the automatic checks it comes back with: don't re-read the diff with git or repeat the testing yourself. If something failed or a specific doubt is left, hand the fix or the check back with another run_subtask rather than doing it yourself. To deploy, use mcp__vibe_tools__run_deploy."

const CODEX_LED_NOTE = `The user has set Starwright to Codex-led: you plan and review, the helper agents build and test. Work out what's needed, then hand the building off with run_subtask (a clear spec and acceptance criteria each) and let them write the code; don't write it yourself except small fixes after you've reviewed the result. ${CODEX_CHECKS_NOTE}`

/** Whether Claude may hand work to Cline right now: switched on, installed, and not out of plan. */
export async function clineReadyForHandoffs(settings: AppSettings): Promise<boolean> {
  if (!settings.clineHandoffs || clineUnavailable()) return false
  return !!(await resolveClineLaunch())
}

/**
 * How hand-offs work now: Claude describes the task and Starwright picks the agent. Names only the
 * agents that can take work right now. Asks Claude to split bigger jobs, so the simple parts can go
 * to the free local model or to Cline instead of all of it going to Codex.
 */
export function handoffNote(helpers: { codex: boolean; cline: boolean; local: boolean }): string {
  const who = [
    helpers.local ? 'the local model (free, on this computer)' : '',
    helpers.cline ? "Cline (on the user's separate ClinePass plan)" : '',
    helpers.codex ? 'Codex' : ''
  ].filter(Boolean)
  if (!who.length) return ''
  const list = who.length > 1 ? `${who.slice(0, -1).join(', ')} or ${who.at(-1)}` : who[0]
  return `To hand work off, use run_subtask with the task (what to do, which files, what "done" looks like, how to check it), its kind and how hard it is: Starwright picks who does it, ${list}, from the user's settings and what each plan has left, and passes it on if one fails. Split bigger jobs: hand each simple, well-specified part off on its own marked "simple", so it can go to the cheaper agents; mark a part "hard" only if it truly is.`
}

const CODEX_NOTES = {
  most: 'This request is mostly straightforward implementation, so a helper agent should build it: plan the work, then hand it off with run_subtask (a clear spec and acceptance criteria) before writing the code yourself. Afterwards, review the result and fix anything off.',
  some: 'Part of this request is independent and well-scoped. Consider handing that part off with run_subtask while you do the rest; skip it if doing it yourself is clearly quicker.'
}

export type { HelperRoute }

/**
 * Who a hand-off goes to, in order of trying (the next one gets it if one fails without changing
 * anything). Simple work goes to the free local model first, then Cline, then Codex; moderate work
 * to Codex first; hard work to Codex, else Cline, never the local model. Tests, boilerplate and docs
 * count as simple unless Claude says they're hard. A nearly used-up Codex plan moves Codex last; an
 * agent the user asked for goes first. Only agents that can take work right now are included.
 * With the equalizer on Manual, the faders reorder that (higher first, off dropped; see orderByFaders).
 */
export function chooseRoutes(input: {
  difficulty: TaskDifficulty
  kind: TaskKind
  available: Record<HelperRoute, boolean>
  codexLow: boolean
  asked?: HelperRoute
  /** The user's faders, when the equalizer is on Manual. */
  faders?: WorkFaders
}): HelperRoute[] {
  const plain = input.kind === 'tests' || input.kind === 'boilerplate' || input.kind === 'docs'
  const level = input.difficulty === 'moderate' && plain ? 'simple' : input.difficulty
  let order: HelperRoute[] = level === 'simple' ? ['local', 'cline', 'codex'] : level === 'moderate' ? ['codex', 'cline', 'local'] : ['codex', 'cline']
  if (input.faders) order = orderByFaders(order, input.faders, level)
  if (input.codexLow && order.includes('codex')) order = [...order.filter((r) => r !== 'codex'), 'codex']
  // An agent asked for by name goes first, unless the user switched it off on the faders.
  if (input.asked && (!input.faders || input.faders[input.asked] > 0)) order = [input.asked, ...order.filter((r) => r !== input.asked)]
  return order.filter((r) => input.available[r])
}

/** Which helper agents can take work right now, and whether Codex's plan is nearly used up. */
export async function helperAvailability(settings: AppSettings): Promise<{ available: Record<HelperRoute, boolean>; codexLow: boolean }> {
  const codex = peekUsage('codex')
  const codexLeft = percentLeft(codex)
  return {
    available: {
      // Not installed or not signed in shows as an error; unknown (not checked yet) counts as there.
      codex: codex?.status !== 'error',
      cline: await clineReadyForHandoffs(settings).catch(() => false),
      local: await localHandoffsReady().catch(() => false)
    },
    codexLow: codexLeft !== undefined && codexLeft < CODEX_LOW
  }
}

export async function routeMessage(
  text: string,
  settings: AppSettings,
  context: {
    images?: number
    pointedAt?: boolean
    projectId?: string
    /** Planning, or building an approved plan: never a quick edit, however short the words typed. */
    notQuick?: boolean
    /** Whether Cline can take hand-offs (looked up when not given). */
    clineReady?: boolean
    /** Whether the local model can take hand-offs (looked up when not given). */
    localReady?: boolean
  } = {}
): Promise<RouteDecision> {
  // Smart switching off means no model changes and no Haiku judge, but the
  // equalizer still applies (it used to be skipped altogether).
  const smart = settings.smartRouting
  const images = context.images ?? 0
  // The Haiku judge also spends Claude plan; stand it down when Claude is nearly out.
  const labelled = smart && settings.aiRouting && claudeHelpersAllowed()
    ? await requestClassifier.classify(text, { images, pointedAt: context.pointedAt, projectId: context.projectId })
    : null
  let request: Classification = labelled ?? (smart ? keywordClassification(text, images) : { size: 'normal', codex: 'none', reason: '' })
  // A quick edit skips Codex, the review and memory, and goes to Haiku: right
  // for "make the title blue", wrong for a plan (a 7-step deploy plan was
  // judged quick and planned and built by Haiku, ignoring the slider).
  if (context.notQuick && request.size === 'quick') request = { ...request, size: 'normal' }

  const baseline = settings.claudeModel
  const claudeLeft = percentLeft(peekUsage('claude'))
  const codexLeft = percentLeft(peekUsage('codex'))
  const claudeLow = claudeLeft !== undefined && claudeLeft < CLAUDE_LOW
  const codexLow = codexLeft !== undefined && codexLeft < CODEX_LOW

  // How much goes to the helpers: Haiku's call, shifted by the equalizer (or,
  // on Auto, by which plan has more left), then adjusted for plans that are
  // nearly used up.
  const balance = settings.agentBalance ?? 'auto'
  // The equalizer: on Manual the faders say who may take work and how much Claude hands off.
  const manual = workModeOf(settings) === 'manual'
  const faders = fadersOf(settings)
  const on = (route: HelperRoute): boolean => !manual || faders[route] > 0

  // Cline (a third agent on its own ClinePass plan), when it's set up for hand-offs.
  const cline = request.size !== 'quick' && on('cline') && (context.clineReady ?? (await clineReadyForHandoffs(settings)))
  // The local model (VibeApp's own agent on LM Studio), when it's switched on and LM Studio is up.
  const local = request.size !== 'quick' && on('local') && (context.localReady ?? (await localHandoffsReady()))
  const codexOn = on('codex')

  const lean = manual ? leanFromFaders(faders, { codex: codexOn && !codexLow, cline, local }) : leanFor(balance, claudeLeft, codexLeft)
  let codex = applyBalance(request.codex, request.size, lean)
  if (codexLow || (manual && !codexOn && !cline && !local)) codex = 'none'
  else if (claudeLow && codex === 'some') codex = 'most'
  const helperNote = handoffNote({ codex: !codexLow && codexOn, cline, local })

  const notes: string[] = []
  if (codexLow) {
    notes.push(
      cline || local
        ? `Codex plan usage is nearly used up (${Math.round(codexLeft)}% left), so Starwright sends hand-offs to ${[cline ? 'Cline' : '', local ? 'the local model' : ''].filter(Boolean).join(' or ')} first: hand off the straightforward, well-specified parts and do the tricky parts yourself.`
        : `Codex plan usage is nearly used up (${Math.round(codexLeft)}% left). Don't hand work off for this request; do the work yourself.`
    )
    if (cline || local) notes.push(helperNote)
  } else if (codex === 'most' && lean >= 2) {
    notes.push(CODEX_LED_NOTE)
    notes.push(helperNote)
  } else if (codex !== 'none') {
    notes.push(CODEX_NOTES[codex])
    if (lean >= 1) notes.push(CODEX_CHECKS_NOTE)
    if (lean >= 1 && codex === 'some') notes.push('The user prefers that you lean on the helper agents, so hand that part over.')
    if (claudeLow) notes.push(`Claude plan usage is also low (${Math.round(claudeLeft)}% left), so lean on the helper agents.`)
    notes.push(helperNote)
  } else if (lean <= -1 && request.size !== 'quick') {
    notes.push('The user prefers that you do the work yourself rather than hand it off.')
  } else if (claudeLow && codexLeft !== undefined && request.size !== 'quick') {
    notes.push(`Claude plan usage is low (${Math.round(claudeLeft)}% left). Hand implementation work off with run_subtask wherever it's reasonable, and keep your own work to planning, coordination and review.`)
    notes.push(helperNote)
  } else if (request.size !== 'quick' && (cline || local)) {
    // Nothing big enough for Codex, but simple, well-specified parts can still go to the cheaper agents.
    notes.push(helperNote)
  }
  // Checking and saving memory would cost more than a quick edit itself.
  if (request.size === 'quick') {
    notes.push(
      "This looks like a quick request: don't save anything to memory, and only search memory if the answer depends on something remembered."
    )
  }
  const kept = notes.filter(Boolean)
  const note = kept.length ? `[VibeApp note: ${kept.join(' ')}]` : undefined

  // Which Claude model.
  let model: string | null = null
  let modelLabel: string | undefined
  let modelReason: string | undefined
  const choseHaiku = !!baseline && /haiku/i.test(baseline)
  if (smart && !choseHaiku) {
    if (request.size === 'quick') {
      model = 'haiku'
      modelLabel = 'Haiku'
      modelReason = 'quick edit'
    } else if (request.size === 'complex' && settings.stepUpForComplex && baseline && CHEAP_MODELS.test(baseline)) {
      // Opt-in only: the model the user picked is otherwise a ceiling.
      model = 'opus'
      modelLabel = 'Opus'
      modelReason = 'complex request'
    } else if (
      // Codex is doing the building, so Claude only plans and reviews: a
      // lighter model is enough. Only ever downward from the user's choice.
      lean >= 1 &&
      codex === 'most' &&
      request.size === 'normal' &&
      !(baseline && CHEAP_MODELS.test(baseline))
    ) {
      model = 'sonnet'
      modelLabel = 'Sonnet'
      modelReason = 'Codex is building it'
    } else if (request.size === 'normal' && claudeLow && !(baseline && CHEAP_MODELS.test(baseline))) {
      model = 'sonnet'
      modelLabel = 'Sonnet'
      modelReason = `saving Claude usage (${Math.round(claudeLeft)}% left)`
    }
  }

  // "some" is a suggestion Claude may turn down, so the tag says so.
  const codexReason =
    codex === 'most' ? 'Codex does most of the work' : codex === 'some' ? 'Codex suggested for a part' : undefined
  const reasons = [modelReason, codexReason].filter(Boolean) as string[]
  return {
    model,
    label: modelLabel ?? (codexReason ? 'Codex' : undefined),
    reason: modelLabel
      ? reasons.join(' · ')
      : codex === 'most'
        ? 'does most of the work'
        : codex === 'some'
          ? 'suggested for a part'
          : undefined,
    detail: `${
      labelled
        ? `Haiku: ${request.size}${request.reason ? ` (${request.reason})` : ''}`
        : !smart
          ? 'Smart switching off'
          : settings.aiRouting
          ? 'Keyword rules (Haiku was unavailable)'
          : 'Keyword rules'
    }${manual ? ` · faders: ${fadersText(faders)}` : lean !== 0 ? ` · balance: ${BALANCE_LABELS[stepOfLean(lean)]}${balance === 'auto' ? ' (auto)' : ''}` : ''}`,
    note,
    skipReview: request.size === 'quick',
    size: request.size,
    fixesLast: labelled ? !!labelled.fixesLast || saysLastFailed(text) : saysLastFailed(text)
  }
}
