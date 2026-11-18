// Starwright's own data is off limits to the agents it runs: the secrets vault, deploy recipes,
// memory database, settings, and the Remote access tokens in ~/.vibeapp. A project's secrets reach
// an agent as environment variables; nothing an agent does needs these folders. Found on Lazarus: a
// Codex hand-off looking for a password listed %APPDATA%\vibeapp\secrets, \deploy and
// \memory-projects. Checked for Codex (its PreToolUse hook), Cline and the local model, Go Nutz too.
//
// No Electron here: it's also bundled into the Codex and Cline hook scripts, which run under Node.

const NAMES = '(?:vibeapp|starwright)'
const SEP = String.raw`[\\/]+`
const QUOTE = `["'\`]?`

const PATTERNS: RegExp[] = [
  // C:\Users\me\AppData\Roaming\vibeapp, …/AppData/Local/Starwright
  new RegExp(`appdata${SEP}(?:roaming|local|locallow)${SEP}${NAMES}(?![\\w.-])`, 'i'),
  // %APPDATA%\vibeapp, $env:APPDATA\vibeapp, $APPDATA/vibeapp, ${env:LOCALAPPDATA}/starwright
  new RegExp(`(?:%(?:local)?appdata%|\\$\\{?env:(?:local)?appdata\\}?|\\$\\{?(?:local)?appdata\\}?)${QUOTE}${SEP}${NAMES}(?![\\w.-])`, 'i'),
  // Join-Path $env:APPDATA 'vibeapp', [Environment]::GetFolderPath('ApplicationData') + '\vibeapp'
  new RegExp(`(?:appdata|applicationdata)\\b[^\\n;|&]{0,60}?[\\s,(+'"\`\\\\/]${NAMES}${QUOTE}(?![\\w.-])`, 'i'),
  // ~/.vibeapp, %USERPROFILE%\.starwright, $HOME/.vibeapp, C:\Users\me\.vibeapp
  new RegExp(`(?:~|%userprofile%|\\$\\{?env:userprofile\\}?|\\$\\{?home\\}?|users${SEP}[^\\\\/\\s"'\`]+)${QUOTE}${SEP}\\.${NAMES}(?![\\w-])`, 'i')
]

const slashes = (s: string): string => s.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()

/**
 * Why this text (a command, or a tool call's input as JSON) is refused, or null. `dataPaths` are the
 * real data folders (a custom one, as the tests use), matched as written in the text.
 */
export function starwrightDataDanger(text: string, dataPaths: string[] = []): string | null {
  if (!text) return null
  const hit = PATTERNS.some((p) => p.test(text)) || (() => {
    const flat = slashes(text)
    return dataPaths.some((p) => p && p.length > 3 && flat.includes(slashes(p).replace(/\/$/, '')))
  })()
  return hit ? "looking into Starwright's own data (its secrets, deploy recipes, memory and settings)" : null
}

/** What an agent is told when it's refused. */
export function starwrightDataReason(what: string): string {
  return `BLOCKED by Starwright: ${what} is never allowed. A project's secrets are already in your environment variables (by name); use those. Do not try another way round it; if something is missing, say in your report that it needs the user.`
}
