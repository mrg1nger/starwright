// Tries a new Codex or Cline before anyone updates to it: installs it into a throwaway npm
// folder (the real install is left alone), runs Starwright's smoke tests against that copy, and
// writes what changed (options added or gone from its --help, and the release notes since the
// version Starwright was tested with) to test-results/try-tool/.
//
//   npm run try-tool -- codex              npm's newest Codex
//   npm run try-tool -- cline 3.0.80       that version
//
//   --quick   install, --help and notes only: no smoke tests, so no plan usage
//   --mark    when everything passed, raise TESTED_WITH in shared/update.ts to this version
//   --keep    leave the throwaway install (its folder is printed)
//   --suites a,b   only these smoke files (by name, as npm run smoke -- <name> takes them)
//
// The smoke tests: for Codex its own suite (takeovers, Ask, the usage meters, the Chat tab), the
// hand-offs (collaboration) and an MCP server it's given (memory-and-extensions); for Cline its
// runs, hosted and one-off, through the safety hook; for both the check an update gets
// (tool-update). They use some of the tool's plan, and the Codex ones some Claude: about 15-25
// minutes for Codex, 5-10 for Cline.
// The trial copy is put first on the PATH for them, so Starwright starts it as it would after an
// update; the tool-update test makes sure it did.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const win = process.platform === 'win32'

const TOOLS = {
  codex: {
    name: 'Codex',
    pkg: '@openai/codex',
    repo: 'openai/codex',
    tag: 'rust-v',
    help: [[], ['exec'], ['exec', 'resume'], ['app-server']],
    smoke: ['codex', 'collaboration', 'memory-and-extensions', 'tool-update']
  },
  cline: {
    name: 'Cline',
    pkg: 'cline',
    repo: 'cline/cline',
    tag: 'cli-v',
    help: [[]],
    smoke: ['cline', 'tool-update']
  }
}

const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const suitesAt = args.indexOf('--suites')
const suites = suitesAt >= 0 ? (args[suitesAt + 1] ?? '').split(',').filter(Boolean) : undefined
const [toolId, asked] = args.filter((a, i) => !a.startsWith('--') && i !== suitesAt + 1)
const tool = TOOLS[toolId]
if (!tool) {
  console.error('Usage: npm run try-tool -- <codex|cline> [version] [--quick] [--mark] [--keep] [--suites a,b]')
  process.exit(2)
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/
const parts = (v) => v.split(/[.-]/).slice(0, 3).map(Number)
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

/** Runs a command line through the shell (npm, codex and cline are .cmd shims on Windows). */
function sh(line, env = process.env, timeout = 60_000) {
  const r = spawnSync(line, { shell: true, env, encoding: 'utf8', timeout, windowsHide: true, cwd: root })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

const updateTs = join(root, 'shared', 'update.ts')
const testedWith = () => readFileSync(updateTs, 'utf8').match(new RegExp(`TESTED_WITH[^{]*\\{[^}]*${toolId}: '([^']+)'`))?.[1]
const tested = testedWith()
const installed = sh(`${toolId} --version`).out.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/)?.[0]

const version = asked ?? sh(`npm view ${tool.pkg} version`).out.split(/\r?\n/).pop()?.trim()
if (!version || !VERSION.test(version)) {
  console.error(`Not a ${tool.name} version: ${version ?? "npm didn't say"}`)
  process.exit(2)
}
console.log(`Trying ${tool.name} ${version} (installed here: ${installed ?? 'none'}; Starwright tested with ${tested ?? '?'})`)

// 1. Install into a throwaway folder.
const prefix = mkdtempSync(join(tmpdir(), `starwright-try-${toolId}-`))
const bin = win ? prefix : join(prefix, 'bin')
console.log(`\nInstalling into ${prefix} ...`)
const install = sh(`npm install -g ${tool.pkg}@${version} --no-fund --no-audit`, { ...process.env, npm_config_prefix: prefix }, 600_000)
if (!install.ok) {
  console.error(install.out)
  rmSync(prefix, { recursive: true, force: true })
  process.exit(1)
}

// The environment that finds the trial copy first (the PATH key keeps its spelling on Windows).
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
const trialEnv = { ...process.env, [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}` }
delete trialEnv.VIBEAPP_CLINE_BIN

const report = []
const problems = []
const said = sh(`${toolId} --version`, trialEnv).out
if (!said.includes(version)) problems.push(`The trial copy says "${said}", not ${version}.`)

// 2. What its --help gained or lost, against the copy installed here.
const options = (text) => {
  const found = new Map()
  for (const line of text.split(/\r?\n/)) {
    for (const m of line.matchAll(/(?:^|[\s,[(])(--[a-z0-9][a-z0-9-]*)/gi)) if (!found.has(m[1])) found.set(m[1], line.trim())
  }
  return found
}
const commands = (text) => {
  const found = new Map()
  let inside = false
  for (const line of text.split(/\r?\n/)) {
    if (/^(Commands|Subcommands):/i.test(line)) inside = true
    else if (inside && /^\S/.test(line)) inside = false
    else if (inside) {
      const m = line.match(/^\s+([a-z][\w-]*)\b/)
      if (m && m[1] !== 'help') found.set(m[1], line.trim())
    }
  }
  return found
}
const diff = (before, after) => ({
  added: [...after].filter(([k]) => !before.has(k)).map(([, line]) => line),
  gone: [...before.keys()].filter((k) => !after.has(k))
})

report.push(`## What its --help gained or lost`, '')
if (!installed) report.push(`(No ${tool.name} installed here to compare with.)`, '')
else report.push(`Compared with the ${installed} installed here.`, '')
let changes = 0
for (const sub of tool.help) {
  const line = `${toolId} ${[...sub, '--help'].join(' ')}`
  const after = sh(line, trialEnv)
  if (!after.ok) {
    problems.push(`\`${line}\` failed: ${after.out.split(/\r?\n/)[0]}`)
    continue
  }
  if (!installed) continue
  const before = sh(line).out
  const o = diff(options(before), options(after.out))
  const c = diff(commands(before), commands(after.out))
  const lines = [
    ...c.added.map((l) => `- new command: ${l}`),
    ...c.gone.map((k) => `- command gone: ${k}`),
    ...o.added.map((l) => `- new option: ${l}`),
    ...o.gone.map((k) => `- option gone: ${k}`)
  ]
  changes += lines.length
  if (lines.length) report.push(`\`${line}\``, '', ...lines, '')
}
if (installed && !changes) report.push('No options or commands added or gone.', '')

// 3. Release notes since the tested version.
report.push(`## Release notes after ${tested ?? '?'}, up to ${version}`, '')
const listed = sh(`gh release list -R ${tool.repo} --limit 200 --exclude-pre-releases --exclude-drafts --json tagName,publishedAt`)
let releases = []
try {
  releases = JSON.parse(listed.out)
    .filter((r) => r.tagName.startsWith(tool.tag) && VERSION.test(r.tagName.slice(tool.tag.length)))
    .map((r) => ({ ...r, version: r.tagName.slice(tool.tag.length) }))
    .filter((r) => (!tested || newer(r.version, tested)) && !newer(r.version, version))
    .sort((a, b) => (newer(a.version, b.version) ? 1 : -1))
} catch {
  report.push(`(Couldn't list the releases with gh: ${listed.out.split(/\r?\n/)[0]}) See https://github.com/${tool.repo}/releases`, '')
}
for (const r of releases.slice(-40)) {
  const v = sh(`gh release view ${r.tagName} -R ${tool.repo} --json body`)
  let body = ''
  try {
    body = JSON.parse(v.out).body?.trim() ?? ''
  } catch {
    body = '(notes not read)'
  }
  report.push(`### ${r.version} (${r.publishedAt.slice(0, 10)})`, '', `https://github.com/${tool.repo}/releases/tag/${r.tagName}`, '', body || '(no notes)', '')
}
if (!releases.length && listed.ok) report.push('(None found.)', '')

// 4. The smoke tests, against the trial copy.
const results = []
if (!flag('--quick') && !problems.length) {
  const env = { ...trialEnv, VIBEAPP_TRY_TOOL: toolId, VIBEAPP_TRY_PREFIX: prefix, VIBEAPP_TRY_VERSION: version }
  for (const suite of suites ?? tool.smoke) {
    console.log(`\n=== smoke ${suite} against ${tool.name} ${version} ===`)
    const started = Date.now()
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'test.mjs'), 'smoke', suite], { cwd: root, stdio: 'inherit', env })
    results.push({ suite, ok: r.status === 0, seconds: Math.round((Date.now() - started) / 1000) })
  }
}
const smokeLine = flag('--quick')
  ? 'not run (--quick)'
  : results.length
    ? results.map((r) => `${r.suite} ${r.ok ? 'passed' : 'FAILED'} (${r.seconds} s)`).join(', ')
    : 'not run (see the problems)'
const passed = !problems.length && results.length > 0 && results.every((r) => r.ok)

// 5. Write it up.
const outDir = join(root, 'test-results', 'try-tool')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `${toolId}-${version}.md`)
writeFileSync(
  outFile,
  [
    `# ${tool.name} ${version}, tried ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
    `Installed here: ${installed ?? 'none'}. Starwright tested with: ${tested ?? '?'}.`,
    '',
    `- Smoke tests: ${smokeLine}`,
    ...problems.map((p) => `- Problem: ${p}`),
    '',
    ...report
  ].join('\n')
)

if (!flag('--keep')) rmSync(prefix, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 })

console.log(`\n${tool.name} ${version}: ${passed ? 'PASSED' : flag('--quick') && !problems.length ? 'installed and read (no smoke tests)' : 'NOT PASSED'}`)
for (const p of problems) console.log(`  problem: ${p}`)
console.log(`  smoke tests: ${smokeLine}`)
console.log(`  --help: ${installed ? `${changes} change${changes === 1 ? '' : 's'} from ${installed}` : 'nothing to compare with'}; release notes: ${releases.length}`)
console.log(`  written up in ${outFile}`)
if (flag('--keep')) console.log(`  the trial install is in ${prefix}`)

if (passed && flag('--mark') && suites) console.log('  --mark needs the full set of smoke tests (no --suites): TESTED_WITH left as it is.')
else if (passed && flag('--mark')) {
  if (tested && !newer(version, tested)) console.log(`  TESTED_WITH.${toolId} is already ${tested}: left as it is.`)
  else {
    const text = readFileSync(updateTs, 'utf8')
    writeFileSync(updateTs, text.replace(new RegExp(`(TESTED_WITH[^{]*\\{[^}]*${toolId}: ')[^']+'`), `$1${version}'`))
    console.log(`  TESTED_WITH.${toolId} raised to ${version} in shared/update.ts: release it (version + CHANGELOG) so Starwright stops marking it untested.`)
  }
} else if (passed) console.log(`  to mark it tested: run again with --mark, or set TESTED_WITH.${toolId} = '${version}' in shared/update.ts`)

process.exitCode = passed || (flag('--quick') && !problems.length) ? 0 : 1
