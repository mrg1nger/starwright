import hljs from 'highlight.js/lib/common'
import powershell from 'highlight.js/lib/languages/powershell'
import dos from 'highlight.js/lib/languages/dos'
import dockerfile from 'highlight.js/lib/languages/dockerfile'

hljs.registerLanguage('powershell', powershell)
hljs.registerLanguage('dos', dos)
hljs.registerLanguage('dockerfile', dockerfile)

/** Past this size a file is shown plain: highlighting it would hold the screen up. */
const HIGHLIGHT_LIMIT = 300_000

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The file's text as HTML with highlighting spans (highlight.js escapes the text itself). */
export function highlightCode(text: string, language: string | undefined): string {
  if (!language || !hljs.getLanguage(language) || text.length > HIGHLIGHT_LIMIT) return escape(text)
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value
  } catch {
    return escape(text)
  }
}
