import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkToolVersions } from '../../src/main/updates/toolVersions'

// The new-version notice against the real tools and the real npm registry: the installed Codex,
// Cline and Claude SDK versions are read, and npm's newest for each. Free, about 10 seconds.

test('the installed Codex, Cline and Claude SDK versions are read, and npm gives the newest of each', { timeout: 120_000 }, async () => {
  const v = await checkToolVersions()
  const by = Object.fromEntries(v.tools.map((t) => [t.tool, t]))
  const semver = /^\d+\.\d+\.\d+/
  for (const tool of ['codex', 'cline', 'claude'] as const) {
    assert.match(by[tool].latest ?? '', semver, `${tool}: npm's newest (${by[tool].error ?? 'none'})`)
  }
  assert.match(by.claude.installed ?? '', semver, 'the built-in Claude SDK version')
  assert.equal(by.claude.bundled, true)
  for (const tool of ['codex', 'cline'] as const) {
    if (by[tool].installed) assert.match(by[tool].installed!, semver, `${tool}: installed version`)
  }
  console.log(v.tools.map((t) => `${t.tool} ${t.installed ?? '-'} → ${t.latest}${t.newer ? ' (newer)' : ''}`).join('; '))
})
