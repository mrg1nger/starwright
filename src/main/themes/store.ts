import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { THEME_VARS, type ThemeDefinition, type ThemeVar } from '@shared/types'
import { BUILT_IN_THEMES } from './builtin'

/** Theme extensions: one JSON file per theme, droppable by hand or written by the generator. */
export function themesDir(): string {
  const dir = join(app.getPath('userData'), 'themes')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// Themes only ever become CSS custom property values (set via
// style.setProperty, so they can't break out into other rules). Still reject
// anything that could load resources or isn't plausibly a style value.
const UNSAFE_VALUE = /url\s*\(|image-set\s*\(|expression\s*\(|@import|[;{}<>\\]/i

export function validateTheme(raw: unknown, source: ThemeDefinition['source']): ThemeDefinition {
  const t = raw as Partial<ThemeDefinition> & { vars?: Record<string, unknown> }
  if (!t || typeof t.name !== 'string' || !t.name.trim()) throw new Error('Theme needs a name.')
  if (!t.vars || typeof t.vars !== 'object') throw new Error('Theme needs a vars object.')
  const vars = {} as Record<ThemeVar, string>
  for (const key of THEME_VARS) {
    const value = t.vars[key]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Theme is missing "${key}".`)
    if (value.length > 600 || UNSAFE_VALUE.test(value)) throw new Error(`Theme value for "${key}" isn't allowed.`)
    vars[key] = value.trim()
  }
  const name = t.name.trim().slice(0, 60)
  return {
    id: typeof t.id === 'string' && /^[a-z0-9-]{1,60}$/.test(t.id) ? t.id : slug(name),
    name,
    description: typeof t.description === 'string' ? t.description.slice(0, 200) : undefined,
    thinkingLabel:
      typeof t.thinkingLabel === 'string' && t.thinkingLabel.trim()
        ? t.thinkingLabel.trim().slice(0, 80)
        : undefined,
    source,
    vars,
    ...(typeof t.imageDim === 'number' && Number.isFinite(t.imageDim) ? { imageDim: Math.min(0.85, Math.max(0, t.imageDim)) } : {})
  }
}

// A theme's background picture is <id>.jpg next to its JSON, with a small <id>.thumb.jpg for its
// card. It's handed to the screen as a data: URL that Starwright builds itself, so a theme file
// still can't point at anything (url() stays refused above).
const imageFile = (id: string): string => join(themesDir(), `${id}.jpg`)
const thumbFile = (id: string): string => join(themesDir(), `${id}.thumb.jpg`)

const imageCache = new Map<string, { mtime: number; url: string }>()

/** The theme's background picture as a data: URL, or null when it has none. */
export function themeImage(id: string): string | null {
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,60}$/.test(id)) return null
  try {
    const file = imageFile(id)
    if (!existsSync(file)) return null
    const mtime = statSync(file).mtimeMs
    const cached = imageCache.get(id)
    if (cached?.mtime === mtime) return cached.url
    const url = `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`
    imageCache.set(id, { mtime, url })
    return url
  } catch {
    return null
  }
}

function withPicture(theme: ThemeDefinition): ThemeDefinition {
  try {
    if (!existsSync(imageFile(theme.id))) return theme
    const thumb = existsSync(thumbFile(theme.id)) ? `data:image/jpeg;base64,${readFileSync(thumbFile(theme.id)).toString('base64')}` : undefined
    return { ...theme, hasImage: true, imagePreview: thumb }
  } catch {
    return theme
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'theme'
}

export function listThemes(): ThemeDefinition[] {
  const custom: ThemeDefinition[] = []
  for (const file of readdirSync(themesDir()).filter((f) => f.endsWith('.json'))) {
    try {
      const raw = JSON.parse(readFileSync(join(themesDir(), file), 'utf-8'))
      const source = raw?.source === 'generated' ? 'generated' : 'custom'
      custom.push(withPicture({ ...validateTheme(raw, source), id: file.replace(/\.json$/, '') }))
    } catch {
      // Skip a broken extension rather than failing the whole list.
    }
  }
  const builtInIds = new Set(BUILT_IN_THEMES.map((t) => t.id))
  return [...BUILT_IN_THEMES, ...custom.filter((t) => !builtInIds.has(t.id))]
}

/** Saves a theme as an extension file, picking a unique id, with its background picture (JPEG) if it has one. */
export function saveTheme(theme: ThemeDefinition, picture?: { image: Buffer; thumb: Buffer }): ThemeDefinition {
  const taken = new Set(listThemes().map((t) => t.id))
  let id = theme.id
  for (let n = 2; taken.has(id); n++) id = `${theme.id}-${n}`
  const { hasImage: _h, imagePreview: _p, ...rest } = theme
  const saved = { ...rest, id }
  if (picture) {
    writeFileSync(imageFile(id), picture.image)
    writeFileSync(thumbFile(id), picture.thumb)
  }
  writeFileSync(join(themesDir(), `${id}.json`), JSON.stringify(saved, null, 2), 'utf-8')
  return withPicture(saved)
}

export function deleteTheme(id: string): void {
  if (BUILT_IN_THEMES.some((t) => t.id === id)) throw new Error("Built-in themes can't be deleted.")
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid theme id.')
  rmSync(join(themesDir(), `${id}.json`), { force: true })
  rmSync(imageFile(id), { force: true })
  rmSync(thumbFile(id), { force: true })
  imageCache.delete(id)
}
