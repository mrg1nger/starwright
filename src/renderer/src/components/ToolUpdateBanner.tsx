import { useEffect, useState } from 'react'
import type { AppSettings, ToolId, ToolVersions } from '@shared/types'
import { TOOL_UPDATE_COMMANDS, toolNotices } from '@shared/update'

interface ToolUpdateBannerProps {
  settings: AppSettings
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>
}

export const TOOL_NAMES: Record<ToolId, string> = { codex: 'Codex', cline: 'Cline', claude: 'Claude Agent SDK' }

/**
 * Says when a newer Codex or Cline is out than the one installed. It only says so: an update can
 * change what Starwright reads from them, so updating is the user's call (in a terminal).
 */
function ToolUpdateBanner({ settings, onSettingsChange }: ToolUpdateBannerProps) {
  const [versions, setVersions] = useState<ToolVersions | null>(null)
  /** "Not now": the versions hidden until Starwright next starts. */
  const [dismissed, setDismissed] = useState<string | null>(null)
  const where = window.vibe.host === 'browser' ? 'on the computer running Starwright' : 'in a terminal'

  useEffect(() => {
    window.vibe.tools.versions().then(setVersions).catch(() => undefined)
    return window.vibe.tools.onChanged(setVersions)
  }, [])

  const notices = toolNotices(versions, settings.skippedToolVersions)
  const key = notices.map((t) => `${t.tool}@${t.latest}`).join(',')
  if (!notices.length || dismissed === key) return null

  const skip = (): void => {
    const next = { ...settings.skippedToolVersions }
    for (const t of notices) next[t.tool] = t.latest
    onSettingsChange({ skippedToolVersions: next }).catch(() => undefined)
  }

  return (
    <div className="github-banner tool-banner" role="status">
      <div>
        {notices.map((t) => (
          <div key={t.tool}>
            <strong>
              {TOOL_NAMES[t.tool]} {t.latest} is out
            </strong>{' '}
            (Starwright is using {t.installed}). To update, run <code>{TOOL_UPDATE_COMMANDS[t.tool]}</code> {where} while
            nothing is running.
          </div>
        ))}
        <small>A new version can change what Starwright relies on, so try a small task afterwards.</small>
      </div>
      <div className="github-banner-actions">
        <button title="No reminder for these versions. A newer one will still show." onClick={skip}>
          {notices.length > 1 ? 'Skip these versions' : 'Skip this version'}
        </button>
        <button aria-label="Not now" title="Hide until Starwright next starts" onClick={() => setDismissed(key)}>
          Not now
        </button>
      </div>
    </div>
  )
}

export default ToolUpdateBanner
