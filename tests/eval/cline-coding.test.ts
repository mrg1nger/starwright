import { after, test } from 'node:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runCline } from '../../src/main/cli/clineExec'
import { listClineModels, stopHostedCline } from '../../src/main/cli/clineAcp'
import { makeProject } from '../support/fixtures'
import { CODING_TASKS, type CodingTask } from '../support/codingTasks'

// The hand-off evaluation for Cline's models: small real coding tasks, run the way a
// hand-off runs (hosted Cline, VibeApp's hook and permission rules), scored on the
// project's own tests passing afterwards. Uses ClinePass only (no Claude).
//
//   npm run eval -- cline-coding                         every ClinePass model offered now
//   VIBEAPP_EVAL_CLINE_MODELS="cline-pass/kimi-k3.1-pro,cline-pass/glm-5.3" npm run eval -- cline-coding

const MINUTES = 60_000

// The tasks are shared with the local model's eval (5 since 0.10.0; scores before had the first 3).
const TASKS: CodingTask[] = CODING_TASKS

interface Row {
  model: string
  passed: number
  total: number
  failures: string[]
  seconds: number
  tokens: number
}

const rows: Row[] = []
after(() => {
  stopHostedCline()
  if (!rows.length) return
  const dir = join(process.cwd(), 'test-results', 'eval')
  mkdirSync(dir, { recursive: true })
  const file = `cline-coding-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(join(dir, file), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2))
  console.log('\nCline hand-off eval (coding):')
  for (const r of [...rows].sort((a, b) => b.passed - a.passed || a.seconds - b.seconds)) {
    console.log(`- ${r.model}: ${r.passed}/${r.total} · ${r.seconds.toFixed(0)} s per task · ${Math.round(r.tokens / r.total / 1000)}k tokens per task${r.failures.length ? `\n    ${r.failures.join('\n    ')}` : ''}`)
  }
  console.log(`Saved to test-results/eval/${file}`)
})

test('each task fails before any work (so a pass means the model did it)', () => {
  for (const task of TASKS) {
    const problem = task.check(makeProject(task.files))
    if (!problem) throw new Error(`"${task.name}" passes untouched: its check is broken`)
  }
})

test('hand-offs: every model on the coding tasks', { timeout: 240 * MINUTES }, async () => {
  const chosen = process.env.VIBEAPP_EVAL_CLINE_MODELS?.split(',').map((m) => m.trim()).filter(Boolean)
  const list = chosen ?? (await listClineModels(true)).models.map((m) => m.id)
  console.log(`  models: ${list.join(', ')}`)
  for (const model of list) {
    const row: Row = { model, passed: 0, total: TASKS.length, failures: [], seconds: 0, tokens: 0 }
    for (const task of TASKS) {
      const dir = makeProject(task.files)
      const started = Date.now()
      let problem: string | null
      try {
        const result = await runCline({ prompt: task.prompt, mode: 'build', cwd: dir, model, timeoutMs: 4 * MINUTES })
        row.tokens += result.usage.fresh + result.usage.cached + result.usage.output
        problem = task.check(dir)
        if (problem && !result.ok) problem = `${problem} (Cline: ${(result.error ?? '').slice(0, 120)})`
      } catch (err) {
        problem = `failed: ${(err as Error).message.slice(0, 120)}`
      }
      row.seconds += (Date.now() - started) / 1000
      if (problem) row.failures.push(`${task.name}: ${problem}`)
      else row.passed++
      stopHostedCline() // one project per task: don't keep its Cline around
    }
    row.seconds /= TASKS.length
    rows.push(row)
    console.log(`  ${model}: ${row.passed}/${row.total}, ${row.seconds.toFixed(0)} s per task`)
  }
})
