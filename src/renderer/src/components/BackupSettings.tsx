import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, BackupInfo } from '@shared/types'

interface BackupSettingsProps {
  settings: AppSettings
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>
  onError: (message: string) => void
}

const size = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`

const clean = (err: unknown): string => (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Backups of VibeApp's own data: once a day, on demand, export, and restore. */
function BackupSettings({ settings, onSettingsChange, onError }: BackupSettingsProps) {
  const [status, setStatus] = useState<{ dir: string; defaultDir: string; backups: BackupInfo[]; passwordSet: boolean } | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const [dir, setDir] = useState(settings.backupDir ?? '')
  const [exportTo, setExportTo] = useState('')
  const [restoreFrom, setRestoreFrom] = useState('')
  // Setting the backup password.
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [changingPw, setChangingPw] = useState(false)
  // A restore whose secrets were locked on another computer with the backup password: asked for here.
  const [unlock, setUnlock] = useState<{ path: string; when: string } | null>(null)
  const [unlockPw, setUnlockPw] = useState('')

  const reload = useCallback(() => {
    window.vibe.backup.status().then(setStatus).catch((err) => onError(clean(err)))
  }, [onError])
  useEffect(() => {
    reload()
  }, [reload, settings.backupLastAt])

  const act = async (what: string, work: () => Promise<unknown>): Promise<void> => {
    setWorking(what)
    try {
      await work()
      reload()
    } catch (err) {
      onError(clean(err))
    } finally {
      setWorking(null)
    }
  }

  const confirmRestore = (when: string, extra = ''): boolean =>
    window.confirm(
      `Restore Starwright's data from the backup of ${when}?\n\nYour memory, chats, notes, settings and secrets go back to how they were then. Your current data is backed up first, so you can undo this by restoring that. Starwright restarts to finish.${extra}`
    )

  const restore = async (path: string, when: string): Promise<void> => {
    let secrets
    try {
      secrets = (await window.vibe.backup.inspect(path)).secrets
    } catch (err) {
      return onError(clean(err))
    }
    if (secrets === 'locked') {
      // Asked for below; the restore goes when it's entered (or skipped).
      setUnlockPw('')
      setUnlock({ path, when })
      return
    }
    const lost =
      secrets === 'lost'
        ? "\n\nThis backup's secrets and extension keys were made on another computer and it has no backup password, so they can't come back: you'll enter them again."
        : ''
    if (confirmRestore(when, lost)) void act('restore', () => window.vibe.backup.restore(path))
  }

  const restoreUnlocked = (password: string): void => {
    if (!unlock) return
    const { path, when } = unlock
    const skip = password ? '' : "\n\nWithout the backup password its secrets and extension keys stay out: you'll enter them again."
    if (!confirmRestore(when, skip)) return
    void act('restore', async () => {
      await window.vibe.backup.restore(path, password || undefined)
      setUnlock(null)
    })
  }

  const savePassword = (): void => {
    if (pw !== pw2) return onError("The two passwords aren't the same.")
    void act('password', async () => {
      await window.vibe.backup.setPassword(pw)
      setPw('')
      setPw2('')
      setChangingPw(false)
    })
  }

  const removePassword = (): void => {
    if (
      !window.confirm(
        "Remove the backup password?\n\nNew backups won't carry your secrets any more, so on another computer they'd have to be entered again. Backups already made keep theirs (locked with the old password)."
      )
    )
      return
    void act('password', () => window.vibe.backup.setPassword(null))
  }

  return (
    <>
      <label className="settings-toggle">
        <input type="checkbox" checked={settings.backupDaily} onChange={(e) => onSettingsChange({ backupDaily: e.target.checked }).catch(() => undefined)} />
        <span>
          Back up Starwright's data every day
          <small>
            Memory, chat history, to-dos and notes, settings, secrets, deploy steps, extensions and themes: everything that isn't in
            your project's own files. Your code is in git; this is what would be lost with this computer's disk. The newest{' '}
            {settings.backupKeep} are kept.
          </small>
        </span>
      </label>
      <label className="settings-field">
        <span>Backup folder</span>
        <input
          value={dir}
          placeholder={status?.defaultDir ?? ''}
          onChange={(e) => setDir(e.target.value)}
          onBlur={() => dir.trim() !== (settings.backupDir ?? '') && onSettingsChange({ backupDir: dir.trim() || null }).catch(() => undefined)}
        />
        <small>A different drive, or a OneDrive or Dropbox folder, keeps them safe even if this disk fails. Leave empty for {status?.defaultDir}.</small>
      </label>
      <p className="review-muted">
        {settings.backupLastAt ? `Last backup: ${new Date(settings.backupLastAt).toLocaleString()}.` : 'No backup yet.'}
        {settings.backupLastError && <span className="chat-error"> The last try failed: {settings.backupLastError}</span>}
      </p>
      <div className="backup-actions">
        <button disabled={!!working} onClick={() => act('now', () => window.vibe.backup.now())}>
          {working === 'now' ? 'Backing up…' : 'Back up now'}
        </button>
      </div>

      {status && status.backups.length > 0 && (
        <details className="backup-list">
          <summary>
            {status.backups.length} backup{status.backups.length === 1 ? '' : 's'} in {status.dir}
          </summary>
          <ul>
            {status.backups.map((b) => {
              const when = new Date(b.createdAt).toLocaleString()
              return (
                <li key={b.path}>
                  <span>
                    {when} · {size(b.bytes)}
                    {b.reason === 'before restore' ? ' · made before a restore' : b.reason === 'manual' ? ' · made by hand' : ''}
                    {b.secretsLocked ? ' · secrets included' : ''}
                  </span>
                  <button className="chat-inline-action" disabled={!!working} onClick={() => void restore(b.path, when)}>
                    Restore
                  </button>
                </li>
              )
            })}
          </ul>
        </details>
      )}

      {unlock && (
        <div className="backup-unlock">
          <p className="modal-text">
            This backup was made on another computer. Its secrets and extension keys are locked with the backup password set there:
            enter it to bring them back.
          </p>
          <div className="backup-path-row">
            <input
              type="password"
              autoFocus
              value={unlockPw}
              placeholder="Backup password"
              aria-label="Backup password"
              onChange={(e) => setUnlockPw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && unlockPw && restoreUnlocked(unlockPw)}
            />
            <button disabled={!!working || !unlockPw} onClick={() => restoreUnlocked(unlockPw)}>
              {working === 'restore' ? 'Restoring…' : 'Restore'}
            </button>
          </div>
          <div className="backup-actions">
            <button disabled={!!working} onClick={() => restoreUnlocked('')}>
              Restore without secrets
            </button>
            <button disabled={!!working} onClick={() => setUnlock(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="backup-password">
        <strong>Backup password</strong>
        <small>
          Secrets and extension keys are locked to this computer&apos;s Windows account, so on its own a backup can&apos;t bring them to
          another computer. With a backup password, every backup also carries them locked with it, and restoring on another computer
          asks for it. The password stays on this computer, never in a backup. Use a real passphrase: anyone with a backup and the
          password gets your keys. If you forget it, everything else still restores.
        </small>
        {status?.passwordSet && !changingPw ? (
          <div className="backup-actions">
            <span className="review-muted">Set: backups include your secrets.</span>
            <button disabled={!!working} onClick={() => setChangingPw(true)}>
              Change…
            </button>
            <button disabled={!!working} onClick={removePassword}>
              Remove
            </button>
          </div>
        ) : (
          <div className="backup-path-row">
            <input
              type="password"
              value={pw}
              placeholder="New backup password (10+ characters)"
              aria-label="New backup password"
              onChange={(e) => setPw(e.target.value)}
            />
            <input type="password" value={pw2} placeholder="Again" aria-label="The backup password again" onChange={(e) => setPw2(e.target.value)} />
            <button disabled={!!working || pw.length < 10 || !pw2} onClick={savePassword}>
              {working === 'password' ? 'Saving…' : 'Set'}
            </button>
            {changingPw && (
              <button disabled={!!working} onClick={() => setChangingPw(false)}>
                Cancel
              </button>
            )}
          </div>
        )}
        {status?.passwordSet && changingPw && <small>Backups already made keep the old password; new ones use the new one.</small>}
      </div>

      <details className="backup-list">
        <summary>Move Starwright to another computer (export / import)</summary>
        <p className="review-muted">
          Export makes a backup in any folder (a USB stick, say). On the other computer, install Starwright, then restore from that
          folder here. Secrets and extension keys come along when a backup password is set (above); otherwise you&apos;ll enter them
          again there. Devices for Remote access pair again too.
        </p>
        <div className="backup-path-row">
          <input value={exportTo} placeholder="Folder to export to, e.g. E:\" onChange={(e) => setExportTo(e.target.value)} />
          <button disabled={!!working || !exportTo.trim()} onClick={() => act('export', () => window.vibe.backup.export(exportTo.trim()))}>
            {working === 'export' ? 'Exporting…' : 'Export'}
          </button>
        </div>
        <div className="backup-path-row">
          <input value={restoreFrom} placeholder="A backup folder to restore, e.g. E:\Starwright backup 2026-10-26 …" onChange={(e) => setRestoreFrom(e.target.value)} />
          <button disabled={!!working || !restoreFrom.trim()} onClick={() => void restore(restoreFrom.trim(), 'that folder')}>
            Restore
          </button>
        </div>
      </details>
    </>
  )
}

export default BackupSettings
