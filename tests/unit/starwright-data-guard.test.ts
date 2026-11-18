import { test } from 'node:test'
import assert from 'node:assert/strict'
import { starwrightDataDanger } from '../../src/main/guard/starwrightData'
import { codexHookAnswer } from '../../src/main/guard/codexHook'
import { commandDanger } from '../../src/main/cline/hookPolicy'

const refused = [
  // What the Codex hand-off on Lazarus actually ran.
  'Get-ChildItem "$env:APPDATA\\vibeapp\\secrets" -Force -ErrorAction SilentlyContinue | Select-Object Name',
  'Get-ChildItem "$env:APPDATA\\vibeapp" -Recurse -Force | Where-Object { $_.Name -match \'password\' }',
  'Get-ChildItem "$env:LOCALAPPDATA\\Starwright" -Force',
  'Get-ChildItem "$env:USERPROFILE\\.vibeapp" -Force',
  'type %APPDATA%\\vibeapp\\settings.json',
  'cat ~/.vibeapp/lazarus-api.json',
  'cat "$HOME/.starwright/x"',
  'sqlite3 C:\\Users\\Chris\\AppData\\Roaming\\vibeapp\\memory.db .dump',
  'Get-Content (Join-Path $env:APPDATA \'vibeapp\')',
  'dir C:/Users/someone/.vibeapp'
]

const allowed = [
  'npm test',
  'Get-ChildItem C:\\Users\\Chris\\Documents\\GitHub\\VibeApp\\src', // a project called VibeApp
  'git -C D:/Vibe/RAL-Command status',
  'Get-ChildItem "$env:APPDATA\\npm-cache"',
  'echo $env:WEBNOTES_PASSWORD.Length',
  'node vibeapp-tools.js',
  'cat AppData-notes.md'
]

test("Starwright's data folders are refused, however they're written", () => {
  for (const command of refused) assert.ok(starwrightDataDanger(command), `should refuse: ${command}`)
})

test('ordinary commands, and a project that happens to be called VibeApp, are not', () => {
  for (const command of allowed) assert.equal(starwrightDataDanger(command), null, `should allow: ${command}`)
})

test('a custom data folder is refused as written', () => {
  assert.ok(starwrightDataDanger('dir D:\\Data\\sw-test\\secrets', ['D:\\Data\\sw-test']))
  assert.ok(starwrightDataDanger('ls d:/data/sw-test/deploy', ['D:\\Data\\sw-test']))
  assert.equal(starwrightDataDanger('ls D:/Data/other', ['D:\\Data\\sw-test']), null)
})

test("Codex's hook denies a command, a patch or a tool call that reaches in, and lets the rest run", () => {
  const call = (tool_name: string, tool_input: unknown): string => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input })
  const deny = codexHookAnswer(call('Bash', { command: refused[0] }), [])
  assert.equal(deny?.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(deny!.hookSpecificOutput.permissionDecisionReason, /BLOCKED by Starwright/)
  assert.ok(codexHookAnswer(call('apply_patch', { command: '*** Begin Patch\n*** Add File: C:/Users/x/AppData/Roaming/vibeapp/evil.txt\n' }), []))
  assert.ok(codexHookAnswer(call('mcp__fs__read_file', { path: 'C:\\Users\\x\\AppData\\Roaming\\vibeapp\\secrets\\a.json' }), []))
  assert.equal(codexHookAnswer(call('Bash', { command: 'npm run build' }), []), null)
  assert.equal(codexHookAnswer(JSON.stringify({ hook_event_name: 'PostToolUse', tool_input: { command: refused[0] } }), []), null)
})

test('Cline and the local model are refused too, even in Go Nutz', () => {
  for (const goNutz of [false, true]) {
    assert.match(commandDanger(refused[0], { mode: 'build', projectPath: 'D:/Vibe/WebNotes', goNutz }) ?? '', /Starwright's own data/)
  }
  assert.equal(commandDanger('npm test', { mode: 'build', projectPath: 'D:/Vibe/WebNotes', goNutz: true }), null)
})
