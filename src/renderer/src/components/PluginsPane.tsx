import { useCallback, useEffect, useRef, useState } from 'react'
import {
  commandLine,
  describePluginWhen,
  PLUGIN_EVENTS,
  PLUGIN_PERMISSIONS,
  type OpenedPanel,
  type PluginInfo,
  type PluginList,
  type PluginRun
} from '@shared/plugins'

const inBrowser = window.vibe.host === 'browser'

const cleanError = (err: unknown): string => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

interface Props {
  projectId: string
  /** A panel (with chat:draft) put text in the message box. */
  onDraft: (text: string) => void
}

/** The project's plugins (and those for every project): approve them, open their panels, run their commands. */
export default function PluginsPane({ projectId, onDraft }: Props) {
  const [list, setList] = useState<PluginList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [panel, setPanel] = useState<(OpenedPanel & { key: string; panelId: string }) | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    setPanel(null)
  }, [projectId])

  useEffect(() => {
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

  // A run started or finished, a plugin was turned off, or an agent changed one.
  useEffect(() => window.vibe.plugins.onChanged((id) => id === projectId && setReload((n) => n + 1)), [projectId])

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
        <PluginFrame key={panel.token} panel={panel} onDraft={onDraft} />
      </div>
    )
  }

  const paused = list?.paused
  return (
    <div className="files-pane plugins-pane">
      <div className="files-bar">
        <span className="plugin-panel-title">🧩 Plugins</span>
        {!inBrowser && (
          <button onClick={() => void act('folder', () => window.vibe.plugins.openFolder(projectId, 'project'))} title="Open this project's plugins folder">
            Open folder
          </button>
        )}
        {!inBrowser && list && !paused && list.plugins.length > 0 && (
          <button onClick={() => void act('pause', () => window.vibe.plugins.setPaused(true))} title="Stop every plugin: no panels, commands, hooks or schedules until you resume them">
            Pause all
          </button>
        )}
        <button onClick={() => setReload((n) => n + 1)} title="Look for plugins again" aria-label="Refresh the plugin list">
          ↻
        </button>
      </div>
      <div className="plugins-list">
        {paused && (
          <div className="plugin-paused" role="status">
            <span>
              {paused === 'safe-mode'
                ? '🛟 Starwright started in safe mode: every plugin is paused.'
                : '⏸ Every plugin is paused: no panels, commands, hooks or schedules.'}
            </span>
            {!inBrowser && (
              <button className="primary" onClick={() => void act('pause', () => window.vibe.plugins.setPaused(false))} disabled={busy === 'pause'}>
                Resume plugins
              </button>
            )}
          </div>
        )}
        {inBrowser && <div className="plugin-where">Plugins are approved and turned on or off on the computer running Starwright. Here you can open their panels and use their buttons.</div>}
        {error && <div className="plugin-error">{error}</div>}
        {!list && !error && <div className="files-empty">Loading…</div>}
        {list && !list.plugins.length && (
          <div className="files-empty">
            <p>No plugins yet. A plugin adds something Starwright doesn't have: a dashboard for this project, a button that runs a check, something that happens after each request. You, Claude or Codex can write one.</p>
          </div>
        )}
        {list?.plugins.map((plugin) => (
          <PluginCard
            key={plugin.key}
            projectId={projectId}
            plugin={plugin}
            busy={busy === plugin.key}
            paused={!!paused}
            onApprove={() => void act(plugin.key, () => window.vibe.plugins.approve(projectId, plugin.key, plugin.hash ?? ''))}
            onSetOff={(off) => void act(plugin.key, () => window.vibe.plugins.setOff(projectId, plugin.key, off))}
            onOpen={(panelId) => void openPanel(plugin.key, panelId)}
            onRun={(command) => void act(`${plugin.key}:run`, () => window.vibe.plugins.run(projectId, plugin.key, command))}
            onStop={() => void window.vibe.plugins.stop(projectId, plugin.key).catch(() => undefined)}
          />
        ))}
        {!inBrowser && list && list.examples.length > 0 && (
          <div className="plugin-examples">
            <span>{list.plugins.length ? 'More examples:' : 'Start from an example:'}</span>
            {list.examples.map((e) => (
              <button key={e.name} onClick={() => void act('example', () => window.vibe.plugins.addExample(e.name))} disabled={busy === 'example'}>
                Add {e.title}
              </button>
            ))}
          </div>
        )}
        {list && !inBrowser && (
          <div className="plugin-where">
            Plugins in <code>.starwright/plugins</code> are this project's own (and go in git with it); plugins in Starwright's{' '}
            <button className="link-button" onClick={() => void act('folder', () => window.vibe.plugins.openFolder(projectId, 'global'))}>
              plugins folder
            </button>{' '}
            are for every project. To make one, ask Claude: it knows how. To start Starwright with every plugin paused, start it with <code>--safe-mode</code>.
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

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

function triggerWords(trigger: string): string {
  if (trigger === 'button') return 'button'
  if (trigger === 'panel') return 'its panel'
  if (trigger.startsWith('hook:')) return PLUGIN_EVENTS[trigger.slice(5) as keyof typeof PLUGIN_EVENTS]?.replace(/^When /, 'after: ') ?? trigger
  if (trigger.startsWith('schedule:')) return 'schedule'
  return trigger
}

function RunLine({ run, title }: { run: PluginRun; title: string }) {
  return (
    <span className={`plugin-run ${run.ok ? 'plugin-run-ok' : 'plugin-run-failed'}`}>
      {run.ok ? '✓' : '✕'} {title} {run.ok ? 'done' : 'failed'} · {ago(run.at)} · {triggerWords(run.trigger)}
      {run.status ? ` · ${run.status}` : ''}
    </span>
  )
}

function PluginCard({
  projectId,
  plugin,
  busy,
  paused,
  onApprove,
  onSetOff,
  onOpen,
  onRun,
  onStop
}: {
  projectId: string
  plugin: PluginInfo
  busy: boolean
  paused: boolean
  onApprove: () => void
  onSetOff: (off: boolean) => void
  onOpen: (panelId: string) => void
  onRun: (command: string) => void
  onStop: () => void
}) {
  const m = plugin.manifest
  const asking = plugin.status === 'needs-approval' || plugin.status === 'changed'
  const [runs, setRuns] = useState<PluginRun[] | null>(null)
  const commandTitle = (id: string): string => m?.commands.find((c) => c.id === id)?.title ?? id
  const showRuns = (): void => {
    if (runs) return setRuns(null)
    window.vibe.plugins
      .runs(projectId, plugin.key)
      .then(setRuns)
      .catch(() => setRuns([]))
  }
  return (
    <div className={`plugin-card plugin-${plugin.status}`} data-plugin={plugin.name}>
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
      {plugin.status === 'off' && plugin.offReason && <div className="plugin-error">Starwright turned it off: {plugin.offReason}</div>}
      {asking && m && (
        <div className="plugin-approval">
          {plugin.status === 'changed' && (
            <p>
              Its files {plugin.newPermissions.length ? 'or what it asks for ' : ''}changed since you approved it
              {plugin.approvedAt ? ` on ${new Date(plugin.approvedAt).toLocaleDateString()}` : ''}. It won't run until you approve it again.
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
          {m.commands.length > 0 && (
            <>
              <p>The commands it runs, from the project's folder:</p>
              <ul className="plugin-commands">
                {m.commands.map((c) => (
                  <li key={c.id}>
                    <strong>{c.title}</strong>: <code>{commandLine(c)}</code>
                    <span className="plugin-muted"> (stopped after {c.timeout} s)</span>
                  </li>
                ))}
              </ul>
              <p className="plugin-muted">
                {'{plugin}'} is this plugin's files as you approve them now, {'{project}'} the project's folder and {'{data}'} a folder of its own.
              </p>
            </>
          )}
          {(m.hooks.length > 0 || m.schedules.length > 0) && (
            <>
              <p>When they run by themselves:</p>
              <ul>
                {m.hooks.map((h) => (
                  <li key={`${h.on}:${h.command}`}>
                    {PLUGIN_EVENTS[h.on]}: {commandTitle(h.command)}
                  </li>
                ))}
                {m.schedules.map((s) => (
                  <li key={s.id}>
                    {describePluginWhen(s.when)}: {commandTitle(s.command)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {plugin.notes.map((n) => (
            <p key={n} className="plugin-muted">
              {n}
            </p>
          ))}
          <p className="plugin-note">
            {m.panels.length > 0 && "Its panels run in a locked-down frame beside the chat: no internet, no access to the rest of the computer, your keys or Starwright's settings. "}
            {m.commands.length > 0
              ? 'Its commands run as you, with what any program you run can do: approve them only if you trust what they do.'
              : 'It can only do what is listed here.'}
          </p>
          {inBrowser ? (
            <p className="plugin-muted">Approve it on the computer running Starwright.</p>
          ) : (
            <button className="primary" onClick={onApprove} disabled={busy}>
              {plugin.status === 'changed' ? 'Approve again' : 'Approve'}
            </button>
          )}
        </div>
      )}
      {plugin.status === 'approved' && m && !paused && (
        <>
          <div className="plugin-actions">
            {m.panels.map((p) => (
              <button key={p.id} className="primary" onClick={() => onOpen(p.id)}>
                Open {p.title}
              </button>
            ))}
            {m.buttons.map((b) => (
              <button key={b.title} onClick={() => onRun(b.command)} disabled={!!plugin.running} title={`Runs ${commandTitle(b.command)}`}>
                ▶ {b.title}
              </button>
            ))}
            {!inBrowser && (
              <button onClick={() => onSetOff(true)} disabled={busy} title="It stays approved; turn it on again any time">
                Turn off
              </button>
            )}
          </div>
          {(m.hooks.length > 0 || m.schedules.length > 0) && (
            <div className="plugin-muted plugin-auto">
              Runs by itself:{' '}
              {[
                ...m.hooks.map((h) => `${PLUGIN_EVENTS[h.on].replace(/^When /, 'when ')}, ${commandTitle(h.command)}`),
                ...m.schedules.map((s) => `${describePluginWhen(s.when).toLowerCase()}, ${commandTitle(s.command)}`)
              ].join('; ')}
            </div>
          )}
        </>
      )}
      {plugin.running && (
        <div className="plugin-running" role="status">
          <span className="plugin-spinner" aria-hidden="true" /> Running {commandTitle(plugin.running)}…
          <button className="link-button" onClick={onStop}>
            Stop
          </button>
        </div>
      )}
      {plugin.lastRun && !plugin.running && m && (
        <div className="plugin-last">
          <RunLine run={plugin.lastRun} title={commandTitle(plugin.lastRun.command)} />{' '}
          <button className="link-button" onClick={showRuns} aria-expanded={!!runs}>
            {runs ? 'Hide runs' : 'Runs'}
          </button>
        </div>
      )}
      {runs && (
        <ul className="plugin-runs">
          {!runs.length && <li className="plugin-muted">No runs yet.</li>}
          {runs.map((r) => (
            <li key={`${r.at}${r.command}`}>
              <RunLine run={r} title={commandTitle(r.command)} />
              {r.output && (
                <details>
                  <summary>What it printed ({r.seconds} s{r.exitCode !== null ? `, exit code ${r.exitCode}` : ''})</summary>
                  <pre>{r.output}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {plugin.status === 'off' && !inBrowser && (
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

function PluginFrame({ panel, onDraft }: { panel: OpenedPanel; onDraft: (text: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const draft = useRef(onDraft)
  draft.current = onDraft

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
        .then((result) => {
          // Starwright checked the permission and the text; the message box is on this screen.
          if (method === 'chat.draft' && result && typeof (result as { draft?: unknown }).draft === 'string') {
            draft.current((result as { draft: string }).draft)
            return send({ id, result: true })
          }
          send({ id, result: method === 'hello' && probe.current ? { ...(result as object), theme: themeNow(probe.current) } : result })
        })
        .catch((err) => send({ id, error: cleanError(err) }))
        .finally(() => waiting--)
    }
    window.addEventListener('message', onMessage)
    const observer = new MutationObserver(() => {
      if (probe.current) send({ event: 'theme', theme: themeNow(probe.current) })
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    // Events in the project, for a panel whose plugin may read its records (Starwright decides which).
    const stopEvents = window.vibe.plugins.onEvent((token, event) => {
      if (token === panel.token) send({ event: 'plugin-event', data: event })
    })
    return () => {
      window.removeEventListener('message', onMessage)
      observer.disconnect()
      stopEvents()
    }
  }, [panel.token])

  useEffect(() => () => void window.vibe.plugins.closePanel(panel.token).catch(() => undefined), [panel.token])

  return (
    <>
      <span ref={probe} className="plugin-theme-probe" aria-hidden="true" />
      <iframe
        ref={frame}
        className="plugin-frame"
        // Over Remote, the same panel from Starwright's Remote address.
        src={inBrowser ? panel.remotePath : panel.url}
        // Scripts only: no same-origin (it can't reach Starwright's page), no pop-ups, forms or navigating the app.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={`${panel.pluginTitle}: ${panel.title}`}
      />
    </>
  )
}
