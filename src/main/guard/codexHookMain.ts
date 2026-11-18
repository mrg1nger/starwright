// Codex's PreToolUse hook for Starwright runs (bundled on its own to out/main/guard/codexHook.cjs and
// copied out of the app to <userData>/codex-hook/PreToolUse.cjs). Codex runs it with Node before
// every shell command, patch and tool call, passing the call as JSON on stdin; Starwright's real data
// folder comes as the first argument. Given with -c on each `codex exec` (see codexExec.ts), which
// was checked to work in Codex's sandboxed, --approve-for-me and unsandboxed (Go Nutz) runs alike.

import { codexHookAnswer } from './codexHook'

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => (raw += chunk))
process.stdin.on('end', () => {
  const answer = codexHookAnswer(raw, process.argv.slice(2))
  if (answer) process.stdout.write(JSON.stringify(answer))
  process.exit(0)
})
