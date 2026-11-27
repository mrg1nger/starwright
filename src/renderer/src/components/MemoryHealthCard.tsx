import { useCallback, useEffect, useState } from 'react'
import type { MemoryHealth, MemoryHealthAction, MemoryHealthIssue, ProjectRecord } from '@shared/types'

// The Memory screen's Health card: what Starwright's check of the saved memory found, and the fix
// it suggests for each. Nothing changes until a button is pressed; a dismissed one stays dismissed.

const ACTION_LABELS: Record<MemoryHealthAction, string> = {
  'rewrite-brief': 'Rewrite the brief',
  merge: 'Merge',
  'unmark-key': 'Unmark key',
  forget: 'Forget',
  'make-global': 'Make it one fact for all projects'
}

const PROPOSED_LABELS: Partial<Record<MemoryHealthIssue['kind'], string>> = {
  brief: 'The brief would read',
  duplicate: 'Merged, it would say',
  global: 'For all projects, it would say'
}

interface Props {
  project: ProjectRecord
  /** "project": this project's suggestions and those spanning projects that include it; "global": every one spanning projects. */
  scope: 'project' | 'global'
  /** After a fix: the facts (and the brief) have changed. */
  onChanged: () => void
  onError?: (message: string) => void
}

type Both = { project: MemoryHealth; global: MemoryHealth }

function checkedLine(at: string | null): string {
  return at ? `checked ${new Date(at).toLocaleString()}` : 'not checked yet'
}

export default function MemoryHealthCard({ project, scope, onChanged, onError }: Props) {
  const [health, setHealth] = useState<Both | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState('')
  /** Open while there's something to fix, unless folded by hand; once used, it stays as left (a fix's message shows). */
  const [open, setOpen] = useState<boolean | null>(null)
  const fail = useCallback((err: unknown) => onError?.((err as Error).message), [onError])

  useEffect(() => {
    window.vibe.memory.health(project.id).then(setHealth).catch(() => undefined)
  }, [project.id])

  const issues: MemoryHealthIssue[] = !health
    ? []
    : scope === 'global'
      ? health.global.issues
      : [...health.project.issues, ...health.global.issues.filter((i) => (i.facts ?? []).some((f) => f.project === project.name))]
  const checkedAt = scope === 'global' ? health?.global.checkedAt ?? null : health?.project.checkedAt ?? null

  const checkNow = async (): Promise<void> => {
    setBusy('check')
    setNote('')
    try {
      const h = await window.vibe.memory.healthCheck(project.id)
      setHealth(h)
      const n = scope === 'global' ? h.global.issues.length : h.project.issues.length
      setNote(n ? '' : 'Nothing to fix.')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }

  const apply = async (issue: MemoryHealthIssue, action: MemoryHealthAction): Promise<void> => {
    setBusy(issue.id)
    try {
      const r = await window.vibe.memory.healthApply(project.id, issue.scope, issue.id, action)
      setHealth(r.health)
      setNote(r.message)
      onChanged()
    } catch (err) {
      fail(err)
      window.vibe.memory.health(project.id).then(setHealth).catch(() => undefined)
    } finally {
      setBusy(null)
    }
  }

  const dismiss = async (issue: MemoryHealthIssue): Promise<void> => {
    setBusy(issue.id)
    try {
      setHealth(await window.vibe.memory.healthDismiss(project.id, issue.scope, issue.id))
      setNote('Dismissed: it won\'t be suggested again.')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }

  return (
    <details className="memory-health" open={open ?? issues.length > 0} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        Health: {issues.length ? `${issues.length} suggestion${issues.length === 1 ? '' : 's'}` : 'nothing to fix'} ({checkedLine(checkedAt)})
      </summary>
      <p className="memory-hint">
        Once a day, Starwright looks over what's saved for things that go wrong: the brief repeating its own instructions, a
        fact saved twice, a test step saved as a procedure, the same lesson in several projects. Nothing changes until you
        choose a fix.
      </p>
      <div className="memory-health-toolbar">
        <button onClick={checkNow} disabled={busy !== null}>
          {busy === 'check' ? 'Checking…' : 'Check now'}
        </button>
        {note && <span className="memory-hint">{note}</span>}
      </div>
      <ul className="memory-health-list">
        {issues.map((issue) => (
          <li key={issue.id} className="memory-health-issue">
            <strong>{issue.title}</strong>
            <span className="memory-hint">{issue.detail}</span>
            {issue.facts && issue.facts.length > 0 && (
              <ul className="memory-health-facts">
                {issue.facts.map((f) => (
                  <li key={f.id}>
                    {f.key ? '★ ' : ''}
                    {f.project ? <span className="memory-meta">{f.project}: </span> : null}
                    {f.text}
                  </li>
                ))}
              </ul>
            )}
            {issue.lines && issue.lines.length > 0 && (
              <ul className="memory-health-facts">
                {issue.lines.map((l, i) => (
                  <li key={i}>
                    <s>{l.line}</s> <span className="memory-meta">({l.why})</span>
                  </li>
                ))}
              </ul>
            )}
            {issue.proposed && PROPOSED_LABELS[issue.kind] && (
              <details className="memory-health-proposed" open={issue.kind !== 'brief'}>
                <summary>{PROPOSED_LABELS[issue.kind]}</summary>
                <pre>{issue.proposed}</pre>
              </details>
            )}
            <div className="memory-row-actions">
              {issue.actions.map((a) => (
                <button key={a} onClick={() => apply(issue, a)} disabled={busy !== null}>
                  {ACTION_LABELS[a]}
                </button>
              ))}
              <button onClick={() => dismiss(issue)} disabled={busy !== null} title="Leave it as it is and don't suggest it again">
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </details>
  )
}
