import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkToolNow, npmInstallGlobal } from '../../src/main/updates/toolUpdate'
import { installedVersion } from '../../src/main/updates/toolVersions'
import { stopHostedCline } from '../../src/main/cli/clineAcp'
import { resolveCodexLaunch } from '../../src/main/cli/codexExec'
import { resolveClineLaunch } from '../../src/main/cli/clineExec'

// The check Starwright runs after updating Codex or Cline, against the versions installed here
// (nothing is updated): their --help still lists what Starwright passes, and short real runs
// through Starwright's safety hook answer. Uses a little Codex and ClinePass usage, about a
// minute. Then npm install -g into a throwaway folder, to see the install itself works here.
//
// Under scripts/try-tool.mjs (VIBEAPP_TRY_TOOL, VIBEAPP_TRY_PREFIX, VIBEAPP_TRY_VERSION) only the
// tool being tried is checked, from its throwaway install, and the npm test is left out.

const trying = process.env.VIBEAPP_TRY_TOOL
const tools = (['codex', 'cline'] as const).filter((t) => !trying || t === trying)

for (const tool of tools) {
  test(`the installed ${tool} passes the check an update gets`, { timeout: 600_000 }, async (t) => {
    if (trying && process.platform === 'win32') {
      // The copy Starwright would start (the exe, or the launcher its Node runs) is the one being
      // tried, not the user's own. Elsewhere the PATH is searched at each start, so it is.
      const prefix = resolve(process.env.VIBEAPP_TRY_PREFIX ?? '').toLowerCase()
      const launch = tool === 'codex' ? await resolveCodexLaunch() : await resolveClineLaunch(true)
      const files = launch ? [launch.file, ...launch.prefixArgs] : []
      assert.ok(
        files.some((p) => resolve(p).toLowerCase().startsWith(prefix + '\\')),
        `Starwright would start ${files.join(' ') || 'nothing'}, not the copy in ${prefix}`
      )
    }
    const version = await installedVersion(tool)
    if (!version) return t.skip(`${tool} isn't installed`)
    if (trying) assert.equal(version, process.env.VIBEAPP_TRY_VERSION, 'the version being tried')
    const started = Date.now()
    const problems = await checkToolNow(tool, version)
    console.log(`${tool} ${version}: ${problems.length ? problems.join(' | ') : 'passed'} (${Math.round((Date.now() - started) / 1000)} s)`)
    assert.deepEqual(problems, [])
    if (tool === 'cline') stopHostedCline()
  })
}

test('npm install -g puts the version asked for in place (a throwaway folder, not the real one)', { timeout: 600_000, skip: !!trying }, async () => {
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
