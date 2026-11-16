import { test } from 'node:test'
import assert from 'node:assert/strict'
import { staysInProject } from '../../src/main/orchestrator/commandScope'

const project = 'C:\\Users\\me\\Projects\\game'

test('ordinary commands inside the project need no prompt', () => {
  for (const command of [
    'node inventory.test.js',
    'npm test',
    'cd "C:\\Users\\me\\Projects\\game"; node --test',
    'cd /c/Users/me/Projects/game && npm run build',
    'git status --short > /dev/null',
    'node C:/Users/me/Projects/game/scripts/check.js',
    // Seen on a real Cline run: a sed expression isn't a path.
    `grep -oP '"hyperv_[a-z_]+"' src/tools/host.ts src/tools/vms.ts | sed 's/"//g' | sort -u`,
    "sed -i 's/old\\/name/new/g' src/app.ts",
    'perl -pe "s/foo/bar/" src/a.txt'
  ]) {
    assert.equal(staysInProject(command, project), true, command)
  }
})

test('commands that reach outside the project still ask', () => {
  for (const command of [
    'type C:\\Users\\me\\.ssh\\id_rsa',
    'cat ~/.ssh/id_rsa',
    'Get-Content $env:USERPROFILE\\secrets.txt',
    'cd ..; dir',
    'node ../other/script.js',
    'copy game.js D:\\backup\\',
    'ls /etc',
    'dir \\\\server\\share\\',
    "sed -i 's/a/b/' /etc/hosts",
    "sed 's/a/b/w /tmp/out' src/a.txt",
    "sed 's/a/b/' src/a.txt > /tmp/out",
    'cd "C:\\Users\\me\\Projects\\game-other"; npm test',
    ''
  ]) {
    assert.equal(staysInProject(command, project), false, command)
  }
})
