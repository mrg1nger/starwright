import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { githubUrlFromConfig } from '../../src/main/github/github'
import {
  getProject,
  listProjects,
  recordProjectOpened,
  relocateProject,
  removeProject,
  setGitHubUrls,
  setSdkSessionId
} from '../../src/main/projects/store'

const root = mkdtempSync(join(tmpdir(), 'vibeapp-projects-'))
after(() => rmSync(root, { recursive: true, force: true }))

const folder = (name: string): string => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

test('a project restored from another computer is linked to its new folder and keeps its id', () => {
  const oldPath = join(root, 'old-computer', 'shop') // never created: the folder isn't on this computer
  const project = recordProjectOpened(oldPath)
  setSdkSessionId(project.id, 'session-from-the-old-computer')

  const newPath = folder('shop-here')
  const moved = relocateProject(project.id, newPath)
  assert.equal(moved.id, project.id, 'same id, so its memory, chats, notes and to-dos stay with it')
  assert.equal(moved.path, newPath)
  assert.equal(moved.name, 'shop-here')
  assert.equal(getProject(project.id)?.sdkSessionId, undefined, "the old Claude Code session belongs to the old folder")
  assert.equal(listProjects().filter((p) => p.id === project.id).length, 1)

  // Opening the folder again later finds the same project.
  assert.equal(recordProjectOpened(newPath).id, project.id)
})

test("a folder that is already another listed project can't be taken over", () => {
  const a = recordProjectOpened(join(root, 'gone', 'a'))
  const bPath = folder('b')
  const b = recordProjectOpened(bPath)
  assert.throws(() => relocateProject(a.id, bPath), /already in the list as “b”/)
  assert.equal(getProject(a.id)?.path, join(root, 'gone', 'a'), 'nothing changed')
  assert.equal(getProject(b.id)?.path, bPath)
  assert.throws(() => relocateProject('no-such-project', bPath), /isn't in the list/)
})

test('a removed project that used the folder no longer claims it', () => {
  const cPath = folder('c')
  const removed = recordProjectOpened(cPath)
  removeProject(removed.id, true) // kept: re-adding cPath would bring its id back
  const moving = recordProjectOpened(join(root, 'gone', 'd'))
  relocateProject(moving.id, cPath)
  assert.equal(recordProjectOpened(cPath).id, moving.id, 'the linked project, not the removed one')
})

test("a project's GitHub address is read from .git/config and remembered", () => {
  const dir = folder('with-origin')
  mkdirSync(join(dir, '.git'))
  const config = (url: string): void =>
    writeFileSync(
      join(dir, '.git', 'config'),
      `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/someone/else.git\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n`
    )
  config('https://github.com/me/shop.git')
  assert.equal(githubUrlFromConfig(dir), 'https://github.com/me/shop')
  config('git@github.com:me/my.site.git')
  assert.equal(githubUrlFromConfig(dir), 'https://github.com/me/my.site')
  config('https://gitlab.com/me/shop.git')
  assert.equal(githubUrlFromConfig(dir), null, 'not on GitHub')
  assert.equal(githubUrlFromConfig(folder('no-git')), null)
  assert.equal(githubUrlFromConfig(join(root, 'nowhere')), null)

  const project = recordProjectOpened(dir)
  setGitHubUrls(new Map([[project.id, 'https://github.com/me/shop']]))
  assert.equal(getProject(project.id)?.githubUrl, 'https://github.com/me/shop')
})
