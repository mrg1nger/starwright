import { THEME_VARS, type ThemeDefinition } from '@shared/types'

/** Applies a theme by setting its whitelisted CSS custom properties on the root element. */
export function applyTheme(theme: ThemeDefinition): void {
  const root = document.documentElement.style
  for (const key of THEME_VARS) {
    // Japanese fonts (Yu Gothic, Meiryo, MS Gothic...) draw the backslash as ¥, so Windows paths
    // read D:¥Vibe¥... The backslash alone comes from a font that draws it as one (styles.css).
    root.setProperty(`--${key}`, key === 'font' ? `'Starwright Backslash', ${theme.vars[key]}` : theme.vars[key])
  }
  document.documentElement.dataset.theme = theme.id
  showPicture(theme)
}

/**
 * The theme's background picture, drawn behind the whole app (body::before in styles.css) with the
 * theme's own bg color laid over it at imageDim strength so text stays readable.
 */
function showPicture(theme: ThemeDefinition): void {
  const root = document.documentElement
  if (!theme.hasImage) {
    root.style.setProperty('--theme-picture', 'none')
    delete root.dataset.picture
    return
  }
  const dim = Math.round((theme.imageDim ?? 0.4) * 100)
  root.style.setProperty('--theme-picture-dim', `${dim}%`)
  window.vibe.themes
    .image(theme.id)
    .then((url) => {
      if (root.dataset.theme !== theme.id) return // another theme was chosen meanwhile
      if (!url) {
        root.style.setProperty('--theme-picture', 'none')
        delete root.dataset.picture
        return
      }
      root.style.setProperty('--theme-picture', `url("${url}")`)
      root.dataset.picture = '1'
    })
    .catch(() => undefined)
}
