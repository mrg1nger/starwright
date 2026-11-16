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
}
