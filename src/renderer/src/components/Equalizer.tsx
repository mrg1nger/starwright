import { useEffect, useRef, useState } from 'react'
import type { AppSettings, CliName, CliStatus, RouteWork, WorkRoute } from '@shared/types'
import {
  FADER_HELP,
  FADER_LABELS,
  FADER_MAX,
  FADER_PRESETS,
  faderProblem,
  fadersOf,
  presetOf,
  workModeOf,
  type WorkFaders,
  type WorkMode
} from '@shared/balance'

const ROUTES: { id: WorkRoute; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'cline', label: 'Cline' },
  { id: 'local', label: 'Local' }
]

interface EqualizerProps {
  settings: AppSettings
  statuses: Record<CliName, CliStatus>
  onChange: (patch: Partial<AppSettings>) => Promise<void>
}

/** Why a route can't take work whatever its fader says (it isn't set up), or null. */
function notReady(route: WorkRoute, settings: AppSettings, statuses: Record<CliName, CliStatus>): string | null {
  if (route === 'claude') return statuses.claude.status === 'logged_in' ? null : 'not signed in'
  if (route === 'codex') return statuses.codex.status === 'logged_in' ? null : 'not signed in'
  if (route === 'cline') return settings.clineHandoffs ? null : 'hand-offs off in Settings'
  return settings.localHandoffs ? null : 'hand-offs off in Settings'
}

/**
 * The work equalizer: a fader per route (Claude, Codex, Cline, the local model) with a meter beside
 * each showing what it actually did this week, Auto or Manual, and presets. Opens from the top bar.
 */
function Equalizer({ settings, statuses, onChange }: EqualizerProps) {
  const [open, setOpen] = useState(false)
  const [work, setWork] = useState<Record<WorkRoute, RouteWork> | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const mode = workModeOf(settings)
  const faders = fadersOf(settings)
  const preset = presetOf(faders)

  useEffect(() => {
    if (!open) return
    window.vibe.usage
      .work(7)
      .then(setWork)
      .catch(() => setWork(null))
    const away = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  const save = (next: WorkFaders, nextMode: WorkMode = 'manual'): void => {
    const why = faderProblem(next)
    setProblem(why)
    if (why) return
    onChange({ workFaders: next, workMode: nextMode }).catch(() => undefined)
  }

  const builds = work ? ROUTES.reduce((n, r) => n + work[r.id].build, 0) : 0
  const label = mode === 'auto' ? 'Auto' : preset?.label ?? 'Custom'

  return (
    <div className="eq" ref={box}>
      <button
        className={`eq-toggle${open ? ' on' : ''}`}
        aria-expanded={open}
        title={`Who does the work: ${label}${mode === 'manual' ? ` (Claude ${faders.claude}, Codex ${faders.codex}, Cline ${faders.cline}, local ${faders.local})` : ''}. Click to change.`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="eq-bars" aria-hidden>
          {ROUTES.map((r) => (
            <span key={r.id} style={{ height: `${mode === 'auto' ? 50 : 15 + (faders[r.id] / FADER_MAX) * 85}%` }} />
          ))}
        </span>
        {label}
      </button>

      {open && (
        <div className="eq-panel" role="dialog" aria-label="Work equalizer">
          <div className="eq-head">
            <strong>Who does the work</strong>
            <div className="eq-mode" role="radiogroup" aria-label="Mode">
              {(['auto', 'manual'] as const).map((m) => (
                <button
                  key={m}
                  role="radio"
                  aria-checked={mode === m}
                  className={mode === m ? 'on' : ''}
                  onClick={() => (m === 'manual' ? save(faders) : onChange({ workMode: 'auto' }).catch(() => undefined))}
                >
                  {m === 'auto' ? 'Auto' : 'Manual'}
                </button>
              ))}
            </div>
          </div>
          <p className="eq-hint">
            {mode === 'auto'
              ? 'Auto: Starwright leans toward whichever plan has more left, and gives simple parts to the cheaper agents first. Move a fader or pick a preset to set it yourself.'
              : 'Manual: the faders decide. Higher means more of the work; Off means never. The bar under each shows what it actually built in the last 7 days.'}
          </p>

          <div className={`eq-faders${mode === 'auto' ? ' eq-faders-auto' : ''}`}>
            {ROUTES.map(({ id, label: name }) => {
              const level = faders[id]
              const missing = notReady(id, settings, statuses)
              const share = work && builds ? work[id].build / builds : 0
              return (
                <div key={id} className={`eq-channel${missing ? ' eq-channel-missing' : ''}`} title={`${FADER_HELP[id]}${missing ? `\n(${name}: ${missing})` : ''}`}>
                  <span className="eq-level">{FADER_LABELS[level]}</span>
                  <input
                    type="range"
                    min={0}
                    max={FADER_MAX}
                    step={1}
                    value={level}
                    aria-label={`${name}: how much of the work`}
                    aria-valuetext={FADER_LABELS[level]}
                    onChange={(e) => save({ ...faders, [id]: Number(e.target.value) })}
                  />
                  <span className="eq-name">{name}</span>
                  <span className="eq-meter" role="meter" aria-label={`${name}'s share of the building, last 7 days`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
                    <span style={{ width: `${share * 100}%` }} />
                  </span>
                  <small className="eq-share">{work ? (builds ? `${Math.round(share * 100)}%` : '-') : '…'}</small>
                  {missing && <small className="eq-missing">{missing}</small>}
                </div>
              )
            })}
          </div>

          {problem && <p className="eq-problem" role="alert">{problem}</p>}
          {mode === 'manual' && faders.claude === 0 && (
            <p className="eq-hint">Claude is at Off: Codex plans, builds and answers every request, and nothing uses your Claude plan.</p>
          )}

          <div className="eq-presets">
            {FADER_PRESETS.map((p) => (
              <button
                key={p.id}
                className={mode === 'manual' && preset?.id === p.id ? 'on' : ''}
                title={p.help}
                onClick={() => save({ ...p.faders })}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default Equalizer
