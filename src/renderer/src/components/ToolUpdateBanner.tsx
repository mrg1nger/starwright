import { useEffect, useState } from 'react'
import type { AppSettings, ToolId, ToolUpdateState, ToolVersion, ToolVersions } from '@shared/types'
import { TOOL_UPDATE_COMMANDS, UPDATE_RUNNING, toolNotices } from '@shared/update'

interface ToolUpdateBannerProps {
  settings: AppSettings
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>
}

export const TOOL_NAMES: Record<ToolId, string> = { codex: 'Codex', cline: 'Cline', claude: 'Claude Agent SDK' }

type Updatable = 'codex' | 'cline'
const UPDATABLE: Updatable[] = ['codex', 'cline']

/** An error from the main process, without Electron's "Error invoking remote method" wrapping. */
function plain(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** The Codex and Cline versions, kept up to date (an update's progress comes the same way). */
export function useToolVersions(): [ToolVersions | null, (v: ToolVersions) => void] {
  const [versions, setVersions] = useState<ToolVersions | null>(null)
  useEffect(() => {
    window.vibe.tools.versions().then(setVersions).catch(() => undefined)
    return window.vibe.tools.onChanged(setVersions)
  }, [])
  return [versions, setVersions]
}

/** Any Codex or Cline update under way (one at a time). */
export function updateRunning(v: ToolVersions | null): boolean {
  return UPDATABLE.some((t) => {
    const s = v?.updates?.[t]
    return !!s && UPDATE_RUNNING.includes(s.phase)
  })
}

/** The Update button for a newer version (or how to update when Starwright can't). */
export function ToolUpdateButton({ tool, busy }: { tool: ToolVersion; busy: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const where = window.vibe.host === 'browser' ? 'on the computer running Starwright' : 'in a terminal'
  if (tool.bundled || !tool.latest) return null
  if (tool.npm === false) {
    return <span className="settings-hint">It wasn&apos;t installed with npm here, so update it the way you installed it.</span>
  }
  if (tool.npm === undefined) {
    return (
      <span>
        To update, run <code>{TOOL_UPDATE_COMMANDS[tool.tool]}</code> {where}.
      </span>
    )
  }
  const update = (): void => {
    setError(null)
    window.vibe.tools.update(tool.tool as Updatable, tool.latest!).catch((err) => setError(plain(err)))
  }
  return (
    <>
      <button
        type="button"
        className="github-banner-primary"
        disabled={busy}
        title={`Installs ${TOOL_NAMES[tool.tool]} ${tool.latest} once nothing is running on it, then checks it works with Starwright`}
        onClick={update}
      >
        Update {TOOL_NAMES[tool.tool]}
      </button>
      {error && <span className="settings-warn">{error}</span>}
    </>
  )
}

/** Where an update has got to, and the user's choices when the new version failed its check. */
export function ToolUpdateStatus({ tool, state }: { tool: Updatable; state: ToolUpdateState }) {
  const [error, setError] = useState<string | null>(null)
  const name = TOOL_NAMES[tool]
  const act = (call: Promise<unknown>): void => {
    setError(null)
    call.catch((err) => setError(plain(err)))
  }
  if (UPDATE_RUNNING.includes(state.phase)) {
    return (
      <div className="tool-update" data-phase={state.phase}>
        <strong>{name}:</strong> {state.message ?? 'Updating…'}
      </div>
    )
  }
  if (state.phase === 'failed') {
    return (
      <div className="tool-update" data-phase="failed">
        <strong>
          {name} {state.to} failed Starwright&apos;s check.
        </strong>{' '}
        {state.message}
        <ul>
          {(state.problems ?? []).map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <small>
          {name} isn&apos;t given work until you choose. If the problem is your plan or sign-in rather than the update,
          sort that out and check again, or keep it.
        </small>
        <div className="github-banner-actions">
          {state.from && (
            <button type="button" className="github-banner-primary" onClick={() => act(window.vibe.tools.rollBack(tool))}>
              Put {state.from} back
            </button>
          )}
          <button type="button" onClick={() => act(window.vibe.tools.recheck(tool))}>
            Check again
          </button>
          <button type="button" onClick={() => act(window.vibe.tools.keep(tool))}>
            Keep {state.to}
          </button>
        </div>
        {error && <span className="settings-warn">{error}</span>}
      </div>
    )
  }
  return (
    <div className="tool-update" data-phase={state.phase}>
      <span className={state.phase === 'error' ? 'settings-warn' : undefined}>
        {state.phase === 'error' ? `${name} wasn't updated: ` : ''}
        {state.message}
      </span>{' '}
      <button type="button" aria-label={`OK, ${name}`} onClick={() => act(window.vibe.tools.dismiss(tool))}>
        OK
      </button>
      {error && <span className="settings-warn">{error}</span>}
    </div>
  )
}

/**
 * Says when a newer Codex or Cline is out than the one installed, with an Update button. Never
 * updates by itself: an update can change what Starwright relies on, so the user chooses when,
 * and the new version is checked afterwards (with the old one a click away if it fails).
 */
function ToolUpdateBanner({ settings, onSettingsChange }: ToolUpdateBannerProps) {
  const [versions] = useToolVersions()
  /** "Not now": the versions hidden until Starwright next starts. */
  const [dismissed, setDismissed] = useState<string | null>(null)

  const updates = versions?.updates ?? {}
  const shown = UPDATABLE.filter((t) => updates[t])
  const notices = toolNotices(versions, settings.skippedToolVersions).filter((t) => !updates[t.tool])
  const key = notices.map((t) => `${t.tool}@${t.latest}`).join(',')
  const showNotices = notices.length > 0 && dismissed !== key
  if (!shown.length && !showNotices) return null
  const busy = updateRunning(versions)
  const failed = shown.some((t) => updates[t]?.phase === 'failed')

  const skip = (): void => {
    const next = { ...settings.skippedToolVersions }
    for (const t of notices) next[t.tool] = t.latest
    onSettingsChange({ skippedToolVersions: next }).catch(() => undefined)
  }

  return (
    <div className={`github-banner tool-banner${failed ? ' github-banner-conflict' : ''}`} role="status">
      <div>
        {shown.map((t) => (
          <ToolUpdateStatus key={t} tool={t} state={updates[t]!} />
        ))}
        {showNotices &&
          notices.map((t) => (
            <div key={t.tool} className="tool-notice">
              <strong>
                {TOOL_NAMES[t.tool]} {t.latest} is out
              </strong>{' '}
              (Starwright is using {t.installed}
              {t.untested ? `; it was tested up to ${t.testedWith}, so this version is new to it` : ''}).{' '}
              {t.notesUrl && (
                <a href={t.notesUrl} target="_blank" rel="noreferrer">
                  What&apos;s new
                </a>
              )}{' '}
              <ToolUpdateButton tool={t} busy={busy} />
            </div>
          ))}
        {showNotices && (
          <small>
            Update waits for running work to finish, then checks the new version works with Starwright (a short run on
            your plan) and offers to put the old one back if it doesn&apos;t.
          </small>
        )}
      </div>
      {showNotices && (
        <div className="github-banner-actions">
          <button title="No reminder for these versions. A newer one will still show." onClick={skip}>
            {notices.length > 1 ? 'Skip these versions' : 'Skip this version'}
          </button>
          <button aria-label="Not now" title="Hide until Starwright next starts" onClick={() => setDismissed(key)}>
            Not now
          </button>
        </div>
      )}
    </div>
  )
}

export default ToolUpdateBanner
