import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLikelyDestructive } from '../../src/main/orchestrator/session'

// Which of Claude's commands ask first (Allow/Deny). On 2026-11-27 Claude ran PowerShell's
// "rm -r a_tmp" without a prompt: the check only knew "-Recurse" and "rm -rf".

const risky = (command: string, tool = 'PowerShell'): boolean => isLikelyDestructive(tool, { command })

test('deleting a folder asks first, however the command is spelt', () => {
  for (const command of [
    'rm -r a_tmp -ErrorAction SilentlyContinue',
    'rm -rf build',
    'rm -fr build',
    'rm --recursive build',
    'Remove-Item -Recurse -Force out',
    'Remove-Item out -r',
    'ri out -rec',
    'rd /s /q out',
    'del /s *.log',
    'git reset --hard HEAD~1',
    'git clean -fd'
  ]) {
    assert.equal(risky(command), true, command)
  }
  assert.equal(risky('rm -r a_tmp', 'Bash'), true)
})

test('ordinary commands go ahead', () => {
  for (const command of ['npm test', 'rm notes.txt', 'Remove-Item notes.txt', 'git status', 'npm run build -- --report', 'Get-ChildItem -Recurse src']) {
    assert.equal(risky(command), false, command)
  }
  assert.equal(isLikelyDestructive('Edit', { command: 'rm -rf /' }), false, 'only shell commands')
})
