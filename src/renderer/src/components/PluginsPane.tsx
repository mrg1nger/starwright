import { useCallback, useEffect, useRef, useState } from 'react'
import { PLUGIN_PERMISSIONS, type OpenedPanel, type PluginInfo, type PluginList } from '@shared/plugins'

const inBrowser = window.vibe.host === 'browser'

const cleanError = (err: unknown): string => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

interface Props {
  projectId: string
}

/** The project's plugins (and those for every project): approve them, open their panels. */
export default function PluginsPane({ projectId }: Props) {
  const [list, setList] = useState<PluginList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [panel, setPanel] = useState<(OpenedPanel & { key: string; panelId: string }) | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    setPanel(null)
  }, [projectId])

  useEffect(() => {
    if (inBrowser) return
    let current = true
    window.vibe.plugins
      .list(projectId)
      .then((l) => {
        if (!current) return
        setList(l)
        setError(null)
      })
      .catch((err) => current && setError(cleanError(err)))
    return () => {
      current = false
    }
  }, [projectId, reload])

  const act = useCallback(async (key: string, action: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await action()
      setError(null)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(null)
      setReload((n) => n + 1)
    }
  }, [])

  const openPanel = useCallback(
    async (key: string, panelId: string) => {
      try {
        setPanel({ ...(await window.vibe.plugins.openPanel(projectId, key, panelId)), key, panelId })
        setError(null)
      } catch (err) {
        setError(cleanError(err))
        setReload((n) => n + 1)
      }
    },
    [projectId]
  )

  if (inBrowser) {
    return (
      <div className="files-pane plugins-pane">
        <div className="files-empty">Plugins are approved and opened on the computer running Starwright, for now.</div>
      </div>
    )
  }

  if (panel) {
    return (
      <div className="files-pane plugins-pane">
        <div className="files-bar">
          <button onClick={() => setPanel(null)} title="Back to the list of plugins">
            ← Plugins
          </button>
          <span className="plugin-panel-title" title={`${panel.pluginTitle}: ${panel.title}`}>
            {panel.pluginTitle} · {panel.title}
          </span>
          <button onClick={() => void openPanel(panel.key, panel.panelId)} title="Load the panel again" aria-label="Reload the panel">
            ↻
          </button>
        </div>
        <PluginFrame key={panel.token} panel={panel} />
      </div>
    )
  }

  return (
    <div className="files-pane plugins-pane">
      <div className="files-bar">
        <span className="plugin-panel-title">🧩 Plugins</span>
        <button onClick={() => void act('folder', () => window.vibe.plugins.openFolder(projectId, 'project'))} title="Open this project's plugins folder">
          Open folder
        </button>
        <button onClick={() => setReload((n) => n + 1)} title="Look for plugins again" aria-label="Refresh the plugin list">
          ↻
        </button>
      </div>
      <div className="plugins-list">
        {error && <div className="plugin-error">{error}</div>}
        {!list && !error && <div className="files-empty">Loading…</div>}
        {list && !list.plugins.length && (
          <div className="files-empty">
            <p>No plugins yet. A plugin adds something Starwright doesn't have, like a dashboard for this project. You, Claude or Codex can write one.</p>
            {list.canAddExample && (
              <p>
                <button onClick={() => void act('example', () => window.vibe.plugins.addExample())} disabled={busy === 'example'}>
                  Add the Project Pulse example
                </button>
              </p>
            )}
          </div>
        )}
        {list?.plugins.map((plugin) => (
          <PluginCard
            key={plugin.key}
            plugin={plugin}
            busy={busy === plugin.key}
            onApprove={() => void act(plugin.key, () => window.vibe.plugins.approve(projectId, plugin.key, plugin.hash ?? ''))}
            onSetOff={(off) => void act(plugin.key, () => window.vibe.plugins.setOff(projectId, plugin.key, off))}
            onOpen={(panelId) => void openPanel(plugin.key, panelId)}
          />
        ))}
        {list && list.plugins.length > 0 && list.canAddExample && (
          <div className="files-empty">
            <button onClick={() => void act('example', () => window.vibe.plugins.addExample())} disabled={busy === 'example'}>
              Add the Project Pulse example
            </button>
          </div>
        )}
        {list && (
          <div className="plugin-where">
            Plugins in <code>.starwright/plugins</code> are this project's own (and go in git with it); plugins in Starwright's{' '}
            <button className="link-button" onClick={() => void act('folder', () => window.vibe.plugins.openFolder(projectId, 'global'))}>
              plugins folder
            </button>{' '}
            are for every project. How to write one: <code>docs/plugins.md</code>.
          </div>
        )}
      </div>
    </div>
  )
}

const STATUS_WORDS: Record<PluginInfo['status'], string> = {
  'needs-approval': 'Needs your approval',
  changed: 'Changed since you approved it',
  approved: 'Ready',
  off: 'Turned off',
  broken: 'Has problems'
}

function PluginCard({
  plugin,
  busy,
  onApprove,
  onSetOff,
  onOpen
}: {
  plugin: PluginInfo
  busy: boolean
  onApprove: () => void
  onSetOff: (off: boolean) => void
  onOpen: (panelId: string) => void
}) {
  const m = plugin.manifest
  const asking = plugin.status === 'needs-approval' || plugin.status === 'changed'
  return (
    <div className={`plugin-card plugin-${plugin.status}`}>
      <div className="plugin-head">
        <strong>{m?.title ?? plugin.name}</strong>
        {m && <span className="plugin-version">{m.version}</span>}
        <span className="plugin-scope">{plugin.scope === 'project' ? 'this project' : 'every project'}</span>
        <span className="plugin-status">{STATUS_WORDS[plugin.status]}</span>
      </div>
      {m?.description && <div className="plugin-description">{m.description}</div>}
      {plugin.status === 'broken' && (
        <ul className="plugin-problems">
          {plugin.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {asking && m && (
        <div className="plugin-approval">
          {plugin.status === 'changed' && (
            <p>
              Its files {plugin.newPermissions.length ? 'or what it asks for ' : ''}changed since you approved it
              {plugin.approvedAt ? ` on ${new Date(plugin.approvedAt).toLocaleDateString()}` : ''}. It won't open until you approve it again.
            </p>
          )}
          {m.permissions.length ? (
            <>
              <p>It asks to:</p>
              <ul>
                {m.permissions.map((p) => (
                  <li key={p}>
                    {PLUGIN_PERMISSIONS[p]}
                    {plugin.status === 'changed' && plugin.newPermissions.includes(p) && <span className="plugin-new"> new</span>}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>It asks for nothing: it can only show its own page.</p>
          )}
          <p className="plugin-note">
            It runs in a locked-down frame beside the chat: no internet, no access to the rest of the computer, your keys or Starwright's settings, only what's listed here.
          </p>
          <button className="primary" onClick={onApprove} disabled={busy}>
            {plugin.status === 'changed' ? 'Approve again' : 'Approve'}
          </button>
        </div>
      )}
      {plugin.status === 'approved' && m && (
        <div className="plugin-actions">
          {m.panels.map((p) => (
            <button key={p.id} className="primary" onClick={() => onOpen(p.id)}>
              Open {p.title}
            </button>
          ))}
          <button onClick={() => onSetOff(true)} disabled={busy} title="It stays approved; turn it on again any time">
            Turn off
          </button>
        </div>
      )}
      {plugin.status === 'off' && (
        <div className="plugin-actions">
          <button onClick={() => onSetOff(false)} disabled={busy}>
            Turn on
          </button>
        </div>
      )}
    </div>
  )
}

// ---- the panel's frame --------------------------------------------------------------------------

/** Starwright's theme for a panel, as --sw-* variables (see docs/plugins.md). */
const THEME_MAP: Record<string, string> = {
  '--sw-bg': '--surface',
  '--sw-surface': '--surface-raised',
  '--sw-sunken': '--surface-sunken',
  '--sw-text': '--text',
  '--sw-muted': '--text-muted',
  '--sw-border': '--border',
  '--sw-accent': '--accent',
  '--sw-accent-text': '--accent-text',
  '--sw-good': '--success-text',
  '--sw-warn': '--warning-text',
  '--sw-bad': '--danger',
  '--sw-font': '--font',
  '--sw-radius': '--radius'
}

function themeNow(probe: HTMLElement): { vars: Record<string, string>; dark: boolean } {
  const style = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (const [to, from] of Object.entries(THEME_MAP)) vars[to] = style.getPropertyValue(from).trim()
  // Dark or light, from how bright the surface is.
  const [r, g, b] = (getComputedStyle(probe).backgroundColor.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).map(Number)
  return { vars, dark: 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 }
}

/** Calls a panel may have waiting at once. */
const MAX_WAITING = 32

function PluginFrame({ panel }: { panel: OpenedPanel }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const probe = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let waiting = 0
    const send = (message: Record<string, unknown>): void => frame.current?.contentWindow?.postMessage({ starwright: 1, ...message }, '*')
    // Only messages from this panel's own frame, answered with its own token.
    const onMessage = (event: MessageEvent): void => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const data = event.data as { starwright?: number; id?: unknown; method?: unknown; args?: unknown }
      if (!data || data.starwright !== 1 || typeof data.id !== 'number' || typeof data.method !== 'string') return
      const id = data.id
      const method = data.method
      if (waiting >= MAX_WAITING) return send({ id, error: 'Too many calls at once: wait for some to finish.' })
      waiting++
      window.vibe.plugins
        .call(panel.token, method, Array.isArray(data.args) ? data.args : [])
        .then((result) => send({ id, result: method === 'hello' && probe.current ? { ...(result as object), theme: themeNow(probe.current) } : result }))
        .catch((err) => send({ id, error: cleanError(err) }))
        .finally(() => waiting--)
    }
    window.addEventListener('message', onMessage)
    const observer = new MutationObserver(() => {
      if (probe.current) send({ event: 'theme', theme: themeNow(probe.current) })
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    return () => {
      window.removeEventListener('message', onMessage)
      observer.disconnect()
    }
  }, [panel.token])

  useEffect(() => () => void window.vibe.plugins.closePanel(panel.token).catch(() => undefined), [panel.token])

  return (
    <>
      <span ref={probe} className="plugin-theme-probe" aria-hidden="true" />
      <iframe
        ref={frame}
        className="plugin-frame"
        src={panel.url}
        // Scripts only: no same-origin (it can't reach Starwright's page), no pop-ups, forms or navigating the app.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={`${panel.pluginTitle}: ${panel.title}`}
      />
    </>
  )
}
