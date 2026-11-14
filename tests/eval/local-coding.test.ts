import { after, test } from 'node:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runLocalAgent } from '../../src/main/local/localAgent'
import { lmStudioStatus } from '../../src/main/cli/lmStudio'
import { updateSettings } from '../../src/main/settings/store'
import { makeProject } from '../support/fixtures'
import { CODING_TASKS } from '../support/codingTasks'

// The hand-off evaluation for VibeApp's own coding agent on the model in LM Studio:
// the same coding tasks as Cline's eval, scored on the project's own tests passing
// afterwards. Free: nothing leaves the computer. Needs LM Studio's server running.
//
//   npm run eval -- local-coding                                 the loaded model, thinking on and off
//   VIBEAPP_EVAL_LOCAL_THINKING=on npm run eval -- local-coding  only with thinking
//   VIBEAPP_EVAL_LOCAL_RUNS=3 npm run eval -- local-coding       each task three times

const MINUTES = 60_000

interface Row {
  setup: string
  passed: number
  total: number
  failures: string[]
  seconds: number
  steps: number
  tokens: number
}

const rows: Row[] = []
after(() => {
  if (!rows.length) return
  const dir = join(process.cwd(), 'test-results', 'eval')
  mkdirSync(dir, { recursive: true })
  const file = `local-coding-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(join(dir, file), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2))
  console.log('\nLocal model hand-off eval (coding):')
  for (const r of rows) {
    console.log(
      `- ${r.setup}: ${r.passed}/${r.total} · ${r.seconds.toFixed(0)} s per task · ${(r.steps / r.total).toFixed(1)} steps · ${Math.round(r.tokens / r.total / 1000)}k tokens per task${r.failures.length ? `\n    ${r.failures.join('\n    ')}` : ''}`
    )
  }
  console.log(`Saved to test-results/eval/${file}`)
})

test('local model: the coding tasks', { timeout: 240 * MINUTES }, async (t) => {
  const status = await lmStudioStatus('http://localhost:1234')
  const model = status.models.find((m) => m.loaded)?.id
  if (!status.running || !model) return t.skip('LM Studio is not running with a model loaded')
  updateSettings({ lmStudioUrl: 'http://localhost:1234', lmStudioModel: model })
  const thinking = (process.env.VIBEAPP_EVAL_LOCAL_THINKING ?? 'on,off').split(',').map((v) => v.trim() === 'on')
  const runs = Math.max(1, Number(process.env.VIBEAPP_EVAL_LOCAL_RUNS) || 1)
  for (const think of thinking) {
    const row: Row = { setup: `${model}, thinking ${think ? 'on' : 'off'}`, passed: 0, total: CODING_TASKS.length * runs, failures: [], seconds: 0, steps: 0, tokens: 0 }
    for (let run = 0; run < runs; run++) {
      for (const task of CODING_TASKS) {
        const dir = makeProject(task.files)
        const started = Date.now()
        let problem: string | null
        try {
          const result = await runLocalAgent({ task: task.prompt, cwd: dir, thinking: think, timeoutMs: 10 * MINUTES })
          row.steps += result.steps
          row.tokens += result.usage.fresh + result.usage.cached + result.usage.output
          problem = task.check(dir)
          if (problem && !result.ok) problem = `${problem} (agent: ${(result.error ?? '').slice(0, 120)})`
          if (result.blocked.length) console.log(`    (refused: ${result.blocked.join('; ')})`)
        } catch (err) {
          problem = `failed: ${(err as Error).message.slice(0, 120)}`
        }
        const seconds = (Date.now() - started) / 1000
        row.seconds += seconds
        console.log(`  ${think ? 'thinking' : 'no thinking'} · ${task.name}: ${problem ? `FAIL ${problem}` : 'pass'} (${seconds.toFixed(0)} s)`)
        if (problem) row.failures.push(`${task.name}: ${problem}`)
        else row.passed++
        rmSync(dir, { recursive: true, force: true })
      }
    }
    row.seconds /= row.total
    rows.push(row)
  }
})
