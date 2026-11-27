import { useEffect, useState } from 'react'
import type { AppSettings, UpdateState } from '@shared/types'
import { isNewer } from '@shared/update'
import { TOOL_NAMES, ToolUpdateButton, ToolUpdateStatus, updateRunning, useToolVersions } from './ToolUpdateBanner'

interface UpdateSettingsProps {
  settings: AppSettings
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>
}

/** The running version, a check for a newer one on GitHub Releases, and a skipped version to bring back. */
function UpdateSettings({ settings, onSettingsChange }: UpdateSettingsProps) {
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    window.vibe.update.state().then(setUpdate).catch(() => undefined)
    return window.vibe.update.onChanged(setUpdate)
  }, [])

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      setUpdate(await window.vibe.update.check())
      setChecked(true)
    } finally {
      setChecking(false)
    }
  }

  const newer = update?.version && isNewer(update.version, update.current) ? update.version : null
  const result = !checked || !update
    ? null
    : newer
      ? { ok: true, text: `Starwright ${newer} is available${newer === settings.skippedVersion ? ' (skipped)' : ''}.` }
      : update.error
        ? { ok: false, text: update.error }
        : { ok: true, text: "You're on the newest version." }

  return (
    <section className="settings-section">
      <h3>Updates</h3>
      <p className="settings-hint">
        Starwright {__APP_VERSION__}.{' '}
        <a href={update?.releasesUrl ?? 'https://github.com/mrg1nger/starwright/releases'} target="_blank" rel="noreferrer">
          All releases
        </a>
      </p>
      {update?.canInstall === false ? (
        <p className="settings-hint">Running from source: update with git pull instead.</p>
      ) : (
        <div className="settings-row">
          <button type="button" onClick={check} disabled={checking}>
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
          {result && <span className={result.ok ? 'settings-ok' : 'settings-warn'}>{result.text}</span>}
        </div>
      )}
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={settings.updateChecks}
          onChange={(e) => onSettingsChange({ updateChecks: e.target.checked }).catch(() => undefined)}
        />
        <span>
          Look for new versions automatically
          <small>
            When Starwright starts and every few hours, it asks GitHub whether there&apos;s a newer version and shows a
            banner. Nothing is downloaded until you press Update. Twice a day it also asks npm whether there&apos;s a
            newer Codex or Cline than the one installed, and says so: they&apos;re only updated when you press Update.
          </small>
        </span>
      </label>
      {settings.skippedVersion && (
        <div className="settings-row">
          <span className="settings-hint">Skipped: version {settings.skippedVersion}.</span>
          <button type="button" onClick={() => onSettingsChange({ skippedVersion: null }).catch(() => undefined)}>
            Remind me again
          </button>
        </div>
      )}
      <ToolVersionList settings={settings} onSettingsChange={onSettingsChange} />
    </section>
  )
}

/** Codex, Cline and the built-in Claude SDK: the version in use and the newest on npm. */
function ToolVersionList({ settings, onSettingsChange }: UpdateSettingsProps) {
  const [versions, setVersions] = useToolVersions()
  const [checking, setChecking] = useState(false)
  const busy = updateRunning(versions)

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      setVersions(await window.vibe.tools.check())
    } catch {
      // Shown as before.
    } finally {
      setChecking(false)
    }
  }

  const skipped = Object.entries(settings.skippedToolVersions ?? {}).filter(([, v]) => v)

  return (
    <div className="tool-versions">
      <p className="settings-hint">
        Tools Starwright works through. It never updates Codex or Cline by itself. Update installs the newest one once
        nothing is running on it, then checks it still works with Starwright (a short run on your plan), and offers to
        put the old one back if it doesn&apos;t.
      </p>
      <ul className="settings-hint">
        {(versions?.tools ?? []).map((t) => (
          <li key={t.tool}>
            {TOOL_NAMES[t.tool]} {t.installed ?? (t.bundled ? '' : 'isn\'t installed')}
            {t.bundled && ' (built into Starwright)'}
            {t.installed &&
              (t.newer
                ? t.bundled
                  ? `: ${t.latest} is out, and comes with a Starwright update.`
                  : `: ${t.latest} is out.`
                : t.latest
                  ? ': the newest.'
                  : t.error
                    ? `: couldn't ask npm (${t.error}).`
                    : '')}
            {!t.bundled && t.newer && t.untested && (
              <span className="settings-warn"> Not yet tested with Starwright (tested up to {t.testedWith}).</span>
            )}
            {!t.bundled && t.newer && t.notesUrl && (
              <>
                {' '}
                <a href={t.notesUrl} target="_blank" rel="noreferrer">
                  What&apos;s new
                </a>
              </>
            )}
            {!t.bundled && t.newer && !versions?.updates?.[t.tool] && (
              <div className="settings-row">
                <ToolUpdateButton tool={t} busy={busy} />
              </div>
            )}
            {(t.tool === 'codex' || t.tool === 'cline') && versions?.updates?.[t.tool] && (
              <ToolUpdateStatus tool={t.tool} state={versions.updates[t.tool]!} />
            )}
          </li>
        ))}
        {!versions?.tools.length && <li>Not checked yet.</li>}
      </ul>
      <div className="settings-row">
        <button type="button" onClick={check} disabled={checking}>
          {checking ? 'Checking…' : 'Check tools'}
        </button>
        {skipped.length > 0 && (
          <>
            <span className="settings-hint">
              Skipped: {skipped.map(([tool, v]) => `${TOOL_NAMES[tool as keyof typeof TOOL_NAMES]} ${v}`).join(', ')}.
            </span>
            <button type="button" onClick={() => onSettingsChange({ skippedToolVersions: {} }).catch(() => undefined)}>
              Remind me again
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default UpdateSettings
