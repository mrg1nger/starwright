import type { AppSettings } from '@shared/types'
import { claudeHelpersAllowed, clineLowNow, peekUsage, percentLeft } from '../usage/usage'
import { requestClassifier, type Classification } from './classifier'
import { BALANCE_LABELS, applyBalance, chooseRoutes, fadersOf, fadersText, leanFor, leanFromFaders, stepOfLean, workModeOf, type HelperRoute, type WorkFaders } from '@shared/balance'
import { clineUnavailable, resolveClineLaunch } from '../cli/clineExec'
import { localHandoffsReady } from '../cli/lmStudio'
import { toolHeld } from '../updates/toolGate'
import { memoryDb } from '../memory/paths'
import { handoffCountsSince } from '../memory/store'

/** Hand-offs each agent took this past week: equal faders share the work by this. */
export function recentHandoffUse(): Partial<Record<HelperRoute, number>> {
  try {
    return handoffCountsSince(memoryDb(), new Date(Date.now() - 7 * 24 * 3600_000).toISOString())
  } catch {
    return {} // bookkeeping only: without it, ties keep the usual order
  }
}

const AGENT_NAMES: Record<HelperRoute, string> = { codex: 'Codex', cline: 'Cline', local: 'The local model' }

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

/**
 * For Plan mode: how much of the plan to mark "Hand off", from the equalizer (or Auto's lean), so a
 * plan made under "Free first" or "Save Claude" hands off the plain steps too, not just big ones.
 */
export function planHandoffNote(lean: number, helpers: Record<HelperRoute, boolean>, faders?: WorkFaders): string {
  if (!helpers.codex && !helpers.cline && !helpers.local) return 'No other agent can take work right now: mark every step (Claude).'
  const cheap = [
    helpers.local && (!faders || faders.local >= 3) ? 'the free local model' : '',
    helpers.cline && (!faders || faders.cline >= 3) ? 'Cline' : ''
  ].filter(Boolean)
  const where = cheap.length ? ` The user's settings favour ${cheap.join(' and ')} for simple work, so give each simple, well-specified piece its own step marked "Hand off: simple".` : ''
  if (lean >= 1) {
    return `For the plan: the user wants the helper agents to do most of the building. Mark every self-contained step "Hand off" (scaffolding, boilerplate, tests and docs included), and keep for Claude only design decisions, wiring the pieces together and the final review.${where}`
  }
  if (lean <= -1) return 'For the plan: the user prefers Claude to do most of the work. Mark "Hand off" only clearly separate, well-specified steps.'
  return `For the plan: mark the self-contained building steps "Hand off"; keep design, integration and review for Claude.${where}`
}

const CODEX_NOTES = {
  most: 'This request is mostly straightforward implementation, so a helper agent should build it: plan the work, then hand it off with run_subtask (a clear spec and acceptance criteria) before writing the code yourself. Afterwards, review the result and fix anything off.',
  some: 'Part of this request is independent and well-scoped. Consider handing that part off with run_subtask while you do the rest; skip it if doing it yourself is clearly quicker.'
}

export type { HelperRoute }
export { chooseRoutes }

/** Which helper agents can take work right now, and whether Codex's plan is nearly used up. */
export async function helperAvailability(
  settings: AppSettings
): Promise<{ available: Record<HelperRoute, boolean>; codexLow: boolean; clineLow: boolean }> {
  const codex = peekUsage('codex')
  const codexLeft = percentLeft(codex)
  return {
    available: {
      // Not installed or not signed in shows as an error; unknown (not checked yet) counts as there.
      // Being updated (or its update failed Starwright's check): held back until that's settled.
      codex: codex?.status !== 'error' && !toolHeld('codex'),
      cline: await clineReadyForHandoffs(settings).catch(() => false),
      local: await localHandoffsReady().catch(() => false)
    },
    codexLow: codexLeft !== undefined && codexLeft < CODEX_LOW,
    clineLow: clineLowNow().low
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
    /** Plan mode: the note says how much of the plan to mark for hand-off. */
    planning?: boolean
    /** Whether Cline can take hand-offs (looked up when not given). */
    clineReady?: boolean
    /** Whether the local model can take hand-offs (looked up when not given). */
    localReady?: boolean
    /** Hand-offs each agent took lately (looked up when not given). */
    used?: Partial<Record<HelperRoute, number>>
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
  const codexOn = on('codex') && !toolHeld('codex')
  // ClinePass nearly used up: Cline stays as a last resort, but doesn't count as a helper to lean on.
  const { low: clineLow, left: clineLeft } = clineLowNow()
  const clineFirst = cline && !clineLow

  const lean = manual ? leanFromFaders(faders, { codex: codexOn && !codexLow, cline: clineFirst, local }) : leanFor(balance, claudeLeft, codexLeft)
  let codex = applyBalance(request.codex, request.size, lean)
  if (codexLow || (manual && !codexOn && !clineFirst && !local)) codex = 'none'
  else if (claudeLow && codex === 'some') codex = 'most'
  const helperNote = handoffNote({ codex: !codexLow && codexOn, cline, local })

  const notes: string[] = []
  if (codexLow) {
    notes.push(
      clineFirst || local
        ? `Codex plan usage is nearly used up (${Math.round(codexLeft)}% left), so Starwright sends hand-offs to ${[clineFirst ? 'Cline' : '', local ? 'the local model' : ''].filter(Boolean).join(' or ')} first: hand off the straightforward, well-specified parts and do the tricky parts yourself.`
        : `Codex plan usage is nearly used up (${Math.round(codexLeft)}% left). Don't hand work off for this request; do the work yourself.`
    )
    if (clineFirst || local) notes.push(helperNote)
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
  if (cline && clineLow && clineLeft !== undefined && request.size !== 'quick') {
    notes.push(`ClinePass usage is nearly used up (${Math.round(clineLeft)}% left): Starwright gives Cline work only when nobody else can take it.`)
  }
  if (context.planning) notes.push(planHandoffNote(lean, { codex: codexOn && !codexLow, cline: clineFirst, local }, manual ? faders : undefined))
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
    } else if (
      request.size === 'complex' &&
      settings.stepUpForComplex &&
      baseline &&
      CHEAP_MODELS.test(baseline) &&
      // Claude's fader at its lowest says spend as little Claude as possible: no step up to Opus.
      !(manual && faders.claude <= 1)
    ) {
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
      modelReason = 'the helpers are building it'
    } else if (request.size === 'normal' && claudeLow && !(baseline && CHEAP_MODELS.test(baseline))) {
      model = 'sonnet'
      modelLabel = 'Sonnet'
      modelReason = `saving Claude usage (${Math.round(claudeLeft)}% left)`
    }
  }

  // "some" is a suggestion Claude may turn down, so the tag says so. It names the agent a hand-off
  // would go to first now (the faders, then who took fewer lately), not always Codex.
  const lead =
    codex === 'none'
      ? undefined
      : chooseRoutes({
          difficulty: request.size === 'complex' ? 'hard' : 'moderate',
          kind: 'feature',
          available: { codex: codexOn && !codexLow, cline, local },
          codexLow,
          clineLow,
          faders: manual ? faders : undefined,
          used: manual ? (context.used ?? recentHandoffUse()) : undefined
        })[0]
  const leadName = lead ? AGENT_NAMES[lead] : 'The helpers'
  const helperReason =
    codex === 'most' ? (lead ? 'does most of the work' : 'do most of the work') : codex === 'some' ? 'suggested for a part' : undefined
  const reasons = [modelReason, helperReason && `${leadName} ${helperReason}`].filter(Boolean) as string[]
  return {
    model,
    label: modelLabel ?? (helperReason ? leadName : undefined),
    reason: modelLabel ? reasons.join(' · ') : helperReason,
    detail: `${
      labelled
        ? `Haiku: ${request.size}${request.reason ? ` (${request.reason})` : ''}`
        : !smart
          ? 'Smart switching off'
          : settings.aiRouting
          ? 'Keyword rules (Haiku was unavailable)'
          : 'Keyword rules'
    }${manual ? ` · faders: ${fadersText(faders)}` : lean !== 0 ? ` · balance: ${BALANCE_LABELS[stepOfLean(lean)]}${balance === 'auto' ? ' (auto)' : ''}` : ''}${
      clineLow && clineLeft !== undefined ? ` · ClinePass ${Math.round(clineLeft)}% left` : ''
    }`,
    note,
    skipReview: request.size === 'quick',
    size: request.size,
    fixesLast: labelled ? !!labelled.fixesLast || saysLastFailed(text) : saysLastFailed(text)
  }
}
