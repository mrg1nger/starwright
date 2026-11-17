import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { UsageSnapshot, UsageWindow } from '@shared/types'

// ClinePass plan usage (the 5-hour, weekly and monthly bars on app.cline.bot), read the way
// Cline's own dashboard reads it: one GET with an API key the user made for this. The key is
// encrypted with the Windows account's key and only ever sent to api.cline.bot. Cline doesn't
// document this request as a public API, so anything unexpected shows as "usage unavailable"
// rather than breaking anything.

export const CLINE_USAGE_URL = 'https://api.cline.bot/api/v1/users/me/plan/usage-limits'
const TIMEOUT_MS = 20_000

function keyFile(): string {
  return join(app.getPath('userData'), 'cline-usage-key.bin')
}

export function clineUsageKey(): string | null {
  const file = keyFile()
  if (!existsSync(file)) return null
  try {
    return safeStorage.decryptString(readFileSync(file)) || null
  } catch {
    return null // saved on another computer or Windows account: enter it again
  }
}

export function setClineUsageKey(key: string | null): void {
  const file = keyFile()
  const value = key?.trim()
  if (!value) {
    rmSync(file, { force: true })
    return
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer can't encrypt keys right now, so the key wasn't saved.")
  writeFileSync(file, safeStorage.encryptString(value))
}

/** What Settings shows: whether a key is saved, and its last four characters. */
export function clineUsageKeyStatus(): { saved: boolean; hint?: string } {
  const key = clineUsageKey()
  return key ? { saved: true, hint: `••••${key.slice(-4)}` } : { saved: false }
}

const LABELS: Record<string, string> = { five_hour: '5-hour', weekly: 'Weekly', monthly: 'Monthly' }

function toMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string' && value.trim()) {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return toMs(Number(value))
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

/**
 * The windows in Cline's answer ({ success: true, data: { limits: [{ type, percentUsed, resetsAt }] } }).
 * Throws when the answer isn't that shape. percentUsed is read as 0-100, or as a fraction when
 * every value is at most 1 and one of them has a decimal part (0.29 for 29%).
 */
export function parseClineLimits(payload: unknown): UsageWindow[] {
  const body = payload as { success?: unknown; data?: { limits?: unknown } } | null
  if (!body || typeof body !== 'object' || body.success === false) throw new Error("Cline's answer wasn't usage limits.")
  const limits = body.data?.limits
  if (!Array.isArray(limits)) throw new Error("Cline's answer had no usage limits in it.")
  const items = limits
    .filter((l): l is { type: string; percentUsed?: unknown; resetsAt?: unknown } => !!l && typeof l === 'object' && typeof l.type === 'string')
    .map((l) => ({ type: l.type, used: Number(l.percentUsed), resetsAt: toMs(l.resetsAt) }))
    .filter((l) => Number.isFinite(l.used))
  const fractions = items.length > 0 && items.every((l) => l.used <= 1) && items.some((l) => l.used > 0 && l.used < 1)
  const order = ['five_hour', 'weekly', 'monthly']
  return items
    .sort((a, b) => (order.indexOf(a.type) + 1 || 99) - (order.indexOf(b.type) + 1 || 99))
    .map((l) => ({
      label: LABELS[l.type] ?? l.type.replace(/_/g, ' '),
      usedPercent: Math.max(0, Math.min(100, Math.round((fractions ? l.used * 100 : l.used) * 10) / 10)),
      resetsAt: l.resetsAt
    }))
}

/** One check of ClinePass usage. No key saved: 'unavailable', with what to do. */
export async function fetchClineUsage(key = clineUsageKey()): Promise<UsageSnapshot> {
  const base = { cli: 'cline' as const, fetchedAt: Date.now(), windows: [] as UsageWindow[] }
  if (!key) return { ...base, status: 'unavailable', message: 'Add a Cline API key in Settings → Cline (ClinePass) to see ClinePass usage.' }
  let response: Response
  try {
    response = await fetch(CLINE_USAGE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    throw new Error(`Couldn't reach Cline (${(err as Error).message}).`)
  }
  if (response.status === 401 || response.status === 403) throw new Error('Cline turned the API key down: make a new one at app.cline.bot → Settings → API Keys.')
  if (response.status === 404) throw new Error("Cline doesn't answer usage requests at that address any more.")
  if (response.status === 429) throw new Error('Cline asked Starwright to check less often.')
  if (!response.ok) throw new Error(`Cline answered ${response.status}.`)
  const windows = parseClineLimits(await response.json().catch(() => null))
  return {
    ...base,
    fetchedAt: Date.now(),
    status: windows.length ? 'ok' : 'unavailable',
    plan: 'ClinePass',
    windows,
    message: windows.length ? undefined : 'Cline reported no usage limits for this account (is it on ClinePass?).'
  }
}
