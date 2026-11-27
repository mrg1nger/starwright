import { createHash } from 'crypto'
import { mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// A private temp folder for the work Starwright runs on a project's behalf: hand-offs to the local
// model and Cline, Codex when it runs without its sandbox, and the project's tests after a change.
// On a real install (2026-11-27) a test the local model wrote "cleaned up" by emptying the whole of
// %TEMP%. Code deleting files is invisible to the command check, and the local model has no sandbox;
// with TEMP, TMP and TMPDIR pointed here, os.tmpdir() is this folder, so such a cleanup can only
// empty it. It's a folder inside the real temp folder (not Starwright's data folder, which the
// helpers' safety rules keep them out of), made again before each use if something cleared it.
// One folder per project (a hosted Cline keeps its environment between hand-offs); anything in it
// older than a day is cleared when it's next used.

const KEEP_MS = 24 * 60 * 60_000

/** The folder for a project (or a project folder, for the checks), made if needed. */
export function helperTempDir(key: string): string {
  const name = /^[A-Za-z0-9_-]{1,64}$/.test(key) ? key : createHash('sha1').update(key).digest('hex').slice(0, 16)
  const dir = join(tmpdir(), 'starwright-helpers', name)
  mkdirSync(dir, { recursive: true })
  try {
    const cutoff = Date.now() - KEEP_MS
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true })
      } catch {
        // In use, or gone already: next time.
      }
    }
  } catch {
    // Clearing is a courtesy.
  }
  return dir
}

/** The environment variables that make it the temp folder, for every program and test runner. */
export function tempEnv(dir: string): Record<string, string> {
  return { TEMP: dir, TMP: dir, TMPDIR: dir }
}

/** Both at once: the environment for work on this project (or project folder). Never throws. */
export function helperTempEnv(key: string): Record<string, string> {
  try {
    return tempEnv(helperTempDir(key))
  } catch {
    return {}
  }
}
