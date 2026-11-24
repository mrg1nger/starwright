// The scan command of the to-do finder plugin: looks through the project's code for to-do comments
// Starwright runs it from the project's folder with its own Node, and reads what it prints:
// "::status" is the run's one-line summary, "::json" the list its panel shows, and "::note" a line
// in the chat. It only reads the project; what it remembers between runs goes in its own folder
// (STARWRIGHT_DATA_DIR).
'use strict'
const { execFileSync } = require('child_process')
const { existsSync, readFileSync, readdirSync, statSync, writeFileSync } = require('fs')
const { extname, join } = require('path')

const project = process.env.STARWRIGHT_PROJECT || process.cwd()
const dataDir = process.env.STARWRIGHT_DATA_DIR || ''
const trigger = process.env.STARWRIGHT_TRIGGER || 'manual'

const CODE = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.cs', '.c', '.h', '.cpp', '.hpp', '.php', '.swift', '.lua', '.sh', '.ps1', '.css', '.scss', '.html', '.vue', '.svelte', '.sql', '.yml', '.yaml', '.toml', '.md'])
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'vendor', 'release', '.starwright', '__pycache__', 'target'])
// The markers, written so this file doesn't find itself.
const MARK = new RegExp(String.raw`\b(${['TO' + 'DO', 'FIX' + 'ME', 'HA' + 'CK', 'X' + 'XX'].join('|')})\b[:\s(]*(.*)$`)
const MAX_ITEMS = 500
const MAX_BYTES = 1024 * 1024

/** The project's files as git sees them (ignoring what .gitignore leaves out), or a walk without git. */
function files() {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: project, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\n').filter(Boolean)
  } catch {
    const found = []
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) walk(join(dir, entry.name), rel)
        else if (entry.isFile()) found.push(rel)
        if (found.length > 20000) return
      }
    }
    walk(project, '')
    return found
  }
}

const items = []
let scanned = 0
for (const path of files()) {
  if (!CODE.has(extname(path).toLowerCase()) || path.split('/').some((p) => SKIP.has(p))) continue
  const full = join(project, path)
  let text
  try {
    if (statSync(full).size > MAX_BYTES) continue
    text = readFileSync(full, 'utf-8')
  } catch {
    continue
  }
  scanned++
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && items.length < MAX_ITEMS; i++) {
    const m = MARK.exec(lines[i])
    // In a comment, not a string or a name: a comment starts before it (// # /* <!-- --, or a * line), with no quote after.
    if (!m || !/(\/\/|#|\/\*|^\s*\*|<!--|--)[^'"`]*$/.test(lines[i].slice(0, m.index))) continue
    items.push({ path, line: i + 1, kind: m[1], text: m[2].replace(/\*\/\s*$|-->\s*$/, '').trim().slice(0, 160) })
  }
}

// What changed since the last scan, kept in the plugin's own folder.
let before = null
const memory = dataDir ? join(dataDir, 'last.json') : ''
try {
  if (memory && existsSync(memory)) before = JSON.parse(readFileSync(memory, 'utf-8')).count
} catch {
  before = null
}
if (memory) writeFileSync(memory, JSON.stringify({ count: items.length, at: new Date().toISOString() }))

const kinds = {}
for (const item of items) kinds[item.kind] = (kinds[item.kind] || 0) + 1
console.log(`Scanned ${scanned} files.`)
console.log(`::json ${JSON.stringify({ items, scanned, before, at: new Date().toISOString(), capped: items.length >= MAX_ITEMS })}`)
const summary = Object.entries(kinds)
  .map(([k, n]) => `${n} ${k}`)
  .join(', ')
console.log(`::status ${items.length ? `Found ${items.length}${items.length >= MAX_ITEMS ? '+' : ''} (${summary})` : 'No TODO comments'} in ${scanned} files`)
// Only worth a line in the chat when a scan by itself found more than last time.
if (trigger !== 'button' && trigger !== 'panel' && before !== null && items.length > before) {
  const added = items.length - before
  console.log(`::note ${added} new TODO comment${added === 1 ? '' : 's'} since the last scan (${items.length} in all).`)
}
