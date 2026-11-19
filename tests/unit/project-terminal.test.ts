import { test } from 'node:test'
import assert from 'node:assert/strict'
import { terminalShell, trimBacklog } from '../../src/main/pty/projectTerminal'
import { checkRemoteCall } from '../../src/main/remote/auth'

test('the Terminal drawer starts PowerShell on Windows and the login shell elsewhere', () => {
  assert.deepEqual(terminalShell('win32', {}), { file: 'powershell.exe', args: ['-NoLogo'] })
  assert.equal(terminalShell('linux', { SHELL: '/no/such/shell' }).file, '/bin/bash')
})

test("a terminal's kept output is the newest part, starting at a whole line", () => {
  assert.equal(trimBacklog('short', 100), 'short')
  const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
  const kept = trimBacklog(long, 60)
  assert.ok(kept.length <= 60)
  assert.ok(kept.endsWith('line 49'))
  assert.match(kept, /^line \d+\n/, 'no half line at the top')
})

test('a read-only Remote connection can neither open nor type into a terminal', () => {
  for (const channel of ['vibe:term:open', 'vibe:term:restart', 'vibe:term:write', 'vibe:term:resize']) {
    assert.equal(checkRemoteCall(channel, [], true).allowed, false, channel)
    assert.equal(checkRemoteCall(channel, [], false).allowed, true, channel)
  }
})
