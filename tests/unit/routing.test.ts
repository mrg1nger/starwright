import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askNoteText, isPlainQuestion, isTodoListRequest, liveQuestionRule, needsBuild } from '../../src/main/orchestrator/questions'
import { parseClassification } from '../../src/main/orchestrator/classifier'
import { routeMessage } from '../../src/main/orchestrator/routing'
import type { AppSettings } from '@shared/types'
import { applyBalance, autoLean } from '@shared/balance'

test('plain questions are recognised', () => {
  for (const text of [
    'Looks good. Quick question what tiers of armor, weapons, and accessories are there?',
    'what tiers of armor are there?',
    'How many realms does the game have?',
    'Where is the spawn rate defined?',
    'Quick question: which file handles the event log?',
    'Is there a limit on party size?',
    'Why does the server restart every hour?'
  ]) {
    assert.equal(isPlainQuestion(text), true, text)
  }
})

test('requests to change things stay Build requests', () => {
  for (const text of [
    'Add a new armor tier called mythic.',
    'Can you add a fourth realm?',
    'Make the torches glow more, ok?',
    'Fix the bug where the player falls in water. Why does it happen?',
    'Looks good.',
    'Rename the battle module please?',
    'Could you tell me what changed?',
    'Update the readme and tell me what tiers exist?',
    'check http://example.com/page?id=1',
    'What does this do? ```js\nfoo()\n```'
  ]) {
    assert.equal(isPlainQuestion(text), false, text)
  }
})

test('a question about live state goes on as a build request; an answer that only mentions the marker does not', () => {
  assert.match(liveQuestionRule(true), /\[needs a build request\]/)
  assert.doesNotMatch(liveQuestionRule(false), /\[needs a build request\]/, 'in Ask mode, the answer says Build will do it')
  assert.match(liveQuestionRule(false), /Build mode/)
  assert.equal(needsBuild('[needs a build request]'), true)
  assert.equal(needsBuild('  [Needs a build request]\n'), true)
  assert.equal(needsBuild('There are 6 VMs.'), false)
  assert.equal(needsBuild(`The app has three screens. ${'More detail. '.repeat(20)} (Starwright writes [needs a build request] when a command is needed.)`), false, 'a long answer is an answer')
})

test('putting something on the to-do list takes the cheap path; building a to-do feature does not', () => {
  for (const text of [
    'Add "fix the shop button" to my to-do list',
    'put check the phone layout on my todo list for later',
    'Please add a sell button idea to the to-do list.',
    'tick off the shield on my to-do list',
    'Mark the README item as done on my to-do list'
  ]) {
    assert.equal(isTodoListRequest(text), true, text)
  }
  for (const text of [
    'Add a to-do list to my app',
    'Add a todo list page with a delete button',
    'Fix the to-do list component so items save',
    'add dark mode to the to-do list page',
    'Add a shop screen\nand put it on my to-do list'
  ]) {
    assert.equal(isTodoListRequest(text), false, text)
  }
  assert.equal(isPlainQuestion("What's left on my to-do list?"), true)
})

test("a question answered in Ask is passed on to the next Build message, short", () => {
  assert.equal(askNoteText([]), undefined)
  const note = askNoteText([{ question: 'Why does the shop button not work?', answer: 'The click handler in shop.js uses the wrong id.' }]) ?? ''
  assert.match(note, /Ask mode/)
  assert.match(note, /Q: Why does the shop button not work\?/)
  assert.match(note, /A: The click handler in shop\.js uses the wrong id\./)
  const long = askNoteText([{ question: 'q', answer: 'x'.repeat(5000) }]) ?? ''
  assert.ok(long.length < 1500, 'a long answer is cut short')
})

test('planning, or building an approved plan, is never a quick edit, so the slider applies', async () => {
  const settings = { smartRouting: true, aiRouting: false, agentBalance: 'codex', claudeModel: null } as unknown as AppSettings
  const tiny = await routeMessage('Make the title blue', settings)
  assert.equal(tiny.size, 'quick', 'a real quick edit stays quick')
  const approval = await routeMessage('Approved the plan. Go ahead and build it.', settings, { notQuick: true })
  assert.notEqual(approval.size, 'quick')
  assert.notEqual(approval.model, 'haiku', 'not handed to the cheapest model')
  assert.match(approval.note ?? '', /Codex-led/, 'Codex-led is passed on')
  assert.equal(approval.skipReview, false, 'and it gets the usual review')
})

test('classifier replies are parsed strictly', () => {
  assert.deepEqual(parseClassification('{"size":"quick","codex":"none","reason":"tiny"}'), {
    size: 'quick',
    codex: 'none',
    reason: 'tiny',
    fixesLast: false
  })
  assert.equal(parseClassification('{"size":"normal","codex":"none","fixes_last":true,"reason":"login broke"}')?.fixesLast, true)
  assert.equal(parseClassification("You've hit your session limit · resets 7:30pm"), null)
  assert.equal(parseClassification('{"size":"huge","codex":"none"}'), null)
})

test('the balance slider only ever shifts work, and quick requests stay with Claude', () => {
  assert.equal(applyBalance('most', 'quick', 2), 'none')
  assert.equal(applyBalance('none', 'normal', 2), 'most')
  assert.equal(applyBalance('most', 'normal', -2), 'none')
  assert.equal(applyBalance('most', 'complex', -2), 'some')
  assert.equal(autoLean(10, 90), 2)
  assert.equal(autoLean(undefined, 90), 0)
})
