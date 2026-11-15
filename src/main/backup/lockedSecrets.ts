import { app, safeStorage } from 'electron'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { BackupSecrets } from '@shared/types'

// Secrets and extension keys are locked with this Windows account's key (DPAPI), which no
// other computer has, so a backup's copy of them can't be opened anywhere else. With a backup
// password set, each backup also carries them locked with that password (secrets.locked), and a
// restore on another computer unlocks them and locks them again with that computer's key.
// The password is kept on this computer only (locked with its key), never in a backup.

const LOCKED = 'secrets.locked'
const KDF = { N: 2 ** 15, r: 8, p: 1 }

interface Bundle {
  /** Project id → its secrets. */
  projects: Record<string, Record<string, string>>
  /** Extension id → its keys. */
  extensions: Record<string, Record<string, string>>
}

interface LockedFile {
  format: 'starwright-secrets'
  v: 1
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  iv: string
  tag: string
  data: string
}

const passwordFile = (): string => join(app.getPath('userData'), 'backup-key.bin')

function key(password: string, salt: Buffer, kdf = KDF): Buffer {
  return scryptSync(password.normalize('NFC'), salt, 32, { ...kdf, maxmem: 256 * 1024 * 1024 })
}

/** Locks the bundle with the password (AES-256-GCM, the key made from the password by scrypt). */
export function lockBundle(bundle: Bundle, password: string): LockedFile {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(password, salt), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(bundle), 'utf-8'), cipher.final()])
  return {
    format: 'starwright-secrets',
    v: 1,
    kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
}

export function unlockBundle(file: LockedFile, password: string): Bundle {
  if (file?.format !== 'starwright-secrets' || file.v !== 1) throw new Error("This backup's locked secrets are in a format this Starwright doesn't know.")
  const { N, r, p, salt } = file.kdf
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(password, Buffer.from(salt, 'base64'), { N, r, p }), Buffer.from(file.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'))
    const json = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf-8')
    return JSON.parse(json) as Bundle
  } catch {
    throw new Error("That password doesn't open this backup's secrets.")
  }
}

// ---- the password, kept on this computer ----

export function hasBackupPassword(): boolean {
  return existsSync(passwordFile())
}

/** Sets the backup password (null: no password, backups don't carry the secrets any more). */
export function setBackupPassword(password: string | null): void {
  if (password === null) {
    rmSync(passwordFile(), { force: true })
    return
  }
  if (password.length < 10) throw new Error('Use at least 10 characters: anyone with a backup and this password gets your secrets.')
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer can't encrypt right now, so the password wasn't saved.")
  writeFileSync(passwordFile(), safeStorage.encryptString(password))
}

function backupPassword(): string | null {
  if (!hasBackupPassword()) return null
  try {
    return safeStorage.decryptString(readFileSync(passwordFile()))
  } catch {
    return null
  }
}

// ---- reading what's locked with this computer's key ----

function openHere(bytes: Buffer): Record<string, string> | null {
  try {
    return JSON.parse(safeStorage.decryptString(bytes)) as Record<string, string>
  } catch {
    return null
  }
}

/** Every secret and extension key in a data folder (this computer's, or a backup's), and how many couldn't be opened here. */
function readHere(folder: string): { bundle: Bundle; total: number; unreadable: number } {
  const bundle: Bundle = { projects: {}, extensions: {} }
  let total = 0
  let unreadable = 0
  const secrets = join(folder, 'secrets')
  if (existsSync(secrets)) {
    for (const name of readdirSync(secrets).filter((n) => n.endsWith('.bin'))) {
      total++
      const values = openHere(readFileSync(join(secrets, name)))
      if (values) bundle.projects[name.slice(0, -4)] = values
      else unreadable++
    }
  }
  for (const e of readExtensions(folder)) {
    if (!e.env) continue
    total++
    const values = openHere(Buffer.from(e.env, 'base64'))
    if (values) bundle.extensions[e.id] = values
    else unreadable++
  }
  return { bundle, total, unreadable }
}

function readExtensions(folder: string): { id: string; env?: string }[] {
  try {
    const parsed = JSON.parse(readFileSync(join(folder, 'extensions.json'), 'utf-8')) as { extensions?: { id: string; env?: string }[] }
    return Array.isArray(parsed.extensions) ? parsed.extensions : []
  } catch {
    return []
  }
}

// ---- backup and restore ----

/** Adds the password-locked copy to a backup being made. Returns whether one was written. */
export function writeLockedSecrets(dest: string): boolean {
  const password = backupPassword()
  if (!password) return false
  const { bundle } = readHere(app.getPath('userData'))
  if (!Object.keys(bundle.projects).length && !Object.keys(bundle.extensions).length) return false
  writeFileSync(join(dest, LOCKED), JSON.stringify(lockBundle(bundle, password)), 'utf-8')
  return true
}

/** Whether a backup's secrets will come back on this computer, and how. */
export function inspectSecrets(backup: string): BackupSecrets {
  const { total, unreadable } = readHere(backup)
  if (total === 0) return 'none'
  if (unreadable === 0) return 'here'
  return existsSync(join(backup, LOCKED)) ? 'locked' : 'lost'
}

/** Opens a backup's password-locked secrets (throws on a wrong password, before anything is changed). */
export function unlockBackupSecrets(backup: string, password: string): Bundle {
  const file = JSON.parse(readFileSync(join(backup, LOCKED), 'utf-8')) as LockedFile
  return unlockBundle(file, password)
}

/**
 * Makes a staged restore's secrets fit this computer: what was locked with another computer's
 * key is replaced by the unlocked copy (locked again with this computer's key), or dropped
 * when there's none, so those projects simply ask for their secrets again.
 */
export function fitSecretsToThisComputer(staged: string, unlocked: Bundle | null): void {
  rmSync(join(staged, LOCKED), { force: true })
  const lock = (values: Record<string, string>): Buffer => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer can't encrypt secrets right now, so they couldn't be restored.")
    return safeStorage.encryptString(JSON.stringify(values))
  }
  const secrets = join(staged, 'secrets')
  if (existsSync(secrets)) {
    for (const name of readdirSync(secrets).filter((n) => n.endsWith('.bin'))) {
      if (!openHere(readFileSync(join(secrets, name)))) rmSync(join(secrets, name), { force: true })
    }
  }
  if (unlocked) {
    for (const [id, values] of Object.entries(unlocked.projects)) {
      if (!/^[A-Za-z0-9_-]+$/.test(id) || !Object.keys(values).length) continue
      mkdirSync(secrets, { recursive: true })
      writeFileSync(join(secrets, `${id}.bin`), lock(values))
    }
  }
  const extFile = join(staged, 'extensions.json')
  if (existsSync(extFile)) {
    const parsed = JSON.parse(readFileSync(extFile, 'utf-8')) as { extensions?: { id: string; env?: string }[] }
    for (const e of parsed.extensions ?? []) {
      if (!e.env || openHere(Buffer.from(e.env, 'base64'))) continue
      const values = unlocked?.extensions[e.id]
      e.env = values && Object.keys(values).length ? lock(values).toString('base64') : ''
    }
    writeFileSync(extFile, JSON.stringify(parsed, null, 2), 'utf-8')
  }
}
