// The to-do finder's panel: shows what the latest scan found, and runs a scan when asked. The list comes
// from the scan command's "::json" line, kept with its run by Starwright.
;(function () {
  'use strict'
  const sw = window.starwright
  const status = document.getElementById('status')
  const list = document.getElementById('list')
  const scanButton = document.getElementById('scan')
  const find = document.getElementById('find')
  let data = null
  let kind = ''

  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.round(s / 60)} min ago`
    if (s < 86400) return `${Math.round(s / 3600)} h ago`
    return new Date(iso).toLocaleString()
  }

  function draw() {
    list.textContent = ''
    if (!data) return
    const words = find.value.trim().toLowerCase()
    const shown = data.items.filter(
      (i) => (!kind || i.kind === kind) && (!words || i.text.toLowerCase().includes(words) || i.path.toLowerCase().includes(words))
    )
    if (!shown.length) {
      list.append(el('p', 'muted empty', data.items.length ? 'Nothing matches.' : 'No to-do comments in the code. 🎉'))
      return
    }
    const byFile = new Map()
    for (const item of shown) {
      if (!byFile.has(item.path)) byFile.set(item.path, [])
      byFile.get(item.path).push(item)
    }
    for (const [path, items] of byFile) {
      const box = el('section', 'file')
      const head = el('h2')
      head.append(el('span', '', path), el('span', 'count', String(items.length)))
      box.append(head)
      for (const item of items) {
        const row = el('div', 'item')
        const ask = el('button', 'ask', 'Ask Claude')
        ask.title = 'Put this in the chat’s message box, to send when you’re ready'
        ask.addEventListener('click', () => {
          sw.chat
            .draft(`Deal with the ${item.kind} comment in ${item.path} at line ${item.line}: "${item.text}". Then take the comment out.`)
            .catch((err) => (status.textContent = err.message))
        })
        row.append(el('span', 'line', String(item.line)), el('span', `kind kind-${item.kind}`, item.kind), el('span', 'text', item.text || '(no text)'), ask)
        box.append(row)
      }
      list.append(box)
    }
  }

  function show(run) {
    if (!run) {
      status.textContent = 'Not scanned yet: press Scan now.'
      return
    }
    if (!run.ok || !run.result) {
      status.textContent = `The last scan failed (${ago(run.at)}): ${run.output.split('\n').filter(Boolean).pop() || 'no output'}`
      return
    }
    data = run.result
    const more = data.capped ? ' (the first 500)' : ''
    status.textContent = `${data.items.length} found${more} in ${data.scanned} files · scanned ${ago(run.at)}`
    draw()
  }

  async function latest() {
    const runs = await sw.commands.runs('scan')
    show(runs.find((r) => r.ok && r.result) || runs[0])
  }

  scanButton.addEventListener('click', async () => {
    scanButton.disabled = true
    status.textContent = 'Scanning…'
    try {
      show(await sw.commands.run('scan'))
    } catch (err) {
      status.textContent = err.message
    } finally {
      scanButton.disabled = false
    }
  })

  for (const button of document.querySelectorAll('.filters button')) {
    button.addEventListener('click', () => {
      kind = button.dataset.kind
      for (const b of document.querySelectorAll('.filters button')) b.classList.toggle('active', b === button)
      draw()
    })
  }
  find.addEventListener('input', draw)

  sw.ready.then(latest).catch((err) => (status.textContent = err.message))
  // Scans also run by themselves (after a request changes files, every morning): keep up with them.
  setInterval(() => {
    if (!scanButton.disabled) latest().catch(() => undefined)
  }, 20000)
})()
