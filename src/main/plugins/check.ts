import { createHash } from 'crypto'
import { lstatSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { Script } from 'vm'
import { parseManifest, type PluginManifest } from '@shared/plugins'

// Reading and checking a plugin's folder. Nothing here needs Electron: Starwright uses it to list
// plugins, and the agents' tool server (memoryServer) uses it for plugin_check, so Claude and Codex
// can see what's wrong with a plugin they're writing before you're asked to approve it.

/** A plugin's folder may hold at most this much (a panel, its scripts and pictures). */
export const MAX_PLUGIN_FILES = 200
export const MAX_PLUGIN_BYTES = 5 * 1024 * 1024
/** Where a project's own plugins are. */
export const PROJECT_PLUGINS_DIR = join('.starwright', 'plugins')

/** Every file in a plugin's folder (relative paths with /), or a problem: too big, or a link. */
export function readPluginFiles(folder: string): { files: Map<string, Buffer>; hash: string } | { problem: string } {
  const files = new Map<string, Buffer>()
  let bytes = 0
  const walk = (dir: string, prefix: string): string | undefined => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      // A link could lead anywhere on the computer: plugins hold real files only.
      if (lstatSync(full).isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) return `"${rel}" is a link: a plugin's folder may only hold real files.`
      if (entry.isDirectory()) {
        const problem = walk(full, rel)
        if (problem) return problem
        continue
      }
      const content = readFileSync(full)
      bytes += content.length
      files.set(rel, content)
      if (files.size > MAX_PLUGIN_FILES) return `It has more than ${MAX_PLUGIN_FILES} files.`
      if (bytes > MAX_PLUGIN_BYTES) return `Its files come to more than ${MAX_PLUGIN_BYTES / 1024 / 1024} MB.`
    }
    return undefined
  }
  try {
    const problem = walk(folder, '')
    if (problem) return { problem }
  } catch (err) {
    return { problem: `Its folder can't be read: ${(err as Error).message}` }
  }
  const h = createHash('sha256')
  for (const [path, content] of files) {
    h.update(`${path}\0${content.length}\0`)
    h.update(content)
  }
  return { files, hash: h.digest('hex') }
}

export interface FolderCheck {
  /** Set when plugin.json itself is sound; the plugin is still broken while `problems` has anything. */
  manifest?: PluginManifest
  problems: string[]
  files?: Map<string, Buffer>
  hash?: string
}

/** Reads a plugin folder and checks its plugin.json against what's in the folder. */
export function checkPluginFolder(folder: string, folderName: string): FolderCheck {
  const read = readPluginFiles(folder)
  if ('problem' in read) return { problems: [read.problem] }
  const raw = read.files.get('plugin.json')
  if (!raw) return { problems: ['It has no plugin.json.'], files: read.files, hash: read.hash }
  let json: unknown
  try {
    json = JSON.parse(raw.toString('utf-8').replace(/^﻿/, ''))
  } catch (err) {
    return { problems: [`plugin.json isn't valid JSON: ${(err as Error).message}`], files: read.files, hash: read.hash }
  }
  const { manifest, problems } = parseManifest(json, folderName)
  if (!manifest) return { problems, files: read.files, hash: read.hash }
  const missing = manifest.panels.filter((p) => !read.files.has(p.entry)).map((p) => `Panel "${p.id}" names ${p.entry}, which isn't in the folder.`)
  for (const c of manifest.commands) {
    // A script of the plugin's own it runs, like "{plugin}/scan.js": it has to be there.
    const words = typeof c.run === 'string' ? c.run.split(/\s+/) : c.run
    for (const word of words) {
      const m = /\{plugin\}[\\/]([\w./-]+)/.exec(word.replace(/^['"]|['"]$/g, ''))
      if (m && !read.files.has(m[1])) missing.push(`Command "${c.id}" runs {plugin}/${m[1]}, which isn't in the folder.`)
    }
  }
  // With problems, the manifest is still returned (to show its title), but the plugin is broken.
  return { manifest, problems: missing, files: read.files, hash: read.hash }
}

/**
 * Things that would stop a plugin working that plugin.json doesn't show: scripts that don't parse,
 * pages that use window.starwright without its script, and anything loaded from the internet
 * (which the panel's frame blocks). For the agents' plugin_check.
 */
export function pluginWarnings(files: Map<string, Buffer>, manifest?: PluginManifest): string[] {
  const warnings: string[] = []
  const parse = (code: string, where: string): void => {
    try {
      new Script(code, { filename: where })
    } catch (err) {
      const message = (err as Error).message
      // Modules (import/export) can't be checked this way; Starwright doesn't need them to be.
      if (!/Cannot use import statement|Unexpected token 'export'|import\.meta/.test(message)) warnings.push(`${where} doesn't parse: ${message}`)
    }
  }
  for (const [path, content] of files) {
    const text = (): string => content.toString('utf-8')
    if (/\.(c?js)$/i.test(path)) parse(text(), path)
    if (/\.html?$/i.test(path)) {
      const html = text()
      let n = 0
      for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        n++
        if (!/\bsrc=/i.test(m[1]) && !/type=["']?module/i.test(m[1]) && m[2].trim()) parse(m[2], `${path} (script ${n})`)
      }
      const usesApi = /\bstarwright\./.test(html) || [...files].some(([p, c]) => /\.js$/i.test(p) && /\bstarwright\./.test(c.toString('utf-8')))
      if (manifest?.panels.some((p) => p.entry === path) && usesApi && !html.includes('/_starwright/api.js')) {
        warnings.push(`${path} uses window.starwright but doesn't load it: add <script src="/_starwright/api.js"></script> in its <head>.`)
      }
      for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+["']/gi)) {
        warnings.push(`${path} loads ${m[0].replace(/^\w+\s*=\s*/, '')} from the internet: a panel can't. Copy it into the plugin's folder.`)
      }
      for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']\/(?!_starwright\/api\.js)[^"']*["']/gi)) {
        warnings.push(`${path} uses ${m[0].replace(/^\w+\s*=\s*/, '')}, a path from the top: use a path relative to the page (like "style.css") so it works over Remote too.`)
      }
    }
    if (/\.(c?js|html?|css)$/i.test(path) && /\bfetch\(\s*["']https?:/.test(text())) {
      warnings.push(`${path} fetches from the internet: a panel can't. A command can, if the plugin has one.`)
    }
  }
  return warnings
}
