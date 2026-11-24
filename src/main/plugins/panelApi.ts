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
    /** Resolves to { project: { name }, plugin: { name, title, version }, permissions, theme } once connected. */
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
    /** Called with the new theme when Starwright's theme changes (the CSS variables are already set). */
    onTheme: (listener) => { if (typeof listener === 'function') themeListeners.push(listener) }
  }
})()
`
