import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AppSettings } from '@shared/types'
import {
  DEFAULT_FADERS,
  FADER_PRESETS,
  claudeAtZero,
  faderProblem,
  fadersOf,
  leanFromFaders,
  orderByFaders,
  presetOf,
  workModeOf
} from '@shared/balance'
import { chooseRoutes, routeMessage } from '../../src/main/orchestrator/routing'

const all = { codex: true, cline: true, local: true }

test('an old slider position carries over as Manual faders that lean the same way', () => {
  assert.equal(workModeOf({ agentBalance: 'auto' }), 'auto')
  assert.equal(workModeOf({ agentBalance: 'lean-codex' }), 'manual')
  assert.equal(workModeOf({ agentBalance: 'lean-codex', workMode: 'auto' }), 'auto', 'a saved mode wins')
  for (const [step, lean] of [['claude', -2], ['lean-claude', -1], ['balanced', 0], ['lean-codex', 1], ['codex', 2]] as const) {
    assert.equal(leanFromFaders(fadersOf({ agentBalance: step }), all), lean, step)
  }
  assert.deepEqual(fadersOf({ agentBalance: 'auto' }), DEFAULT_FADERS)
  assert.deepEqual(fadersOf({ workFaders: { claude: 9, codex: -1 } as never }), { claude: 4, codex: 0, cline: 3, local: 3 }, 'kept in range')
})

test('Claude can be Off, but only with Codex there to lead', () => {
  assert.ok(faderProblem({ claude: 0, codex: 0, cline: 4, local: 4 }))
  assert.equal(faderProblem({ claude: 0, codex: 1, cline: 0, local: 0 }), null)
  assert.ok(claudeAtZero({ workMode: 'manual', workFaders: { claude: 0, codex: 3, cline: 3, local: 3 } }))
  assert.ok(!claudeAtZero({ workMode: 'auto', workFaders: { claude: 0, codex: 3, cline: 3, local: 3 } }), 'Auto ignores the faders')
  assert.ok(!claudeAtZero({ workMode: 'manual', workFaders: { claude: 0, codex: 0, cline: 3, local: 3 } }), 'never with nobody to lead')
})

test("how much Claude hands off comes from the strongest helper that can take work", () => {
  assert.equal(leanFromFaders({ claude: 3, codex: 3, cline: 3, local: 3 }, all), 0)
  assert.equal(leanFromFaders({ claude: 1, codex: 4, cline: 0, local: 0 }, all), 2)
  assert.equal(leanFromFaders({ claude: 2, codex: 4, cline: 0, local: 0 }, { codex: false, cline: true, local: true }), -2, 'Codex not there, others off')
  assert.equal(leanFromFaders({ claude: 2, codex: 0, cline: 0, local: 4 }, all), 0, 'the local model counts for at most Sometimes')
})

test('the faders reorder hand-offs within the roles each agent can take', () => {
  const f = { claude: 2, codex: 1, cline: 4, local: 2 }
  assert.deepEqual(orderByFaders(['local', 'cline', 'codex'], f, 'simple'), ['cline', 'local', 'codex'])
  assert.deepEqual(orderByFaders(['codex', 'cline', 'local'], { ...f, local: 4 }, 'moderate'), ['cline', 'codex', 'local'], 'local stays last above simple')
  assert.deepEqual(orderByFaders(['codex', 'cline'], { ...f, cline: 0 }, 'hard'), ['codex'], 'Off means never')
  const pick = (difficulty: 'simple' | 'moderate' | 'hard', faders = f, asked?: 'codex' | 'cline' | 'local') =>
    chooseRoutes({ difficulty, kind: 'feature', available: all, codexLow: false, faders, asked })
  assert.deepEqual(pick('simple', DEFAULT_FADERS), ['local', 'cline', 'codex'], 'equal faders keep the usual order')
  assert.deepEqual(pick('hard', { claude: 2, codex: 3, cline: 3, local: 4 }), ['codex', 'cline'], 'never the local model for hard work')
  assert.deepEqual(pick('simple', { ...f, local: 0 }, 'local'), ['cline', 'codex'], 'an agent switched off is not used even when asked for')
})

test('presets are recognised, and none breaks the rules', () => {
  for (const p of FADER_PRESETS) {
    assert.equal(faderProblem(p.faders), null, p.id)
    assert.equal(presetOf({ ...p.faders })?.id, p.id)
  }
  assert.equal(presetOf({ claude: 2, codex: 1, cline: 1, local: 1 }), undefined)
})

test("routing follows the faders on Manual: who's named, and how hard Claude leans", async () => {
  const base = { smartRouting: false, aiRouting: false, agentBalance: 'auto', claudeModel: null, workMode: 'manual' } as unknown as AppSettings
  const ready = { clineReady: true, localReady: true }
  const helpersOff = await routeMessage('Build a settings page with a dark mode toggle', { ...base, workFaders: { claude: 4, codex: 0, cline: 0, local: 0 } }, ready)
  assert.doesNotMatch(helpersOff.note ?? '', /run_subtask/, 'nobody to hand to')
  assert.match(helpersOff.detail ?? '', /faders: Claude 4 · Codex 0/)

  const clineOnly = await routeMessage('Build a settings page with a dark mode toggle', { ...base, workFaders: { claude: 1, codex: 0, cline: 4, local: 0 } }, ready)
  assert.match(clineOnly.note ?? '', /Cline/)
  assert.doesNotMatch(clineOnly.note ?? '', /Codex,|or Codex|the local model \(free/, 'Codex and the local model are off')
})
