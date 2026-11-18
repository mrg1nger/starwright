import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { nativeImage } from 'electron'
import { spawn } from 'child_process'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { THEME_VARS, type ThemeDefinition } from '@shared/types'
import { resolveClaudeExecutable } from '../cli/claudeBinary'
import { killTree, resolveCodexLaunch, trackChild } from '../cli/codexExec'
import { getSettings } from '../settings/store'
import { BUILT_IN_THEMES } from './builtin'
import { saveTheme, validateTheme } from './store'

const THEME_PROPERTIES = {
  name: { type: 'string', description: 'Short theme name, 1-4 words.' },
  description: { type: 'string', description: 'One sentence describing the vibe.' },
  thinkingLabel: {
    type: 'string',
    description: 'Status text shown while Claude works, in the theme\'s voice (under 40 chars).'
  },
  vars: {
    type: 'object',
    properties: Object.fromEntries(THEME_VARS.map((v) => [v, { type: 'string' }])),
    required: [...THEME_VARS],
    additionalProperties: false
  }
}

const THEME_SCHEMA = {
  type: 'object',
  properties: THEME_PROPERTIES,
  required: ['name', 'description', 'thinkingLabel', 'vars'],
  additionalProperties: false
}

const PICTURE_THEME_SCHEMA = {
  type: 'object',
  properties: {
    ...THEME_PROPERTIES,
    imageDim: {
      type: 'number',
      description: 'How strongly bg is laid over the picture so text reads, 0 to 0.85 (0.3-0.55 is typical).'
    }
  },
  required: ['name', 'description', 'thinkingLabel', 'vars', 'imageDim'],
  additionalProperties: false
}

function buildPrompt(description: string, withPicture: boolean): string {
  const examples = BUILT_IN_THEMES.map((t) => JSON.stringify({ name: t.name, thinkingLabel: t.thinkingLabel, vars: t.vars }, null, 1)).join('\n\n')
  const picture = withPicture
    ? `

The attached picture is this theme's background: it fills the whole window behind everything. Pick every color from it, so the theme looks like it belongs to the picture:
- bg: the picture's main tone (dark for a night or dusk scene). It is laid over the picture at imageDim strength, so text reads on any part of it. Pick imageDim for that: more for a busy or bright picture, less for a calm one.
- bg-image: "none" (the picture takes its place).
- surface, surface-raised and surface-sunken: semi-transparent rgba() (alpha 0.72-0.9) so the picture shows faintly through panels while their text stays clearly readable.
- accent and user-bubble: a color that stands out in the picture (a lantern, a sky, a flower), with accent-text readable on it.`
    : ''
  return `Design a color theme for Starwright, a desktop app for chatting with AI coding agents.

The user wants: ${description}

A theme is a set of CSS custom property values. Rules:
- Every value must be a plain CSS value: colors (hex, rgb/rgba, hsl), gradients (linear-/radial-/repeating-*-gradient), lengths, font stacks, box-shadows, or "none".
- Never use url(), image-set(), @import, semicolons, braces, angle brackets or backslashes. No external images or fonts; only fonts likely installed on Windows. No Japanese, Chinese or Korean fonts (Yu Gothic, Meiryo, MS Gothic, Noto Sans JP...): they draw the backslash in Windows paths as a yen or won sign.
- font: a font-family stack. radius: a length like 8px.
- bg: solid page color. bg-image: decorative layered gradients drawn over bg, or "none".
- surface / surface-raised / surface-sunken: panel, button and input backgrounds (surface may be semi-transparent so bg-image shows through).
- text must be clearly readable on bg and every surface; text-muted a bit dimmer but still readable.
- accent: main action color; accent-text must be readable on accent. accent-glow: a box-shadow or "none".
- title: a gradient used as the app title's text fill (use linear-gradient(c, c) for a solid color).
- user-bubble: background of the user's chat messages (color or gradient), with accent-text on it.
- success/warning/danger/delegation: badge and banner colors; each *-text readable on its *-bg.
- overlay: translucent backdrop behind dialogs.${picture}

Here are the two built-in themes for reference:

${examples}

Be creative and make it match the request, while keeping everything readable.`
}

/** The picture prompt Codex is given (the user's description is the subject). */
export function picturePrompt(description: string): string {
  return `Generate exactly one image with your image generation tool, then save it in the current folder as background.png (PNG).

It is a wide 16:9 desktop wallpaper for a chat app's background: ${description}

Make it detailed and atmospheric, with no text, letters, signatures, logos, watermarks, borders or user interface in it. Keep the very centre free of harsh, high-contrast detail, since chat text sits over it.

Don't do anything else: no other files, no commands beyond saving the image. Reply with just the file name.`
}

const PICTURE_TIMEOUT_MS = 6 * 60_000

/**
 * Codex draws the picture (its built-in image generation) in a throwaway folder. Returns it as a
 * JPEG of at most 1920 px wide, and a small copy for the theme card.
 */
export async function drawPicture(description: string): Promise<{ image: Buffer; thumb: Buffer }> {
  const dir = mkdtempSync(join(tmpdir(), 'starwright-picture-'))
  let threadId: string | undefined
  try {
    const launch = await resolveCodexLaunch()
    const args = [
      ...launch.prefixArgs,
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--json',
      '--color',
      'never',
      '-s',
      'workspace-write',
      '-C',
      dir,
      '-'
    ]
    const env = { ...(launch.env ?? process.env) }
    if (!launch.env?.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE
    const said: string[] = []
    let stderr = ''
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = trackChild(spawn(launch.file, args, { cwd: dir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }))
      const timer = setTimeout(() => {
        killTree(child)
        reject(new Error('Codex took more than 6 minutes to draw the picture.'))
      }, PICTURE_TIMEOUT_MS)
      let buffered = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf-8')
        let nl: number
        while ((nl = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, nl).trim()
          buffered = buffered.slice(nl + 1)
          try {
            const event = JSON.parse(line) as { type?: string; thread_id?: string; message?: string; item?: { type?: string; text?: string } }
            if (event.type === 'thread.started') threadId = event.thread_id
            if (event.item?.type === 'agent_message' && event.item.text) said.push(event.item.text)
            if (event.type === 'error' && event.message) said.push(event.message)
          } catch {
            // not an event line
          }
        }
      })
      child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString('utf-8')).slice(-2000)))
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('close', (exitCode) => {
        clearTimeout(timer)
        resolve(exitCode)
      })
      child.stdin.end(picturePrompt(description))
    })
    const file = readdirSync(dir)
      .filter((f) => /\.(png|jpe?g)$/i.test(f))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).size - statSync(a).size)[0]
    if (!file) {
      const why = said.at(-1) ?? stderr.trim().split(/\r?\n/).at(-1) ?? `it stopped (exit ${code})`
      throw new Error(`Codex didn't make a picture: ${why.slice(0, 300)}`)
    }
    let picture = nativeImage.createFromPath(file)
    if (picture.isEmpty()) throw new Error("Codex's picture couldn't be read.")
    if (picture.getSize().width > 1920) picture = picture.resize({ width: 1920, quality: 'best' })
    return { image: picture.toJPEG(86), thumb: picture.resize({ width: 360, quality: 'good' }).toJPEG(80) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    // Codex keeps its own copy of every picture it makes; this one lives in the theme now.
    if (threadId && /^[0-9a-f-]{8,}$/i.test(threadId)) {
      const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
      rmSync(join(codexHome, 'generated_images', threadId), { recursive: true, force: true })
    }
  }
}

/**
 * Claude's answer made safe to save where it can be: bg-image is only decoration, so a value the
 * theme check would refuse (url(), image-set()) is dropped rather than losing the whole theme; with a
 * picture it's always "none", since the picture takes its place.
 */
export function cleanGenerated(raw: unknown, withPicture: boolean): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const theme = raw as { vars?: Record<string, unknown> }
  if (!theme.vars || typeof theme.vars !== 'object') return raw
  const bgImage = theme.vars['bg-image']
  const unsafe = typeof bgImage !== 'string' || !bgImage.trim() || /url\s*\(|image-set\s*\(|expression\s*\(|@import|[;{}<>\\]/i.test(bgImage)
  if (withPicture || unsafe) return { ...theme, vars: { ...theme.vars, 'bg-image': 'none' } }
  return raw
}

/** A generated theme, and why it has no picture when one was asked for and Codex couldn't draw it. */
export type GeneratedTheme = ThemeDefinition & { pictureError?: string }

/**
 * Asks Claude to design a theme from a description, then validates and saves it as an extension.
 * With a picture, Codex draws the background first and Claude picks the colors from it; if Codex
 * can't (signed out, out of usage), the theme is made with colors only and says why.
 */
export async function generateTheme(description: string, withPicture = false): Promise<GeneratedTheme> {
  const request = description.trim().slice(0, 500)
  if (!request) throw new Error('Describe the theme you want first.')

  let picture: { image: Buffer; thumb: Buffer } | undefined
  let pictureError: string | undefined
  if (withPicture) {
    try {
      picture = await drawPicture(request)
    } catch (err) {
      pictureError = (err as Error).message
    }
  }

  // Throwaway working dir: no tools are enabled, but keep Claude Code from
  // picking up any project's CLAUDE.md or settings.
  const cwd = mkdtempSync(join(tmpdir(), 'vibeapp-theme-'))
  try {
    let retryNote = ''
    for (let attempt = 1; ; attempt++) {
      const raw = await askForTheme(cwd, buildPrompt(request, !!picture) + retryNote, picture)
      let theme: ThemeDefinition
      try {
        theme = validateTheme(cleanGenerated(raw, !!picture), 'generated')
      } catch (err) {
        // One more go, told what was wrong (the picture is kept, not drawn again).
        if (attempt >= 2) throw err
        retryNote = `\n\nYour last answer was refused: ${(err as Error).message} Follow the value rules exactly this time.`
        continue
      }
      const saved = saveTheme(picture ? { ...theme, imageDim: theme.imageDim ?? 0.4 } : theme, picture)
      return pictureError ? { ...saved, pictureError } : saved
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

/** One request to Claude for a theme (with the picture attached, if there is one); returns its JSON answer. */
async function askForTheme(cwd: string, text: string, picture: { image: Buffer } | undefined): Promise<unknown> {
  {
    const prompt: string | AsyncIterable<SDKUserMessage> = picture
      ? (async function* () {
          yield {
            type: 'user',
            message: {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: picture.image.toString('base64') } },
                { type: 'text', text }
              ]
            },
            parent_tool_use_id: null
          } as SDKUserMessage
        })()
      : text
    const q = query({
      prompt,
      options: {
        cwd,
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        model: getSettings().claudeModel ?? undefined,
        tools: [],
        maxTurns: 3,
        outputFormat: { type: 'json_schema', schema: picture ? PICTURE_THEME_SCHEMA : THEME_SCHEMA }
      }
    })
    for await (const message of q) {
      if (message.type !== 'result') continue
      if (message.subtype !== 'success') {
        throw new Error(`Theme generation failed (${message.subtype}).`)
      }
      if (!message.structured_output) throw new Error('Claude didn\'t return a theme.')
      return message.structured_output
    }
    throw new Error('Theme generation ended without a result.')
  }
}
