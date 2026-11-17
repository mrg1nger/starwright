import { isAbsolute, relative } from 'path'
import type { VibeEvent } from '@shared/types'
import type { ClaudeSession } from '../orchestrator/session'
import { changeStats, takeSnapshot } from '../git/snapshots'
import { verifyChanges } from './checks'
import { getSettings } from '../settings/store'
import { peekUsage, percentLeft } from '../usage/usage'
import { changesBetween, fixPrompt, reviewChanges } from './codexReview'
import { scanDiff } from '../secrets/leakScan'
import { secretValues } from '../secrets/vault'
import { memoryDb } from '../memory/paths'
import { handoffAgentsSince, markReworked, recordReview, routeOf, setReviewFixResult, type WorkRoute } from '../memory/store'

/** Below this share of Codex plan left, skip reviews to save it for real work. */
const CODEX_REVIEW_MIN_LEFT = 15

interface TurnContext {
  projectPath: string
  request: string
  /** Files as they were before the user's message. */
  snapshot?: string
  /** Why there's no snapshot, when taking it failed. */
  snapshotError?: string
  skipReview: boolean
  phase: 'main' | 'reviewing' | 'fixing'
  hadError: boolean
  /** Claude edited files itself (with its own editing tools). */
  claudeEdited: boolean
  /** When the request started: its hand-offs are the ones recorded since. */
  startedAt: string
  /** The review of this request, so the fix round can record whether the fixes held. */
  reviewId?: number
  abort?: AbortController
  /** Emits the held-back turn_complete (used by "Skip review"). */
  finishNow?: () => void
}

const turns = new Map<string, TurnContext>()

/** Claude's own file-editing tools (as opposed to work done through a Codex hand-off). */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

export function beginTurn(
  projectId: string,
  context: Pick<TurnContext, 'projectPath' | 'request' | 'snapshot' | 'snapshotError' | 'skipReview'>
): void {
  turns.get(projectId)?.abort?.abort()
  turns.set(projectId, { ...context, phase: 'main', hadError: false, claudeEdited: false, startedAt: new Date().toISOString() })
}

/** Whether each request was reviewed, or why not (read once by the request log when the request ends). */
const reviewNotes = new Map<string, string>()

/** Reviewed, or why not, for the request that just ended (once). */
export function takeReviewNote(projectId: string): string | null {
  const note = reviewNotes.get(projectId) ?? null
  reviewNotes.delete(projectId)
  return note
}

/** Who built a request's changes: Claude for its own edits, and the agents of its hand-offs (from their records). */
function buildersOf(projectId: string, turn: TurnContext): WorkRoute[] {
  const out = new Set<WorkRoute>(turn.claudeEdited ? ['claude'] : [])
  try {
    for (const agent of Object.keys(handoffAgentsSince(memoryDb(), projectId, turn.startedAt))) {
      const route = routeOf(agent)
      if (route) out.add(route)
    }
  } catch {
    // no records: Claude's own edits are all we know
  }
  return [...out]
}

/** A file Claude edited, relative to the project with forward slashes (as hand-offs record their files). */
function projectRelative(projectPath: string, input: unknown): string | null {
  const file = (input as { file_path?: string; notebook_path?: string } | undefined)?.file_path ?? (input as { notebook_path?: string } | undefined)?.notebook_path
  if (!file) return null
  const rel = (isAbsolute(file) ? relative(projectPath, file) : file).replace(/\\/g, '/')
  return rel.startsWith('..') ? null : rel
}

/** Why Codex can't review right now, or null when it can. */
function reviewBlocked(): string | null {
  if (!getSettings().codexReview) return 'skipped: reviews switched off'
  const codex = peekUsage('codex')
  if (codex?.status === 'error') return "skipped: Codex not available" // not installed or not logged in
  const left = percentLeft(codex)
  return left === undefined || left >= CODEX_REVIEW_MIN_LEFT ? null : 'skipped: Codex plan nearly used up'
}

/**
 * Sits between a Claude session's events and the UI. When Claude finishes a
 * request that changed code, the turn_complete is held back while Codex
 * reviews the change; if Codex finds real problems, Claude is asked to fix
 * them in the same turn, so the user sees one finished result.
 */
export function handleSessionEvent(
  projectId: string,
  session: ClaudeSession,
  event: VibeEvent,
  forward: (event: VibeEvent) => void
): void {
  const turn = turns.get(projectId)
  // An error or a Stop leaves a half-finished change: not worth reviewing.
  if (turn && (event.type === 'error' || event.type === 'stopped')) turn.hadError = true
  // Plan mode was left with the user's OK: what's built from here gets the usual review.
  if (turn && event.type === 'plan_left') turn.skipReview = false
  if (turn && event.type === 'tool_call' && !event.parentToolUseId && EDIT_TOOLS.has(event.name)) {
    turn.claudeEdited = true
    // Claude changing a file a hand-off in this request already changed: that hand-off was redone.
    const file = projectRelative(turn.projectPath, event.input)
    if (file) {
      try {
        markReworked(memoryDb(), projectId, [file], turn.startedAt)
      } catch {
        // bookkeeping only
      }
    }
  }

  if (event.type !== 'turn_complete' || !turn || turn.phase === 'reviewing') {
    forward(event)
    return
  }
  if (!turn.snapshot) {
    turns.delete(projectId)
    reviewNotes.set(projectId, turn.snapshotError ? `skipped: no snapshot (${turn.snapshotError})` : 'skipped: no snapshot')
    forward(event)
    return
  }
  // Codex built it all (Claude changed nothing itself, nobody else helped): Codex reviewing its
  // own work wouldn't be independent. Claude has already reviewed the diff and the automatic
  // checks have run, so save the Codex plan. Cline's and the local model's work is reviewed.
  const builders = buildersOf(projectId, turn)
  const codexBuiltIt = builders.length === 1 && builders[0] === 'codex'
  const skipped =
    turn.phase !== 'main'
      ? null
      : turn.skipReview
        ? 'skipped: quick edit or plan'
        : turn.hadError
          ? 'skipped: error or stopped'
          : codexBuiltIt
            ? 'skipped: Codex built it'
            : session.isDead()
              ? 'skipped: session ended'
              : reviewBlocked()
  const wantReview = turn.phase === 'main' && !skipped
  if (skipped) reviewNotes.set(projectId, skipped)
  const fixRound = turn.phase === 'fixing'

  turn.phase = 'reviewing'
  const abort = new AbortController()
  turn.abort = abort
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    if (turns.get(projectId) === turn) turns.delete(projectId)
    forward({ type: 'turn_complete' })
  }
  turn.finishNow = () => {
    abort.abort()
    if (reviewStarted) {
      reviewNotes.set(projectId, 'skipped by the user')
      forward({ type: 'review_result', ok: false, summary: 'Review skipped.', findings: [], fixing: false })
    }
    finish()
  }

  let reviewStarted = false
  void (async () => {
    try {
      const after = await takeSnapshot(turn.projectPath, `after: ${turn.request}`)
      const diff = await changesBetween(turn.projectPath, turn.snapshot!, after)
      const leaks = scanDiff(diff, secretValues(projectId))
      if (leaks.length) forward({ type: 'secret_leak', leaks })
      // After a review's fixes: do the automatic checks pass on the fixed code? (Did the fixes hold?)
      if (fixRound && turn.reviewId !== undefined && !abort.signal.aborted) {
        const reviewId = turn.reviewId
        const files = (await changeStats(turn.projectPath, turn.snapshot!, after).catch(() => [])).map((c) => c.path)
        if (files.length) {
          const verdict = await verifyChanges(turn.projectPath, files).catch(() => ({ ok: null as boolean | null }))
          if (verdict.ok !== null) {
            try {
              setReviewFixResult(memoryDb(), reviewId, verdict.ok)
            } catch {
              // bookkeeping only
            }
          }
        }
      }
      if (wantReview && !diff.trim()) reviewNotes.set(projectId, 'no changes')
      if (!wantReview || !diff.trim() || abort.signal.aborted) return finish()

      reviewStarted = true
      forward({ type: 'review_started' })
      const review = await reviewChanges(turn.projectPath, diff, turn.request, abort.signal, projectId)
      if (finished || abort.signal.aborted) return

      const serious = review.findings.filter((f) => f.severity !== 'low')
      reviewNotes.set(projectId, 'reviewed')
      try {
        turn.reviewId = recordReview(memoryDb(), {
          projectId,
          reviewer: 'codex',
          builtBy: builders.length ? builders : ['claude'],
          findings: review.findings
        })
      } catch (err) {
        console.warn('Recording the review failed:', (err as Error).message)
      }
      const fixing = serious.length > 0 && !session.isDead()
      forward({ type: 'review_result', ok: true, summary: review.summary, findings: review.findings, fixing })
      if (!fixing) return finish()

      // Claude's fix turn ends with its own turn_complete; in the 'fixing'
      // phase that gets the leak check but no second review.
      turn.phase = 'fixing'
      turn.finishNow = undefined
      session.send(fixPrompt(serious))
    } catch (err) {
      if (finished || abort.signal.aborted) return
      if (!reviewStarted) return finish() // only the leak check failed; nothing to report
      reviewNotes.set(projectId, 'review failed')
      forward({
        type: 'review_result',
        ok: false,
        summary: `Codex couldn't review this change: ${(err as Error).message}`,
        findings: [],
        fixing: false
      })
      finish()
    }
  })()
}

/** The user chose not to wait for the review. Returns false if no review was running. */
export function skipReview(projectId: string): boolean {
  const finishNow = turns.get(projectId)?.finishNow
  finishNow?.()
  return !!finishNow
}
