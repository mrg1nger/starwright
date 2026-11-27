import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolId } from '@shared/types'
import { toolNotices, toolVersionLines } from '@shared/update'
import { checkTools, TOOL_PACKAGES, versionIn, type ToolCheckDeps } from '../../src/main/updates/toolVersions'
import { checkRemoteCall } from '../../src/main/remote/auth'

const deps = (installed: Partial<Record<ToolId, string>>, latest: Record<string, string | Error>): ToolCheckDeps => ({
  installed: async (tool) => installed[tool],
  latest: async (pkg) => {
    const v = latest[pkg]
    if (v instanceof Error || v === undefined) throw v ?? new Error('unknown package')
    return v
  },
  now: () => new Date('2026-11-22T09:30:00Z')
})

test('a --version line gives its version', () => {
  assert.equal(versionIn('codex-cli 0.158.0\n'), '0.158.0')
  assert.equal(versionIn('3.0.74'), '3.0.74')
  assert.equal(versionIn('cline 3.1.0-beta.2'), '3.1.0-beta.2')
  assert.equal(versionIn('not a version'), undefined)
})

test('each tool is compared with the newest on npm, and the Claude SDK counts as built in', async () => {
  const v = await checkTools(
    deps(
      { codex: '0.158.0', cline: '3.0.75', claude: '0.3.283' },
      { '@openai/codex': '0.171.0', cline: '3.0.75', '@anthropic-ai/claude-agent-sdk': '0.3.330' }
    )
  )
  const by = Object.fromEntries(v.tools.map((t) => [t.tool, t]))
  assert.deepEqual(Object.keys(by).sort(), ['claude', 'cline', 'codex'])
  assert.equal(by.codex.newer, true)
  assert.equal(by.codex.package, TOOL_PACKAGES.codex)
  assert.equal(by.cline.newer, false, 'already the newest')
  assert.equal(by.claude.newer, true)
  assert.equal(by.claude.bundled, true)
  assert.equal(v.checkedAt, '2026-11-22T09:30:00.000Z')

  // Only Codex shows: Cline is current and the SDK comes with a Starwright update.
  assert.deepEqual(toolNotices(v, {}).map((t) => t.tool), ['codex'])
  assert.deepEqual(toolNotices(v, { codex: '0.171.0' }), [], 'skipped')
  assert.deepEqual(toolNotices(v, { codex: '0.160.0' }).map((t) => t.tool), ['codex'], 'an older skip does not hide a newer version')
  assert.deepEqual(toolNotices(null, {}), [])
})

test('a tool that is not installed, or npm not answering, is no notice', async () => {
  const v = await checkTools(deps({ claude: '0.3.283' }, { '@openai/codex': '0.171.0', cline: new Error('npm answered 503'), '@anthropic-ai/claude-agent-sdk': '0.3.283' }))
  const by = Object.fromEntries(v.tools.map((t) => [t.tool, t]))
  assert.equal(by.codex.installed, undefined)
  assert.equal(by.codex.newer, false)
  assert.equal(by.cline.error, 'npm answered 503')
  assert.equal(by.cline.newer, false)
  assert.deepEqual(toolNotices(v, {}), [])

  // The usage report: one line each.
  assert.deepEqual(toolVersionLines(v), [
    '## Tools (checked 2026-11-22 09:30 UTC)',
    '- Codex: not installed',
    '- Cline: not installed',
    '- Claude Agent SDK (built in): 0.3.283, the newest'
  ])
})

test('the report says which tool has a newer version', async () => {
  const v = await checkTools(
    deps({ codex: '0.158.0', cline: '3.0.74', claude: '0.3.283' }, { '@openai/codex': '0.171.0', cline: new Error('timed out'), '@anthropic-ai/claude-agent-sdk': '0.3.330' })
  )
  assert.deepEqual(toolVersionLines(v).slice(1), [
    '- Codex: 0.158.0, 0.171.0 is out (not yet tested with Starwright, which was tested up to 0.158.0)',
    "- Cline: 3.0.74 (couldn't ask npm: timed out)",
    '- Claude Agent SDK (built in): 0.3.283, 0.3.330 is out'
  ])
})

test('a remote screen can see the tool versions, and a read-only one cannot start a check', () => {
  assert.equal(checkRemoteCall('vibe:tools:versions', [], true).allowed, true)
  assert.equal(checkRemoteCall('vibe:tools:check', [], true).allowed, false)
  assert.equal(checkRemoteCall('vibe:tools:check', [], false).allowed, true)
})
