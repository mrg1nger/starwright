// Project Pulse: a Starwright plugin (see docs/plugins.md). It reads Starwright's records for
// this project (records:read), counts the files changed since the last checkpoint (files:read),
// and remembers which range you picked (storage). Everything is drawn here, with no libraries:
// a panel can't load anything from the internet.
'use strict'

const sw = window.starwright
const $ = (id) => document.getElementById(id)
const SVG = 'http://www.w3.org/2000/svg'
const RANGES = [7, 30, 90]

function el(tag, attrs, ...children) {
  const node = tag.startsWith('svg:') ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') node.setAttribute('class', v)
    else if (k === 'text') node.textContent = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, String(v))
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c)
  return node
}

const fmt = (n) => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}
const dayKey = (iso) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const shortDay = (key) => new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
const when = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const AGENTS = { claude: 'Claude', codex: 'Codex', cline: 'Cline', local: 'Local model', haiku: 'Haiku' }
const agentName = (a) => AGENTS[String(a).toLowerCase()] || String(a)

// ---- the hover tip ----

const tip = $('tip')
function showTip(event, title, lines) {
  tip.replaceChildren(el('strong', { text: title }), ...lines.map((l) => el('div', { text: l })))
  tip.hidden = false
  const x = Math.min(event.clientX + 12, window.innerWidth - tip.offsetWidth - 8)
  const y = Math.max(8, event.clientY - tip.offsetHeight - 10)
  tip.style.left = `${x}px`
  tip.style.top = `${y}px`
}
const hideTip = () => (tip.hidden = true)

// ---- pieces ----

function tile(value, label) {
  return el('div', { class: 'tile' }, el('div', { class: 'value', text: value }), el('div', { class: 'label', text: label }))
}

/** One bar a day, rounded at the top, anchored to the baseline; hover a column for its numbers. */
function perDayChart(requests, days) {
  const keys = []
  for (let i = days - 1; i >= 0; i--) keys.push(dayKey(new Date(Date.now() - i * 86400000).toISOString()))
  const byDay = new Map(keys.map((k) => [k, { n: 0, done: 0, stopped: 0, error: 0 }]))
  for (const r of requests) {
    const d = byDay.get(dayKey(r.at))
    if (!d) continue
    d.n++
    if (r.outcome === 'done') d.done++
    else if (r.outcome === 'stopped') d.stopped++
    else d.error++
  }
  const max = Math.max(1, ...[...byDay.values()].map((d) => d.n))
  const W = 600
  const H = 150
  const left = 26
  const bottom = 18
  const plotH = H - bottom - 6
  const step = (W - left) / keys.length
  const barW = Math.max(2, Math.min(step - 2, 24)) // a 2px gap between bars at least; thin at any range
  const svg = el('svg:svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Requests each day over the last ${days} days` })
  const ticks = max <= 4 ? Array.from({ length: max + 1 }, (_, i) => i) : [0, Math.round(max / 2), max]
  const grid = el('svg:g', { class: 'grid' })
  const axis = el('svg:g', { class: 'axis' })
  for (const t of ticks) {
    const y = 6 + plotH - (t / max) * plotH
    grid.append(el('svg:line', { x1: left, x2: W, y1: y, y2: y }))
    axis.append(el('svg:text', { x: left - 6, y: y + 3, 'text-anchor': 'end', text: String(t) }))
  }
  svg.append(grid, axis)
  const labelEvery = Math.ceil(keys.length / 6)
  keys.forEach((key, i) => {
    const d = byDay.get(key)
    const x = left + i * step + (step - barW) / 2
    const h = (d.n / max) * plotH
    const column = el('svg:g', { class: 'column' })
    const r = Math.min(4, barW / 2, h)
    if (d.n) {
      // Rounded at the top only: the bar stands on the baseline.
      const y = 6 + plotH - h
      column.append(
        el('svg:path', {
          class: 'bar',
          d: `M${x},${6 + plotH} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${6 + plotH} Z`
        })
      )
    }
    // The hover target is the whole column, not just the bar.
    column.append(
      el('svg:rect', {
        class: 'hit',
        x: left + i * step,
        y: 0,
        width: step,
        height: H - bottom,
        onmousemove: (e) =>
          showTip(e, shortDay(key), d.n ? [`${d.n} request${d.n === 1 ? '' : 's'}`, `${d.done} done · ${d.stopped} stopped · ${d.error} with an error`] : ['No requests']),
        onmouseleave: hideTip
      })
    )
    svg.append(column)
    if (i % labelEvery === 0) axis.append(el('svg:text', { x: x + barW / 2, y: H - 4, 'text-anchor': 'middle', text: shortDay(key) }))
  })
  return svg
}

function tokensByAgent(usage) {
  const by = new Map()
  for (const u of usage) {
    const a = agentName(u.agent)
    const t = by.get(a) || { read: 0, written: 0 }
    t.read += u.fresh + u.cached
    t.written += u.output
    by.set(a, t)
  }
  const rows = [...by.entries()].sort((x, y) => y[1].read + y[1].written - (x[1].read + x[1].written))
  if (!rows.length) return el('p', { class: 'empty', text: 'No tokens recorded in this time.' })
  const max = Math.max(...rows.map(([, t]) => t.read + t.written))
  const grid = el('div', { class: 'hbars' })
  for (const [name, t] of rows) {
    const total = t.read + t.written
    grid.append(
      el('div', { text: name }),
      el(
        'div',
        {
          class: 'hbar-track',
          onmousemove: (e) => showTip(e, name, [`${total.toLocaleString()} tokens`, `${t.read.toLocaleString()} read · ${t.written.toLocaleString()} written`]),
          onmouseleave: hideTip
        },
        el('div', { class: 'hbar', style: `width:${Math.max(0.5, (total / max) * 100)}%` })
      ),
      el('div', { class: 'hbar-note', text: `${fmt(total)} · ${fmt(t.read)} read, ${fmt(t.written)} written` })
    )
  }
  return grid
}

/** A state as an icon and a word: never colour alone. */
function state(kind, word) {
  const icon = { good: '✓', bad: '✗', warn: '■', none: '·' }[kind]
  return el('span', { class: 'state' }, el('span', { class: `state ${kind}`, 'aria-hidden': 'true', text: `${icon} ` }), word)
}

function handoffTable(handoffs) {
  if (!handoffs.length) return el('p', { class: 'empty', text: 'No hand-offs in this time.' })
  const by = new Map()
  for (const h of handoffs) {
    const a = agentName(h.agent)
    const t = by.get(a) || { n: 0, done: 0, failed: 0, other: 0, models: new Set() }
    t.n++
    if (h.status === 'done') t.done++
    else if (h.status === 'failed' || h.status === 'error') t.failed++
    else t.other++
    if (h.model) t.models.add(h.model)
    by.set(a, t)
  }
  const body = [...by.entries()]
    .sort((x, y) => y[1].n - x[1].n)
    .map(([name, t]) =>
      el(
        'tr',
        {},
        el('td', {}, el('div', { text: name }), t.models.size ? el('div', { class: 'detail', text: [...t.models].join(', ') }) : null),
        el('td', { class: 'num', text: String(t.n) }),
        el('td', { class: 'num', text: String(t.done) }),
        el('td', { class: 'num', text: String(t.failed) }),
        el('td', { class: 'num', text: String(t.other) }),
        el('td', { class: 'num', text: `${Math.round((t.done / t.n) * 100)}%` })
      )
    )
  return el(
    'table',
    {},
    el(
      'thead',
      {},
      el('tr', {}, ...['Agent', 'Hand-offs', 'Done', 'Failed', 'Stopped or other', 'Done %'].map((h, i) => el('th', { class: i ? 'num' : '', text: h })))
    ),
    el('tbody', {}, ...body)
  )
}

function scheduleTable(schedules) {
  if (!schedules.length) return el('p', { class: 'empty', text: 'No schedules in this project.' })
  const rows = []
  for (const s of schedules) {
    const last = s.runs[s.runs.length - 1]
    const failed = s.runs.filter((r) => r.status === 'failed').length
    const kind = !last ? 'none' : last.status === 'ok' ? 'good' : last.status === 'failed' ? 'bad' : 'warn'
    const word = !last ? 'Not run yet' : { ok: 'Done', failed: 'Failed', skipped: 'Skipped', running: 'Running', waiting: 'Waiting for you' }[last.status] || last.status
    rows.push(
      el(
        'tr',
        {},
        el('td', {}, el('div', { text: s.name }), el('div', { class: 'detail', text: s.enabled ? (s.nextAt ? `Next: ${when(s.nextAt)}` : 'On') : 'Turned off' })),
        el('td', {}, state(kind, word), last ? el('div', { class: 'detail', text: when(last.at) }) : null, last && last.detail ? el('div', { class: 'detail', text: last.detail }) : null),
        el('td', { class: 'num', text: `${s.runs.length - failed}/${s.runs.length}` })
      )
    )
  }
  return el(
    'table',
    {},
    el('thead', {}, el('tr', {}, el('th', { text: 'Schedule' }), el('th', { text: 'Last run' }), el('th', { class: 'num', text: 'Not failed' }))),
    el('tbody', {}, ...rows)
  )
}

// ---- putting it together ----

let days = 30

async function load() {
  for (const b of document.querySelectorAll('[data-days]')) b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days))
  $('status').textContent = 'Loading…'
  try {
    const [requests, usage, handoffs, schedules, files] = await Promise.all([
      sw.records.requests({ days }),
      sw.records.usage({ days }),
      sw.records.handoffs({ days }),
      sw.records.schedules(),
      sw.files.list()
    ])
    const done = requests.filter((r) => r.outcome === 'done').length
    const tokens = usage.reduce((sum, u) => sum + u.fresh + u.cached + u.output, 0)
    const changed = Object.keys(files.changed).length
    $('tiles').replaceChildren(
      tile(String(requests.length), `requests in ${days} days`),
      tile(requests.length ? `${Math.round((done / requests.length) * 100)}%` : '–', 'of them done'),
      tile(fmt(tokens), 'tokens'),
      tile(String(handoffs.length), 'hand-offs'),
      tile(String(changed), `of ${files.files.length.toLocaleString()} files changed since the checkpoint`)
    )
    $('per-day').replaceChildren(perDayChart(requests, days))
    $('tokens').replaceChildren(tokensByAgent(usage))
    $('handoffs').replaceChildren(handoffTable(handoffs))
    $('schedules').replaceChildren(scheduleTable(schedules))
    $('status').textContent = `Updated ${new Date().toLocaleTimeString()}.`
  } catch (err) {
    $('status').textContent = `Couldn't read the records: ${err.message}`
  }
}

for (const b of document.querySelectorAll('[data-days]')) {
  b.addEventListener('click', () => {
    days = Number(b.dataset.days)
    sw.storage.set('days', days).catch(() => undefined)
    load()
  })
}

sw.ready.then(async (info) => {
  $('title').textContent = `Project Pulse · ${info.project.name}`
  try {
    const saved = await sw.storage.get('days')
    if (RANGES.includes(saved)) days = saved
  } catch {
    // No store: 30 days.
  }
  load()
})
