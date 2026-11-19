// Hides a project's secret values in what Starwright shows and keeps (the chat, its transcript,
// a helper's activity). Agents get the secrets as environment variables so their commands work,
// and a command can print one (`env`, a config dump, an error message): this keeps the value out.

export interface SecretValue {
  name: string
  value: string
}

/** Values shorter than this aren't masked: they'd match ordinary words and numbers. */
export const MIN_MASKED_LENGTH = 8

/** What a value turns into. */
export function secretLabel(name: string): string {
  return `[secret ${name}]`
}

interface Needle {
  text: string
  label: string
}

/** Each value as it can appear: as it is, and escaped inside JSON text (a tool's raw output). */
function needles(secrets: SecretValue[]): Needle[] {
  const out: Needle[] = []
  for (const { name, value } of secrets) {
    if (value.length < MIN_MASKED_LENGTH) continue
    const label = secretLabel(name)
    out.push({ text: value, label })
    const escaped = JSON.stringify(value).slice(1, -1)
    if (escaped !== value) out.push({ text: escaped, label })
  }
  // Longest first, so a secret that contains another is replaced whole.
  return out.sort((a, b) => b.text.length - a.text.length)
}

function replaceAll(text: string, list: Needle[]): string {
  let result = text
  for (const n of list) if (result.includes(n.text)) result = result.split(n.text).join(n.label)
  return result
}

/** The text with every secret value replaced by its label. */
export function maskText(text: string, secrets: SecretValue[]): string {
  if (!text || !secrets.length) return text
  return replaceAll(text, needles(secrets))
}

function maskWith<T>(value: T, list: Needle[]): T {
  if (typeof value === 'string') return replaceAll(value, list) as T
  if (Array.isArray(value)) return value.map((v) => maskWith(v, list)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskWith(v, list)])) as T
  }
  return value
}

/**
 * A copy of the value (an event, a result) with every string masked. The value itself comes back
 * when there's nothing to mask, which is nearly always.
 */
export function maskDeep<T>(value: T, secrets: SecretValue[]): T {
  if (!secrets.length || value === null || value === undefined) return value
  const list = needles(secrets)
  if (!list.length) return value
  let flat: string
  try {
    flat = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return value
  }
  if (!flat || !list.some((n) => flat.includes(n.text))) return value
  return maskWith(value, list)
}
