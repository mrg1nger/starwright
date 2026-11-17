import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runShell } from '../../src/main/local/localAgent'
import { listProcesses, stopProcesses, type RecordedProcess } from '../../src/main/preview/leftovers'

const node = process.execPath.replace(/\\/g, '/')

test(
  "a command that starts a server in the background comes back, and the server is stopped when the task ends",
  { skip: process.platform !== 'win32' && 'Windows only', timeout: 60_000 },
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vibeapp-unit-local-cmd-'))
    const leftBehind: RecordedProcess[] = []
    try {
      const started = Date.now()
      // What the local model did on Lazarus: start the dev server in the background, then carry on.
      const result = await runShell(`"${node}" -e "setInterval(function(){},1000)" & echo started`, cwd, 120, undefined, {}, leftBehind)
      const took = Date.now() - started
      assert.ok(took < 20_000, `came back after ${took} ms (it used to wait for ever)`)
      assert.equal(result.timedOut, false)
      assert.match(result.output, /started/)
      assert.equal(result.background, true, 'says something is still running')
      const server = leftBehind.find((p) => /^node/i.test(p.name))
      assert.ok(server, `the background server was noted (${leftBehind.map((p) => p.name).join(', ')})`)
      assert.ok((await listProcesses()).some((p) => p.pid === server.pid), 'it is still running until the task ends')

      const stopped = await stopProcesses(leftBehind)
      assert.ok(stopped.some((n) => /^node/i.test(n)))
      assert.ok(!(await listProcesses()).some((p) => p.pid === server.pid), 'stopped with the task')
    } finally {
      await stopProcesses(leftBehind).catch(() => undefined)
      try { rmSync(cwd, { recursive: true, force: true }) } catch { /* a stopped process may still hold it for a moment */ }
    }
  }
)

test('an ordinary command still returns its output and exit code, with nothing left behind', { timeout: 60_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'vibeapp-unit-local-cmd-'))
  const leftBehind: RecordedProcess[] = []
  try {
    const result = await runShell('echo hello && exit 3', cwd, 60, undefined, {}, leftBehind)
    assert.equal(result.code, 3)
    assert.match(result.output, /hello/)
    assert.equal(result.background, false)
    assert.equal(leftBehind.length, 0)
  } finally {
    try { rmSync(cwd, { recursive: true, force: true }) } catch { /* a stopped process may still hold it for a moment */ }
  }
})

test('a command that runs past its time comes back when the time is up, even with its output held open', { timeout: 60_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'vibeapp-unit-local-cmd-'))
  try {
    const started = Date.now()
    const result = await runShell(`"${node}" -e "setInterval(function(){},1000)"`, cwd, 5, undefined, {})
    const took = Date.now() - started
    assert.equal(result.timedOut, true)
    assert.ok(took < 15_000, `came back after ${took} ms`)
  } finally {
    try { rmSync(cwd, { recursive: true, force: true }) } catch { /* a stopped process may still hold it for a moment */ }
  }
})

test('stopping the task stops a running command at once', { timeout: 60_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'vibeapp-unit-local-cmd-'))
  try {
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 1_500)
    const started = Date.now()
    await runShell(`"${node}" -e "setInterval(function(){},1000)"`, cwd, 120, stop.signal, {})
    assert.ok(Date.now() - started < 10_000)
  } finally {
    try { rmSync(cwd, { recursive: true, force: true }) } catch { /* a stopped process may still hold it for a moment */ }
  }
})
