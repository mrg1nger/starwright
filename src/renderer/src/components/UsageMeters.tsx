import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'
import type { AppSettings, CliName, CliStatus, LmStudioStatus, UsageSnapshot, UsageSource } from '@shared/types'

interface UsageMetersProps {
  statuses: Record<CliName, CliStatus>
  /** Shown before the meters (the work equalizer). */
  children?: ReactNode
}

const POLL_INTERVAL_MS = 3 * 60_000
const CLIS: { cli: UsageSource; name: string }[] = [
  { cli: 'claude', name: 'Claude' },
  { cli: 'codex', name: 'Codex' },
  // ClinePass: shown once a Cline API key is saved (Settings → Cline).
  { cli: 'cline', name: 'Cline' }
]

/** Fired by Settings when the Cline API key changes, so the meter appears (or goes) at once. */
export const USAGE_CHANGED_EVENT = 'starwright:usage-changed'

const SHORT_LABELS: Record<string, string> = { '5-hour': '5h', Weekly: 'wk', Monthly: 'mo' }

function formatReset(resetsAt: number | null): string {
  if (!resetsAt) return ''
  const mins = Math.max(0, Math.round((resetsAt - Date.now()) / 60_000))
  if (mins < 60) return `resets in ${mins}m`
  if (mins < 48 * 60) return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`
  return `resets ${new Date(resetsAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`
}

function levelClass(usedPercent: number): string {
  if (usedPercent >= 90) return 'usage-danger'
  if (usedPercent >= 75) return 'usage-warning'
  return ''
}

const LOCAL_POLL_MS = 30_000

/** "qwen/qwen3.6-35b-a3b" → "qwen3.6-35b-a3b": the publisher prefix only takes room. */
function shortModel(id: string): string {
  return id.split('/').pop() || id
}

/**
 * The local model (LM Studio): a green or red light for whether its server answers, and the model
 * loaded. Shown only when the local model is in use (background jobs or coding hand-offs turned on).
 */
function LocalModelIndicator() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [status, setStatus] = useState<LmStudioStatus | null>(null)
  const inUse = !!settings && (settings.lmStudioHelpers || settings.localHandoffs)

  useEffect(() => {
    window.vibe.settings.get().then(setSettings).catch(() => undefined)
    return window.vibe.settings.onChanged(setSettings)
  }, [])

  const refresh = useCallback(() => {
    window.vibe.lmStudio
      .status()
      .then(setStatus)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!inUse) return
    refresh()
    const interval = setInterval(refresh, LOCAL_POLL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', refresh)
    }
  }, [inUse, settings?.lmStudioUrl, refresh])

  if (!inUse) return null
  const online = !!status?.running
  const loaded = status?.models.filter((m) => m.loaded) ?? []
  const chosen = settings?.lmStudioModel ?? null
  // The model Starwright uses: the one picked in Settings, else the first one loaded.
  const model = chosen ? (loaded.find((m) => m.id === chosen) ?? null) : (loaded[0] ?? null)
  const label = !status
    ? 'Checking…'
    : !online
      ? 'Offline'
      : model
        ? shortModel(model.id)
        : chosen
          ? `${shortModel(chosen)} (not loaded)`
          : 'No model loaded'
  const tooltip = !status
    ? 'Checking the local model…'
    : [
        online ? `LM Studio is answering at ${status.url}` : (status.error ?? `LM Studio isn't answering at ${status.url}.`),
        ...(online
          ? [
              loaded.length ? `Loaded: ${loaded.map((m) => m.id).join(', ')}` : 'No model loaded (LM Studio loads one on first use, which takes a while).',
              ...(model?.contextLength ? [`Context: ${model.contextLength.toLocaleString()} tokens`] : [])
            ]
          : []),
        'Click to check again'
      ].join('\n')
  const light = !status ? '' : online ? 'local-model-online' : 'local-model-offline'

  return (
    <button className={`usage-meter local-model ${light}`} title={tooltip} onClick={refresh} aria-label={`Local model: ${online ? 'online' : 'offline'}, ${label}`}>
      <span className="local-model-light" aria-hidden="true" />
      <span className="local-model-text">
        <span className="usage-meter-name">Local</span>
        <span className="local-model-name">{label}</span>
      </span>
    </button>
  )
}

/** Compact plan-usage bars for Claude, Codex and ClinePass, shown in the top bar. */
function UsageMeters({ statuses, children }: UsageMetersProps) {
  const [usage, setUsage] = useState<Partial<Record<UsageSource, UsageSnapshot>>>({})

  const refresh = useCallback(
    (force = false) => {
      for (const { cli } of CLIS) {
        if (cli !== 'cline' && statuses[cli].status !== 'logged_in') continue
        window.vibe.usage
          .get(cli, force)
          .then((snapshot) => setUsage((prev) => ({ ...prev, [cli]: snapshot })))
          .catch(() => undefined)
      }
    },
    [statuses.claude.status, statuses.codex.status] // eslint-disable-line react-hooks/exhaustive-deps
  )

  useEffect(() => {
    refresh()
    const interval = setInterval(() => refresh(), POLL_INTERVAL_MS)
    const onFocus = (): void => refresh()
    const onChanged = (): void => refresh(true)
    window.addEventListener('focus', onFocus)
    window.addEventListener(USAGE_CHANGED_EVENT, onChanged)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(USAGE_CHANGED_EVENT, onChanged)
    }
  }, [refresh])

  // Usage moves when a turn finishes (Claude's own work and any Codex
  // delegation inside it), so check again then.
  useEffect(
    () =>
      window.vibe.chat.onEvent((_projectId, event) => {
        if (event.type === 'turn_complete') refresh(true)
      }),
    [refresh]
  )

  const shown = CLIS.filter(({ cli }) =>
    cli === 'cline' ? !!usage.cline && usage.cline.status !== 'unavailable' : statuses[cli].status === 'logged_in'
  )

  return (
    <div className="usage-meters">
      {children}
      {shown.map(({ cli, name }) => {
        const snapshot = usage[cli]
        const tooltip = !snapshot
          ? `Checking ${name} usage…`
          : snapshot.status !== 'ok'
            ? `${name} usage unavailable${snapshot.message ? `: ${snapshot.message}` : ''}`
            : [
                `${name}${snapshot.plan ? ` (${snapshot.plan} plan)` : ''}`,
                ...snapshot.windows.map(
                  (w) => `${w.label}: ${Math.round(w.usedPercent)}% used, ${formatReset(w.resetsAt)}`
                ),
                ...(snapshot.stale && snapshot.message ? [snapshot.message] : []),
                'Click to refresh'
              ].join('\n')
        return (
          <Fragment key={cli}>
          <button
            className={`usage-meter${snapshot?.stale ? ' usage-meter-stale' : ''}`}
            title={tooltip}
            onClick={() => refresh(true)}
          >
            <span className="usage-meter-name">{name}</span>
            {/* On a phone: the least left of its windows, next to the name (the bars lose their numbers). */}
            {snapshot?.status === 'ok' && snapshot.windows.length > 0 && (
              <span className={`usage-meter-least ${levelClass(Math.max(...snapshot.windows.map((w) => w.usedPercent)))}`}>
                {Math.max(0, 100 - Math.round(Math.max(...snapshot.windows.map((w) => w.usedPercent))))}%
              </span>
            )}
            <span className="usage-meter-bars">
              {snapshot?.status === 'ok' ? (
                snapshot.windows.map((w) => {
                  const left = Math.max(0, 100 - Math.round(w.usedPercent))
                  return (
                    <span key={w.label} className={`usage-bar-row ${levelClass(w.usedPercent)}`}>
                      <span className="usage-bar-label">{SHORT_LABELS[w.label] ?? w.label}</span>
                      <span className="usage-bar">
                        <span className="usage-bar-fill" style={{ width: `${left}%` }} />
                      </span>
                      <span className="usage-bar-value">{left}%</span>
                    </span>
                  )
                })
              ) : (
                <span className="usage-bar-empty">{snapshot ? '—' : '…'}</span>
              )}
            </span>
          </button>
          </Fragment>
        )
      })}
      <LocalModelIndicator />
    </div>
  )
}

export default UsageMeters
