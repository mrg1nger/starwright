import { test } from 'node:test'
import assert from 'node:assert/strict'
import { THEME_VARS } from '@shared/types'
import { cleanGenerated } from '../../src/main/themes/generate'
import { validateTheme } from '../../src/main/themes/store'

function answer(bgImage: string): { name: string; vars: Record<string, string> } {
  const vars = Object.fromEntries(THEME_VARS.map((v) => [v, '#334455'])) as Record<string, string>
  vars.font = 'Segoe UI, sans-serif'
  vars.radius = '8px'
  vars['bg-image'] = bgImage
  return { name: 'Dusk Village', vars }
}

test("with a picture, bg-image is always none: a url() Claude puts there (seen on Lazarus) no longer loses the theme", () => {
  const raw = answer('url(background.png) center / cover, linear-gradient(#000, #111)')
  assert.throws(() => validateTheme(raw, 'generated'), /bg-image/, 'refused as it was')
  const theme = validateTheme(cleanGenerated(raw, true), 'generated')
  assert.equal(theme.vars['bg-image'], 'none')
  assert.equal(theme.vars.bg, '#334455', 'the rest is kept')
})

test('with a picture, even a harmless gradient gives way to the picture', () => {
  const theme = validateTheme(cleanGenerated(answer('linear-gradient(#000, #111)'), true), 'generated')
  assert.equal(theme.vars['bg-image'], 'none')
})

test('without a picture, a safe gradient is kept and an unsafe or missing one is dropped', () => {
  assert.equal(validateTheme(cleanGenerated(answer('radial-gradient(#fff, #000)'), false), 'generated').vars['bg-image'], 'radial-gradient(#fff, #000)')
  assert.equal(validateTheme(cleanGenerated(answer('image-set("a.png" 1x)'), false), 'generated').vars['bg-image'], 'none')
  assert.equal(validateTheme(cleanGenerated(answer(''), false), 'generated').vars['bg-image'], 'none')
})

test('other refused values still refuse the theme (Claude is asked again)', () => {
  const raw = answer('none')
  raw.vars.accent = 'url(x)'
  assert.throws(() => validateTheme(cleanGenerated(raw, true), 'generated'), /accent/)
})
