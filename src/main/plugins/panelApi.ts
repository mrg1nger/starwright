// The script every panel gets at /_starwright/api.js: window.starwright, which sends each call to
// the frame's parent (Starwright's screen) and gets the answer back. The parent knows which panel
// a message came from by its frame; the panel never holds anything that names it.
//
// It also puts Starwright's theme on the page as CSS variables (--sw-bg, --sw-text, ...) and keeps
// them up to date, so a panel looks at home in any theme. Kept as plain ES2017 for any page.

export const PANEL_API_SCRIPT = `(() => {
  'use strict'
  if (window.starwright) return
  const pending = new Map()
  const themeListeners = []
  const eventListeners = []
  let next = 1
  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      const id = next++
      pending.set(id, { resolve, reject })
      window.parent.postMessage({ starwright: 1, id, method, args }, '*')
    })
  const applyTheme = (theme) => {
    if (!theme || typeof theme !== 'object') return
    const root = document.documentElement
    for (const [name, value] of Object.entries(theme.vars || {})) {
      if (/^--sw-[a-z-]+$/.test(name) && typeof value === 'string') root.style.setProperty(name, value)
    }
    root.dataset.theme = theme.dark ? 'dark' : 'light'
    root.style.colorScheme = theme.dark ? 'dark' : 'light'
  }
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return
    const data = event.data
    if (!data || data.starwright !== 1) return
    if (data.event === 'theme') {
      applyTheme(data.theme)
      for (const listener of themeListeners) {
        try { listener(data.theme) } catch (err) { console.error(err) }
      }
      return
    }
    if (data.event === 'plugin-event') {
      for (const listener of eventListeners) {
        try { listener(data.data) } catch (err) { console.error(err) }
      }
      return
    }
    const waiting = pending.get(data.id)
    if (!waiting) return
    pending.delete(data.id)
    if (data.error) waiting.reject(new Error(data.error))
    else waiting.resolve(data.result)
  })
  const ready = call('hello').then((info) => {
    applyTheme(info.theme)
    return info
  })
  const days = (options) => (options && typeof options.days === 'number' ? options.days : 30)
  window.starwright = {
    /** Resolves to { project: { name }, plugin: { name, title, version }, permissions, commands, theme } once connected. */
    ready,
    call,
    files: {
      list: () => call('files.list'),
      read: (path) => call('files.read', path)
    },
    storage: {
      get: (key) => call('storage.get', key),
      set: (key, value) => call('storage.set', key, value),
      remove: (key) => call('storage.remove', key),
      keys: () => call('storage.keys')
    },
    records: {
      requests: (options) => call('records.requests', { days: days(options) }),
      usage: (options) => call('records.usage', { days: days(options) }),
      handoffs: (options) => call('records.handoffs', { days: days(options) }),
      schedules: () => call('records.schedules')
    },
    commands: {
      /** Runs one of the plugin's commands and resolves to the run: { ok, exitCode, output, seconds, status, result }. */
      run: (id, input) => call('commands.run', id, input),
      /** The latest runs (of one command, or all), newest first. */
      runs: (id) => call('commands.runs', id)
    },
    /** Sends the user an alert. */
    notify: (text) => call('notify', text),
    chat: {
      /** Puts text in the chat's message box; the user decides whether to send it. */
      draft: (text) => call('chat.draft', text)
    },
    /** Called with each event in the project while the panel is open: { type: 'request-end' | 'files-changed' | 'handoff-end' | 'deploy-end', at, ... }. Needs records:read. */
    onEvent: (listener) => { if (typeof listener === 'function') eventListeners.push(listener) },
    /** Called with the new theme when Starwright's theme changes (the CSS variables are already set). */
    onTheme: (listener) => { if (typeof listener === 'function') themeListeners.push(listener) }
  }
})()
`
