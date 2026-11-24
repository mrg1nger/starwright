import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listProjectFiles, MAX_TEXT_BYTES, parseStatus, readProjectFile, safeProjectPath } from '../../src/main/files/projectFiles'
import { checkRemoteCall } from '../../src/main/remote/auth'
import { buildTree, filterFiles, formatSize, languageFor } from '@shared/fileTree'

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'files-pane-'))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  git('init', '-q')
  git('config', 'user.email', 'test@local')
  git('config', 'user.name', 'Test')
  writeFileSync(join(dir, '.gitignore'), 'node_modules\ndist\n')
  writeFileSync(join(dir, 'index.html'), '<h1>Shop</h1>\n')
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'src', 'shop.js'), 'export const items = []\n')
  writeFileSync(join(dir, 'src', 'lib', 'old.js'), 'gone soon\n')
  writeFileSync(join(dir, 'src', 'lib', 'util.js'), 'export const add = (a, b) => a + b\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  return dir
}

test("the list follows .gitignore and marks what changed since the last checkpoint", async () => {
  const dir = project()
  try {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), '')
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'out.js'), '')
    writeFileSync(join(dir, 'src', 'shop.js'), 'export const items = ["sword"]\n')
    writeFileSync(join(dir, 'src', 'new file.css'), 'h1 { color: red }\n')
    rmSync(join(dir, 'src', 'lib', 'old.js'))
    const list = await listProjectFiles(dir)
    assert.deepEqual(list.files, ['.gitignore', 'index.html', 'src/lib/util.js', 'src/new file.css', 'src/shop.js'])
    assert.deepEqual(list.changed, { 'src/shop.js': 'modified', 'src/new file.css': 'untracked', 'src/lib/old.js': 'deleted' })
    assert.equal(list.truncated, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('without git, the usual build and package folders are left out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'files-pane-nogit-'))
  try {
    writeFileSync(join(dir, 'a.txt'), 'a')
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'x', 'i.js'), '')
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'docs', 'b.md'), '# b')
    assert.deepEqual((await listProjectFiles(dir)).files, ['a.txt', 'docs/b.md'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("git's status lines become changes, a rename's old name skipped", () => {
  assert.deepEqual(parseStatus(' M a.js\0?? b c.js\0A  d.js\0R  new.js\0old.js\0 D e.js\0'), {
    'a.js': 'modified',
    'b c.js': 'untracked',
    'd.js': 'added',
    'new.js': 'renamed',
    'e.js': 'deleted'
  })
  assert.deepEqual(parseStatus(''), {})
})

test('nothing outside the project can be read', () => {
  const dir = project()
  const outside = mkdtempSync(join(tmpdir(), 'files-pane-outside-'))
  try {
    writeFileSync(join(outside, 'secret.txt'), 'top secret')
    for (const bad of ['../x', 'src/../../x', '..', '', join(outside, 'secret.txt'), 'C:/Windows/win.ini', '\\\\server\\share\\x', '.git/config', 'a\0b', 42]) {
      assert.throws(() => safeProjectPath(dir, bad), /Not a file in this project/, String(bad))
    }
    assert.equal(safeProjectPath(dir, 'src/shop.js'), join(dir, 'src', 'shop.js'))
    assert.equal(safeProjectPath(dir, 'src\\shop.js'), join(dir, 'src', 'shop.js'))
    // A link inside the project that leads out of it (a junction needs no admin rights on Windows).
    symlinkSync(outside, join(dir, 'escape'), 'junction')
    assert.throws(() => readProjectFile(dir, 'escape/secret.txt'), /Not a file in this project/)
    assert.throws(() => readProjectFile(dir, 'src'), /folder/)
    assert.throws(() => readProjectFile(dir, 'nope.js'), /isn't there/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("a file comes back as text, a picture, or only its size when it's binary or holds secrets", () => {
  const dir = project()
  try {
    assert.deepEqual(readProjectFile(dir, 'src/shop.js'), { kind: 'text', path: 'src/shop.js', size: 24, text: 'export const items = []\n', truncated: false })
    writeFileSync(join(dir, 'bom.txt'), '\uFEFFhello')
    assert.equal((readProjectFile(dir, 'bom.txt') as { text: string }).text, 'hello')
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
    const image = readProjectFile(dir, 'logo.png')
    assert.equal(image.kind, 'image')
    assert.match((image as { dataUrl: string }).dataUrl, /^data:image\/png;base64,iVBORw/)
    writeFileSync(join(dir, 'app.exe'), Buffer.from([0x4d, 0x5a, 0, 0, 3]))
    assert.deepEqual(readProjectFile(dir, 'app.exe'), { kind: 'binary', path: 'app.exe', size: 5 })
    for (const name of ['.env', '.env.local', 'server.key', 'cert.pem', 'id_ed25519', '.npmrc', 'store.pfx']) {
      writeFileSync(join(dir, name), 'API_KEY=sk-123')
      assert.deepEqual(readProjectFile(dir, name), { kind: 'secret', path: name, size: 14 }, name)
    }
    writeFileSync(join(dir, '.env.example'), 'API_KEY=')
    assert.equal(readProjectFile(dir, '.env.example').kind, 'text', 'an example file is fine')
    // A big file: only its start, ending on a whole line.
    const line = 'x'.repeat(99) + '\n'
    writeFileSync(join(dir, 'big.log'), line.repeat(Math.ceil((MAX_TEXT_BYTES * 2) / line.length)))
    const big = readProjectFile(dir, 'big.log') as { text: string; truncated: boolean; size: number }
    assert.equal(big.truncated, true)
    assert.ok(big.text.length <= MAX_TEXT_BYTES && big.text.length > MAX_TEXT_BYTES - 200, String(big.text.length))
    assert.ok(big.text.endsWith('x') && !big.text.endsWith('\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the tree puts folders first and counts the changes inside them', () => {
  const tree = buildTree(['README.md', 'src/b.js', 'src/a.js', 'src/lib/x.js', 'assets/logo.png', 'Z.txt'], {
    'src/lib/x.js': 'modified',
    'src/a.js': 'untracked'
  })
  assert.deepEqual(
    tree.map((n) => n.name),
    ['assets', 'src', 'README.md', 'Z.txt']
  )
  const src = tree[1]
  assert.equal(src.changedInside, 2)
  assert.deepEqual(
    src.children!.map((n) => [n.name, n.change ?? '', n.changedInside ?? 0]),
    [
      ['lib', '', 1],
      ['a.js', 'untracked', 0],
      ['b.js', '', 0]
    ]
  )
  assert.equal(tree[0].changedInside, undefined)
})

test('finding a file: every word, names first, then shorter paths', () => {
  const files = ['src/components/ShopList.tsx', 'docs/shop.md', 'src/shop.js', 'shop/readme.txt', 'src/cart.js']
  assert.deepEqual(filterFiles(files, 'shop'), ['src/shop.js', 'docs/shop.md', 'src/components/ShopList.tsx', 'shop/readme.txt'])
  assert.deepEqual(filterFiles(files, 'SRC shop'), ['src/shop.js', 'src/components/ShopList.tsx'])
  assert.deepEqual(filterFiles(files, '   '), [])
  assert.equal(filterFiles(files, 's', 2).length, 2)
})

test('highlighting language by name, and sizes in words', () => {
  assert.equal(languageFor('src/App.tsx'), 'typescript')
  assert.equal(languageFor('scripts/run.ps1'), 'powershell')
  assert.equal(languageFor('Dockerfile'), 'dockerfile')
  assert.equal(languageFor('.env.example'), 'ini')
  assert.equal(languageFor('LICENSE'), undefined)
  assert.equal(languageFor('.gitignore'), undefined)
  assert.equal(formatSize(812), '812 B')
  assert.equal(formatSize(4300), '4.2 KB')
  assert.equal(formatSize(52_000), '51 KB')
  assert.equal(formatSize(3_500_000), '3.3 MB')
})

test("from another device: the list is readable on a read-only connection, a file's contents need full access, and opening one is for the computer", () => {
  assert.equal(checkRemoteCall('vibe:files:list', ['p'], true).allowed, true)
  assert.equal(checkRemoteCall('vibe:files:read', ['p', 'a.js'], true).allowed, false)
  assert.equal(checkRemoteCall('vibe:files:read', ['p', 'a.js'], false).allowed, true)
  const open = checkRemoteCall('vibe:files:open', ['p', 'a.js'], false)
  assert.equal(open.allowed, false)
  assert.match(open.reason ?? '', /computer running Starwright/)
})
