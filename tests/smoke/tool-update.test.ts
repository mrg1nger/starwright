import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkToolNow, npmInstallGlobal } from '../../src/main/updates/toolUpdate'
import { installedVersion } from '../../src/main/updates/toolVersions'
import { stopHostedCline } from '../../src/main/cli/clineAcp'

// The check Starwright runs after updating Codex or Cline, against the versions installed here
// (nothing is updated): their --help still lists what Starwright passes, and short real runs
// through Starwright's safety hook answer. Uses a little Codex and ClinePass usage, about a
// minute. Then npm install -g into a throwaway folder, to see the install itself works here.

for (const tool of ['codex', 'cline'] as const) {
  test(`the installed ${tool} passes the check an update gets`, { timeout: 600_000 }, async (t) => {
    const version = await installedVersion(tool)
    if (!version) return t.skip(`${tool} isn't installed`)
    const started = Date.now()
    const problems = await checkToolNow(tool, version)
    console.log(`${tool} ${version}: ${problems.length ? problems.join(' | ') : 'passed'} (${Math.round((Date.now() - started) / 1000)} s)`)
    assert.deepEqual(problems, [])
    if (tool === 'cline') stopHostedCline()
  })
}

test('npm install -g puts the version asked for in place (a throwaway folder, not the real one)', { timeout: 600_000 }, async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'vibeapp-npm-prefix-'))
  const before = process.env.npm_config_prefix
  process.env.npm_config_prefix = prefix
  try {
    await npmInstallGlobal('cline', '3.0.76')
    const pkg = [join(prefix, 'node_modules', 'cline', 'package.json'), join(prefix, 'lib', 'node_modules', 'cline', 'package.json')].find((p) => existsSync(p))
    assert.ok(pkg, 'installed into the folder')
    assert.equal(JSON.parse(readFileSync(pkg, 'utf8')).version, '3.0.76')
    await assert.rejects(npmInstallGlobal('cline', '99.0.0'), /notarget|No matching version|ETARGET|404/i)
    await assert.rejects(npmInstallGlobal('left-pad', '1.3.0'), /Not a package and version Starwright installs/)
  } finally {
    if (before === undefined) delete process.env.npm_config_prefix
    else process.env.npm_config_prefix = before
    rmSync(prefix, { recursive: true, force: true })
  }
})
