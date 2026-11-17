import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { listProcesses, parseProcessList, recordPreview, stillRunning, stopLeftoverPreviews, treeOf } from '../../src/main/preview/leftovers'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test("a preview's process tree is everything under its server, and nothing that only borrowed a parent id", () => {
  const all = parseProcessList(
    [
      '100|4|1000|cmd.exe',
      '200|100|1100|node.exe', // concurrently
      '300|200|1200|node.exe', // vite
      '400|100|900|old.exe', // claims cmd as parent but is older: a reused id, not a child
      '500|9|1300|other.exe',
      'garbage line',
      '600|9|0|no-start-time.exe'
    ].join('\r\n')
  )
  assert.equal(all.length, 5)
  assert.deepEqual(treeOf(all, 100).map((p) => p.pid), [100, 200, 300])
  assert.deepEqual(treeOf(all, 999), [])
})

test('a recorded process counts only if its id and start time both still match', () => {
  const all = parseProcessList('300|1|1200|node.exe\n301|1|5555|node.exe')
  const recorded = [
    { pid: 300, created: '1200', name: 'node.exe' },
    { pid: 301, created: '1201', name: 'node.exe' }, // that id now belongs to a newer process
    { pid: 302, created: '1300', name: 'node.exe' } // gone
  ]
  assert.deepEqual(stillRunning(recorded, all).map((p) => p.pid), [300])
})

test(
  'a dev server left running after its parent is gone is found and stopped, and nothing else is',
  { skip: process.platform !== 'win32' && 'Windows only' },
  async () => {
    // cmd.exe starting a long-running node, like npm starting a dev server.
    const keepAlive = 'setInterval(function(){},1000)'
    const server = spawn('cmd.exe', ['/d', '/s', '/c', `""${process.execPath}" -e "${keepAlive}""`], { windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true })
    const bystander = spawn(process.execPath, ['-e', keepAlive], { windowsHide: true, stdio: 'ignore' })
    try {
      let tree: { pid: number; name: string }[] = []
      for (let i = 0; i < 20 && tree.length < 2; i++) {
        await sleep(250)
        tree = treeOf(await listProcesses(), server.pid!)
      }
      const devServer = tree.find((p) => /^node/i.test(p.name))
      assert.ok(devServer, `the node under cmd.exe was found (${tree.map((p) => p.name).join(', ')})`)
      await recordPreview('project-1', server.pid!)

      // Starwright "crashes": only cmd.exe ends, the dev server is orphaned and keeps running.
      execFileSync('taskkill', ['/pid', String(server.pid), '/F'], { stdio: 'ignore' })
      await sleep(300)
      assert.ok((await listProcesses()).some((p) => p.pid === devServer.pid), 'the orphan is still running before the clean-up')

      const stopped = await stopLeftoverPreviews()
      assert.ok(stopped.some((n) => /^node/i.test(n)), `stopped: ${stopped.join(', ')}`)
      await sleep(300)
      const after = await listProcesses()
      assert.ok(!after.some((p) => p.pid === devServer.pid), 'the orphaned dev server is gone')
      assert.ok(after.some((p) => p.pid === bystander.pid), 'an unrelated node process is left alone')
      assert.deepEqual(await stopLeftoverPreviews(), [], 'the list is cleared once cleaned up')
    } finally {
      for (const pid of [server.pid, bystander.pid]) {
        try {
          execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
        } catch {
          // already gone
        }
      }
    }
  }
)
