import { useEffect, useState } from 'react'
import type { RouteWork, WorkRoute } from '@shared/types'

const ROUTES: { id: WorkRoute; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'cline', label: 'Cline' },
  { id: 'local', label: 'Local model' }
]

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** How one route's work went: hand-offs that failed, checks that failed, serious review findings. */
function quality(w: RouteWork): string {
  const parts: string[] = []
  const h = w.handoffs
  if (h.total) {
    parts.push(`${plural(h.total, 'hand-off')}${h.failed ? `, ${h.failed} failed` : ''}`)
    if (h.checksRun) parts.push(`checks failed ${h.checksFailed} of ${h.checksRun}`)
  }
  if (w.reviewed.total) parts.push(`serious review findings in ${w.reviewed.serious} of ${w.reviewed.total}`)
  return parts.join(' · ')
}

/**
 * Who did the work over the last week: each route's share of the building, with what else
 * it did and how its work went. The meters the work equalizer's faders will sit beside.
 */
function WorkMeters({ days = 7 }: { days?: number }) {
  const [work, setWork] = useState<Record<WorkRoute, RouteWork> | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    window.vibe.usage
      .work(days)
      .then(setWork)
      .catch(() => setFailed(true))
  }, [days])

  if (failed) return null
  if (!work) return <p className="memory-hint">Loading…</p>
  const builds = ROUTES.reduce((n, r) => n + work[r.id].build, 0)

  return (
    <div className="work-meters">
      <h4>Who did the work (last {days} days)</h4>
      {builds === 0 && <p className="memory-hint">No building recorded yet in this period.</p>}
      <ul>
        {ROUTES.map(({ id, label }) => {
          const w = work[id]
          const share = builds ? w.build / builds : 0
          const did = [
            w.lead ? `in charge of ${plural(w.lead, 'request')}` : '',
            w.review ? plural(w.review, 'review') : '',
            w.background ? plural(w.background, 'background job') : ''
          ].filter(Boolean)
          const how = quality(w)
          const detail = [`${label}: ${plural(w.build, 'piece')} of building`, ...did, how].filter(Boolean).join('\n')
          return (
            <li key={id} title={detail}>
              <span className="work-meter-label">{label}</span>
              <span
                className="work-meter-track"
                role="meter"
                aria-label={`${label}'s share of the building`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(share * 100)}
              >
                <span className="work-meter-fill" style={{ width: `${share * 100}%` }} />
              </span>
              <span className="work-meter-value">
                {builds ? `${Math.round(share * 100)}%` : '-'} <small>({w.build})</small>
              </span>
              {(did.length > 0 || how) && (
                <small className="work-meter-detail">{[did.join(' · '), how].filter(Boolean).join(' — ')}</small>
              )}
            </li>
          )
        })}
      </ul>
      <small className="memory-hint">
        Bars: each one's share of the building (Claude editing files itself, or a hand-off it carried out). Hover a row for
        the detail. Quality is recorded from 0.13.0 on: hand-offs whose checks failed, and what Codex's reviews found.
      </small>
    </div>
  )
}

export default WorkMeters
