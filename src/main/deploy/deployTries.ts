// Claude's failed Deploy runs in the current request, per project. Found on Lazarus: one WebNotes
// request ran the same failing Deploy 9 times (2.5M tokens, 26 minutes). After two failures in a row
// it isn't run again in that request; the user's next message, or a deploy that works, starts over.

/** Claude may run a failing Deploy this many times in a row in one request. */
export const DEPLOY_TRIES = 2

const fails = new Map<string, { count: number; lastStep?: string }>()

/** A new request from the user: Claude may try the Deploy again. */
export function resetDeployTries(projectId: string): void {
  fails.delete(projectId)
}

/** Why Claude's run_deploy isn't run now, or null to run it. */
export function deployRefusal(projectId: string): string | null {
  const f = fails.get(projectId)
  if (!f || f.count < DEPLOY_TRIES) return null
  return `Not run: the Deploy has already failed ${f.count} times in a row in this request${f.lastStep ? ` (last at "${f.lastStep}")` : ''}, so Starwright won't run it again until the user says so. Stop here: don't retry, and don't deploy by hand instead. Tell the user in plain words which step failed, the key lines of the error, what you think the cause is and what you'd change, and ask how they want to go on.`
}

/** Records how Claude's deploy went; returns what to add to what Claude is told (empty when it worked). */
export function recordDeployResult(projectId: string, result: { ok: boolean; stopped?: boolean; failedStep?: string }): string {
  if (result.ok) {
    fails.delete(projectId)
    return ''
  }
  // A stop by the user isn't the deploy failing, but it isn't retried either.
  const count = result.stopped ? DEPLOY_TRIES : (fails.get(projectId)?.count ?? 0) + 1
  fails.set(projectId, { count, lastStep: result.failedStep })
  if (result.stopped) return " Don't run it again unless the user asks."
  if (count >= DEPLOY_TRIES) {
    return ` That's ${count} failures in a row: Starwright won't run it again in this request. Stop and tell the user what failed and why you think it did, and ask how to go on; don't deploy by hand instead.`
  }
  return ' Find and fix the cause before running it again: you get one more try in this request, and re-running it unchanged fails the same way.'
}
