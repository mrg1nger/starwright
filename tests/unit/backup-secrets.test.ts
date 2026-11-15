import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { applyPendingRestore, backupNow, inspectBackup, stageRestore } from '../../src/main/backup/backup'
import { hasBackupPassword, lockBundle, setBackupPassword, unlockBundle } from '../../src/main/backup/lockedSecrets'
import { addExtension, listExtensions, removeExtension } from '../../src/main/extensions/store'
import { closeMemory } from '../../src/main/memory/store'
import { deleteSecret, listSecrets, secretEnv, setSecret } from '../../src/main/secrets/vault'

// The test Electron stub tags what safeStorage locks with STUB_COMPUTER, so setting it stands in for
// restoring on another computer, whose Windows key can't open what this one locked.
const computer = globalThis as { STUB_COMPUTER?: string }
const exportDir = mkdtempSync(join(tmpdir(), 'vibeapp-secret-backups-'))
const PROJECT = 'secrets-move-project'
const PASSWORD = 'correct horse battery staple'

after(() => {
  computer.STUB_COMPUTER = undefined
  setBackupPassword(null)
  try {
    deleteSecret(PROJECT, 'SHOP_API_KEY')
  } catch {
    // left by a failed test
  }
  for (const e of listExtensions().filter((x) => x.name === 'Moving tool')) removeExtension(e.id)
  rmSync(exportDir, { recursive: true, force: true })
})

const restart = (): void => {
  closeMemory() // as when Starwright restarts
  applyPendingRestore()
}

test('the locked copy opens only with its password', () => {
  const locked = lockBundle({ projects: { p: { KEY: 'value-123456' } }, extensions: {} }, PASSWORD)
  assert.ok(!JSON.stringify(locked).includes('value-123456'), 'nothing readable in it')
  assert.deepEqual(unlockBundle(locked, PASSWORD).projects.p, { KEY: 'value-123456' })
  assert.throws(() => unlockBundle(locked, 'wrong password!'), /doesn't open/)
  assert.throws(() => setBackupPassword('short'), /at least 10/)
})

test('with a backup password, secrets and extension keys come back on another computer', () => {
  setSecret(PROJECT, 'SHOP_API_KEY', 'sk-shop-0123456789')
  addExtension({ name: 'Moving tool', command: 'node', args: ['tool.js'], env: { TOOL_TOKEN: 'tok-abcdefghij' } })
  setBackupPassword(PASSWORD)
  assert.ok(hasBackupPassword())

  const backup = backupNow('export', exportDir)
  assert.equal(backup.secretsLocked, true)
  assert.ok(!existsSync(join(backup.path, 'backup-key.bin')), 'the password itself never goes in a backup')
  assert.ok(!readFileSync(join(backup.path, 'secrets.locked'), 'utf-8').includes('sk-shop'))
  assert.equal(inspectBackup(backup.path).secrets, 'here', 'on this computer they open as they are')

  computer.STUB_COMPUTER = 'new-pc'
  assert.equal(inspectBackup(backup.path).secrets, 'locked')
  assert.throws(() => stageRestore(backup.path, 'not the password'), /doesn't open/)
  assert.ok(!existsSync(join(app.getPath('userData'), 'restore-pending')), 'a wrong password changes nothing')

  stageRestore(backup.path, PASSWORD)
  restart()
  assert.deepEqual(secretEnv(PROJECT), { SHOP_API_KEY: 'sk-shop-0123456789' }, 'opened with the new computer’s key')
  const tool = listExtensions().find((e) => e.name === 'Moving tool')
  assert.deepEqual(tool?.envNames, ['TOOL_TOKEN'])
  assert.ok(!existsSync(join(app.getPath('userData'), 'secrets.locked')), 'the locked copy is not left in the data')
})

test('without the password (or one set), the rest restores and those secrets are simply left out', () => {
  computer.STUB_COMPUTER = 'old-pc'
  setBackupPassword(null)
  rmSync(join(app.getPath('userData'), 'secrets', `${PROJECT}.bin`), { force: true }) // locked by the last test's "computer"
  setSecret(PROJECT, 'SHOP_API_KEY', 'sk-shop-0123456789')
  const plain = backupNow('export', exportDir)
  assert.equal(plain.secretsLocked, false)

  computer.STUB_COMPUTER = 'another-pc'
  assert.equal(inspectBackup(plain.path).secrets, 'lost')
  stageRestore(plain.path)
  restart()
  assert.deepEqual(listSecrets(PROJECT), [], 'no "can\'t be unlocked" error: the project just asks for them again')
  assert.deepEqual(listExtensions().find((e) => e.name === 'Moving tool')?.envNames, [])
})
