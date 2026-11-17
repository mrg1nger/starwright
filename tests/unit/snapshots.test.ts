import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { restoreSnapshot, takeSnapshot } from '../../src/main/git/snapshots'
import { makeProject } from '../support/fixtures'

test('Undo puts files back exactly as they were (same bytes, new files removed)', async () => {
  const dir = makeProject({ 'shop.js': 'line one\nline two\n', 'crlf.txt': 'a\r\nb\r\n' })
  const before = { shop: readFileSync(join(dir, 'shop.js')), crlf: readFileSync(join(dir, 'crlf.txt')) }
  const snapshot = await takeSnapshot(dir, 'before')
  writeFileSync(join(dir, 'shop.js'), 'changed\n')
  writeFileSync(join(dir, 'crlf.txt'), 'changed\r\n')
  writeFileSync(join(dir, 'new.js'), 'new\n')
  const result = await restoreSnapshot(dir, snapshot)
  assert.ok(result.changedFiles.length >= 2, JSON.stringify(result.changedFiles))
  assert.deepEqual(readFileSync(join(dir, 'shop.js')), before.shop, 'shop.js bytes match')
  assert.deepEqual(readFileSync(join(dir, 'crlf.txt')), before.crlf, 'crlf.txt bytes match')
  assert.equal(existsSync(join(dir, 'new.js')), false, 'new file removed')
})

test('Undo of an uncommitted edit made before the snapshot keeps that edit', async () => {
  const dir = makeProject({ 'a.js': 'v1\n' })
  writeFileSync(join(dir, 'a.js'), 'v2 uncommitted\n')
  const snapshot = await takeSnapshot(dir, 'before')
  writeFileSync(join(dir, 'a.js'), 'v3 by the agent\n')
  await restoreSnapshot(dir, snapshot)
  assert.equal(readFileSync(join(dir, 'a.js'), 'utf-8'), 'v2 uncommitted\n')
})

test('a snapshot works when .gitignore lists node_modules too, and still leaves dependency folders out', async () => {
  // 0.15.3 and before: git add stopped with "paths are ignored by one of your .gitignore files", so
  // after a project's first npm install every snapshot failed (no Undo, no Codex review).
  const dir = makeProject({ '.gitignore': 'node_modules/\n', 'app.js': 'v1\n' })
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'dep\n')
  mkdirSync(join(dir, 'sub', 'venv'), { recursive: true })
  writeFileSync(join(dir, 'sub', 'venv', 'lib.py'), 'not ignored, still left out\n')
  const snapshot = await takeSnapshot(dir, 'before')
  writeFileSync(join(dir, 'app.js'), 'v2\n')
  writeFileSync(join(dir, 'sub', 'venv', 'lib.py'), 'changed after\n')
  const result = await restoreSnapshot(dir, snapshot)
  assert.equal(readFileSync(join(dir, 'app.js'), 'utf-8'), 'v1\n')
  assert.ok(!result.changedFiles.some((f) => /node_modules|venv/.test(f)), JSON.stringify(result.changedFiles))
  assert.equal(readFileSync(join(dir, 'sub', 'venv', 'lib.py'), 'utf-8'), 'changed after\n', 'Undo never touches dependency folders')
  assert.ok(existsSync(join(dir, 'node_modules', 'pkg', 'index.js')))
})
