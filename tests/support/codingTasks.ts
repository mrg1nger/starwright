import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

// Small real coding tasks for the hand-off evals (Cline's models, the local model):
// each is a tiny project whose own tests fail until the work is done, scored on
// those tests passing afterwards. The last two (added in 0.10.0) are harder: work
// spread over files, and a bug that isn't where the failing test points.

export interface CodingTask {
  name: string
  files: Record<string, string>
  prompt: string
  /** What's wrong afterwards, or null. */
  check: (dir: string) => string | null
}

export const npmTest = (dir: string): string | null => {
  // Without this, a project's own `node --test` run from inside this test runner reports
  // to it instead and exits 0 even when its tests fail (found: everything "passed").
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  try {
    execFileSync('npm', ['test', '--silent'], { cwd: dir, env, stdio: 'pipe', shell: true, timeout: 60_000, windowsHide: true })
    return null
  } catch (err) {
    const out = String((err as { stdout?: Buffer }).stdout ?? '') + String((err as { stderr?: Buffer }).stderr ?? '')
    return `npm test fails: ${out.replace(/\s+/g, ' ').slice(-160)}`
  }
}

const unchanged = (dir: string, file: string, marker: RegExp): string | null =>
  marker.test(readFileSync(join(dir, file), 'utf8')) ? null : `changed the tests (${file})`

const pkg = (name: string): string => JSON.stringify({ name, version: '1.0.0', scripts: { test: 'node --test' } })

export const CODING_TASKS: CodingTask[] = [
  {
    name: 'fix a bug',
    files: {
      'math.js': 'function add(a, b) {\n  return a - b\n}\n\nfunction double(n) {\n  return add(n, n)\n}\n\nmodule.exports = { add, double }\n',
      'math.test.js': "const test = require('node:test')\nconst assert = require('node:assert')\nconst { add, double } = require('./math')\ntest('add', () => assert.strictEqual(add(2, 3), 5))\ntest('double', () => assert.strictEqual(double(4), 8))\n",
      'package.json': pkg('m')
    },
    prompt: 'The tests fail: add() in math.js is wrong. Fix it, then run npm test to check.',
    check: (dir) => npmTest(dir)
  },
  {
    name: 'add a feature the tests expect',
    files: {
      'cart.js': '// A shopping cart: items are { name, price, qty }.\nfunction addItem(cart, item) {\n  return [...cart, item]\n}\n\nmodule.exports = { addItem }\n',
      'cart.test.js':
        "const test = require('node:test')\nconst assert = require('node:assert')\nconst { addItem, total } = require('./cart')\ntest('addItem', () => assert.strictEqual(addItem([], { name: 'a', price: 1, qty: 1 }).length, 1))\ntest('total sums price times qty', () => assert.strictEqual(total([{ name: 'a', price: 2.5, qty: 2 }, { name: 'b', price: 1, qty: 3 }]), 8))\ntest('total of an empty cart is 0', () => assert.strictEqual(total([]), 0))\n",
      'package.json': pkg('c')
    },
    prompt: 'Add a total(cart) function to cart.js that returns the sum of price times qty for every item (0 for an empty cart), export it, and make npm test pass. Don\'t change the tests.',
    check: (dir) => unchanged(dir, 'cart.test.js', /total sums price times qty/) ?? npmTest(dir)
  },
  {
    name: 'rename across two files',
    files: {
      'prices.js': "const PRICES = { potion: 25, sword: 140 }\nfunction getPrice(item) {\n  return PRICES[item] ?? 0\n}\nmodule.exports = { getPrice }\n",
      'shop.js': "const { getPrice } = require('./prices')\nfunction quote(items) {\n  return items.reduce((sum, i) => sum + getPrice(i), 0)\n}\nmodule.exports = { quote }\n",
      'shop.test.js': "const test = require('node:test')\nconst assert = require('node:assert')\nconst { quote } = require('./shop')\nconst prices = require('./prices')\ntest('quote', () => assert.strictEqual(quote(['potion', 'sword']), 165))\ntest('priceOf is exported', () => assert.strictEqual(prices.priceOf('potion'), 25))\ntest('getPrice is gone', () => assert.strictEqual(prices.getPrice, undefined))\n",
      'package.json': pkg('s')
    },
    prompt: 'Rename the function getPrice to priceOf everywhere (prices.js and shop.js), keeping everything working. Run npm test to check.',
    check: (dir) => {
      const leftover = ['prices.js', 'shop.js'].filter((f) => /getPrice/.test(readFileSync(join(dir, f), 'utf8')))
      if (leftover.length) return `getPrice still in ${leftover.join(', ')}`
      return npmTest(dir)
    }
  },
  {
    name: 'a feature over three files, with checks',
    files: {
      'src/inventory.js':
        "// The player's bag: { [item]: count }.\nconst { ITEMS } = require('./items')\n\nfunction add(bag, item, count = 1) {\n  if (!ITEMS[item]) throw new Error(`Unknown item: ${item}`)\n  return { ...bag, [item]: (bag[item] ?? 0) + count }\n}\n\nmodule.exports = { add }\n",
      'src/items.js': "const ITEMS = {\n  potion: { weight: 1 },\n  sword: { weight: 8 },\n  shield: { weight: 10 }\n}\n\nmodule.exports = { ITEMS }\n",
      'src/hud.js': "// The line shown at the top of the screen.\nfunction hudLine(bag) {\n  const items = Object.values(bag).reduce((a, b) => a + b, 0)\n  return `Items: ${items}`\n}\n\nmodule.exports = { hudLine }\n",
      'test/inventory.test.js':
        "const test = require('node:test')\nconst assert = require('node:assert')\nconst { add, remove, weight } = require('../src/inventory')\nconst { hudLine } = require('../src/hud')\nconst bag = add(add({}, 'potion', 3), 'sword')\ntest('remove takes items away', () => assert.deepStrictEqual(remove(bag, 'potion', 2), { potion: 1, sword: 1 }))\ntest('removing the last one drops the key', () => assert.deepStrictEqual(remove(bag, 'sword'), { potion: 3 }))\ntest('removing more than you have throws', () => assert.throws(() => remove(bag, 'potion', 4), /Not enough potion/))\ntest('remove does not change the bag it was given', () => { remove(bag, 'potion'); assert.strictEqual(bag.potion, 3) })\ntest('weight adds up item weights', () => assert.strictEqual(weight(bag), 11))\ntest('the HUD shows count and weight', () => assert.strictEqual(hudLine(bag), 'Items: 4 | Weight: 11'))\n",
      // Plain `node --test` finds test/*.test.js; `node --test test/` fails on Node 24 ("test at test:1:1").
      'package.json': pkg('inv')
    },
    prompt:
      'In the inventory (src/inventory.js), add remove(bag, item, count = 1), which returns a new bag with count fewer of that item (dropping the item when it reaches 0) and throws an Error "Not enough <item>" when there are fewer than count, and weight(bag), the total weight using the weights in src/items.js. Export both. Then make the HUD line in src/hud.js read "Items: <count> | Weight: <weight>". Don\'t change the tests; run npm test to check.',
    check: (dir) => unchanged(dir, 'test/inventory.test.js', /Not enough potion/) ?? npmTest(dir)
  },
  {
    name: 'debug: the bug is not where the test points',
    files: {
      'report.js':
        "const { formatMoney } = require('./format')\n\n// One line per sale and a total.\nfunction report(sales) {\n  const lines = sales.map((s) => `${s.item}: ${formatMoney(s.cents)}`)\n  const total = sales.reduce((sum, s) => sum + s.cents, 0)\n  return [...lines, `Total: ${formatMoney(total)}`].join('\\n')\n}\n\nmodule.exports = { report }\n",
      'format.js':
        "// Cents to a price like $12.05.\nfunction formatMoney(cents) {\n  const dollars = Math.floor(cents / 100)\n  const rest = cents % 100\n  return `$${dollars}.${rest}`\n}\n\nmodule.exports = { formatMoney }\n",
      'report.test.js':
        "const test = require('node:test')\nconst assert = require('node:assert')\nconst { report } = require('./report')\ntest('report', () =>\n  assert.strictEqual(report([{ item: 'potion', cents: 1205 }, { item: 'sword', cents: 900 }]), 'potion: $12.05\\nsword: $9.00\\nTotal: $21.05'))\n",
      'package.json': pkg('r')
    },
    prompt: 'npm test fails on the sales report. Find the cause and fix it (don\'t change the test), then run npm test to check.',
    check: (dir) => unchanged(dir, 'report.test.js', /potion: \$12\.05/) ?? npmTest(dir)
  }
]
