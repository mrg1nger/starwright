import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import * as z from 'zod/v4'
import { codexReport, runCodexExec, type CodexExecArgs, type CodexExecResult } from '../cli/codexExec'
import { runCline } from '../cli/clineExec'
import { clineModelFor } from '../cli/clineAcp'
import { runLocalAgent } from '../local/localAgent'
import { progressNote } from '../cli/codexActivity'
import { getSettings } from '../settings/store'
import { memoryDb } from '../memory/paths'
import { codeSummariesFor, finishHandoff, keyFactsBlock, markReworked, startHandoff } from '../memory/store'
import { conventionsFor } from '../memory/meaning'
import { digestDiff } from './diffDigest'
import { briefBlock } from '../memory/brief'
import { handoffContext } from '../memory/context'
import { changeStats, diffSnapshots, takeSnapshot, type FileChange } from '../git/snapshots'
import { verifyChanges } from '../review/checks'
import { countsFromCodexEvents, recordUsage } from '../usage/tokens'
import type { DelegationActivity, TaskDifficulty, TaskKind } from '@shared/types'
import { agentName, routedNote, type HandoffAgent } from '@shared/handoff'
import { chooseRoutes, helperAvailability, type HelperRoute } from '../orchestrator/routing'
import type { AgentInstallRequest } from '../extensions/install'
import { saveRecipe } from '../deploy/deploy'
import { listSchedules, saveSchedule, summarize as summarizeSchedule } from '../schedule/scheduler'
import { agentSecretEnv, helperSecretsNote } from '../secrets/vault'

export type DelegationProgressListener = (note: string) => void

/** What the user asked for in this turn, in their own words, to pass along with a hand-off. */
export interface RequestContext {
  text: string
  /** When the request started (ISO), so hand-offs redone later in it can be marked. */
  startedAt?: string
  /** Description of an element they pointed at in the preview. */
  element?: string
  /** Paths of images they attached (the originals). */
  images: string[]
}

/** A Codex session that later hand-offs in the same request can pick up. */
export interface CodexThread {
  id: string
  /** The mode it was started in; a session isn't carried across a Go Nutz change. */
  unsandboxed: boolean
}

/** How long a hand-off may run before it is stopped (real tasks on a big project take a while). */
const HANDOFF_TIMEOUT_MS = 15 * 60_000
/** A routed hand-off to Cline or the local model with another agent behind it gets this long before it's passed on. */
const FALLBACK_TIMEOUT_MS = 10 * 60_000
const ROUTE_AGENT: Record<HelperRoute, HandoffAgent> = { codex: 'Codex', cline: 'Cline', local: 'Local model' }

/** Ahead of every Cline hand-off: what VibeApp expects of it. */
const CLINE_INSTRUCTIONS = `You are working for Claude inside Starwright, on the user's project in the current folder. Do the task below completely, then check it the way the task says (run the tests it names), and finish with a short report: what you changed, file by file, and how the checks went. Stay inside the project folder. Some things are refused by Starwright (deleting folders, pushing, anything outside the project): if a command comes back "BLOCKED by Starwright", don't try another way, just say in your report what was needed. You share a memory with Claude through the vibe_memory tools: recall searches it, where finds which file holds something, handoffs shows earlier hand-offs. Don't save facts unless the task asks you to.`

/** Most memory context sent with a local-model hand-off (its room is limited). */
const LOCAL_CONTEXT_CHARS = 6000

/** Longest summary returned to Claude; the full report is kept for the handoffs tool. */
const SUMMARY_CHARS = 1500
/** A diff this small is included, so Claude doesn't have to open the files to review it. */
const DIFF_INLINE_CHARS = 4000

function currentKeyFacts(projectId: string): string | undefined {
  try {
    return keyFactsBlock(memoryDb(), projectId)
  } catch {
    return undefined // memory unavailable: Codex can still search it
  }
}

/** One Cline conversation per user request (a new request starts a new one). */
const clineSessions = new WeakMap<RequestContext, string>()
function clineSessionFor(request: RequestContext): string {
  let key = clineSessions.get(request)
  if (!key) {
    key = `request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    clineSessions.set(request, key)
  }
  return key
}

/** Never lets bookkeeping failures get in the way of the hand-off itself. */
function attempt<T>(work: () => T): T | undefined {
  try {
    return work()
  } catch (err) {
    console.warn('Hand-off bookkeeping failed:', (err as Error).message)
    return undefined
  }
}

/** The same for work that takes a moment (a memory search). */
async function attemptLater<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch (err) {
    console.warn('Hand-off bookkeeping failed:', (err as Error).message)
    return undefined
  }
}

function describeChanges(changes: FileChange[]): string {
  const shown = changes.slice(0, 12).map((c) => {
    const delta = [c.added ? `+${c.added}` : '', c.removed ? `-${c.removed}` : ''].filter(Boolean).join(' ')
    return `${c.path}${delta ? ` (${delta})` : ''}`
  })
  return `${shown.join(', ')}${changes.length > 12 ? ` and ${changes.length - 12} more` : ''}`
}

type HandOffResult = {
  content: { type: 'text'; text: string }[]
  isError: boolean
  outcome: { ok: boolean; stopped: boolean; changed: number }
}

/**
 * Tries the routes in order: the next one gets the task when one fails without changing anything
 * (a half-done change, a Stop, or the last route ends it). The result says who did it, and who
 * passed it on and why.
 */
export async function tryInOrder(
  routes: HelperRoute[],
  attempt: (route: HelperRoute, last: boolean) => Promise<HandOffResult>,
  task: string
): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }> {
  const passedOn: string[] = []
  for (let i = 0; i < routes.length; i++) {
    const last = i === routes.length - 1
    const agent = ROUTE_AGENT[routes[i]]
    const result = await attempt(routes[i], last)
    const { ok, stopped, changed } = result.outcome
    if (ok || stopped || changed > 0 || last) {
      const header = `[Starwright gave this ${task} task to ${agentName(agent)}${passedOn.length ? ` after ${passedOn.join('; ')}` : ''}.]`
      return { content: [{ type: 'text' as const, text: `${header}\n${result.content[0]?.text ?? ''}` }], isError: result.isError }
    }
    passedOn.push(`${agentName(agent)} couldn't do it (${(result.content[0]?.text ?? '').split('\n')[0].slice(0, 160)})`)
  }
  return { content: [{ type: 'text' as const, text: 'No agent could take the task.' }], isError: true }
}

export function createCodexDelegationServer(
  projectPath: string,
  onProgress: DelegationProgressListener,
  isGoNutzMode: () => boolean,
  memory?: NonNullable<CodexExecArgs['memory']>,
  /** Aborted when the user presses Stop. */
  getStopSignal?: () => AbortSignal,
  getRequestContext?: () => RequestContext | undefined,
  codexThread?: { get: () => CodexThread | undefined; set: (thread: CodexThread | undefined) => void },
  /** Each step Codex takes, for the live feed in the chat. */
  onActivity?: (activity: DelegationActivity) => void,
  /** Building an approved plan: Claude reports each step starting and finishing. */
  onPlanProgress?: (step: number, status: 'doing' | 'done') => void,
  /** Registers an MCP server the agent built as an extension (asks the user first). */
  installExtension?: (req: AgentInstallRequest) => Promise<{ ok: boolean; message: string }>,
  /** Runs the project's saved Deploy recipe (no AI) and describes how it went. */
  runDeploy?: () => Promise<{ ok: boolean; text: string }>,
  /** Plan mode: asks the user whether Claude may stop planning and do something now. */
  leavePlan?: (what: string, why: string) => Promise<string>
): ReturnType<typeof createSdkMcpServer> {
  // Hand-offs share the project folder and the request's Codex session, and each one's
  // "files changed" comes from before/after snapshots, so two at once would edit the same
  // files and report each other's changes. Claude may ask for several at once; run them in turn.
  let queue: Promise<unknown> = Promise.resolve()
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work)
    queue = run.catch(() => undefined)
    return run
  }

  // The project's secrets reach each helper as environment variables, as they reach Claude (the same
  // ones: Starwright's own keys stay hidden), and the task names them, so the helper knows they're there.
  const secrets = (): Record<string, string> | undefined => (memory ? attempt(() => agentSecretEnv(memory.projectId)) : undefined)
  const secretsNote = (): string | undefined => (memory ? attempt(() => helperSecretsNote(memory.projectId)) || undefined : undefined)

  // What each agent does with a hand-off; handOff() wraps it with snapshots, the record and the checks.
  const codexWork =
    (prompt: string, timeoutMs?: number) =>
    async (): Promise<{ report: string; ok: boolean }> => {
      const unsandboxed = isGoNutzMode()
      const signal = getStopSignal?.()
      const request = getRequestContext?.()
    const images = (request?.images ?? []).filter((p) => existsSync(p))
    const context = memory ? await attemptLater(() => handoffContext(memory.projectId, prompt, request)) : undefined
    const run = (resumeThreadId?: string): Promise<CodexExecResult> =>
      runCodexExec(
        {
          prompt: [prompt, secretsNote()].filter(Boolean).join('\n\n'),
          env: secrets(),
          cwd: projectPath,
          timeoutMs: timeoutMs ?? HANDOFF_TIMEOUT_MS,
          unsandboxed,
          model: getSettings().codexModel ?? undefined,
          effort: getSettings().codexEffort ?? undefined,
          images,
          resumeThreadId,
          // Read fresh at hand-off time: Claude may have just saved some.
          memory: memory
            ? {
                ...memory,
                keyFacts: currentKeyFacts(memory.projectId),
                brief: attempt(() => briefBlock(memory.projectId)),
                context,
                autoMemory: getSettings().autoMemory
              }
            : undefined,
          signal
        },
        onProgress,
        onActivity
      )

    // Pick up this request's earlier Codex session, if it's still valid.
    const thread = codexThread?.get()
    const resumeId = thread && thread.unsandboxed === unsandboxed ? thread.id : undefined
    let result = await run(resumeId)
    let continued = !!resumeId
    if (resumeId && result.exitCode !== 0 && !result.finalMessage) {
      // The old session couldn't be resumed: start a new one instead.
      codexThread?.set(undefined)
      recordUsage(memory?.projectId, 'handoff', 'codex', countsFromCodexEvents(result.events))
      result = await run(undefined)
      continued = false
    }
    if (result.threadId && result.exitCode === 0) codexThread?.set({ id: result.threadId, unsandboxed })
    recordUsage(memory?.projectId, 'handoff', 'codex', countsFromCodexEvents(result.events))
    return {
      report: `${continued ? '(Continued the earlier Codex session from this request.)\n' : ''}${codexReport(result)}`,
      ok: result.exitCode === 0
    }
    }

  const clineWork =
    (prompt: string, timeoutMs?: number) =>
    async (): Promise<{ report: string; ok: boolean }> => {
      const signal = getStopSignal?.()
      const request = getRequestContext?.()
    const settings = getSettings()
    if (!settings.clineHandoffs) {
      return { report: 'Hand-offs to Cline are switched off in Starwright\'s Settings. Do the work yourself or hand it to Codex.', ok: false }
    }
    const context = memory ? await attemptLater(() => handoffContext(memory.projectId, prompt, request)) : undefined
    const fullPrompt = [
      CLINE_INSTRUCTIONS,
      memory ? `Key facts:\n${currentKeyFacts(memory.projectId) ?? '(none yet)'}` : undefined,
      memory ? attempt(() => briefBlock(memory.projectId)) : undefined,
      context,
      secretsNote(),
      `Task from Claude:\n${prompt}`
    ]
      .filter(Boolean)
      .join('\n\n')
    const result = await runCline(
      {
        prompt: fullPrompt,
        env: secrets(),
        mode: 'build',
        cwd: projectPath,
        model: await clineModelFor('handoff'),
        goNutz: isGoNutzMode(),
        timeoutMs: timeoutMs ?? HANDOFF_TIMEOUT_MS,
        signal,
        memory: memory ? { scriptPath: memory.scriptPath, dbPath: memory.dbPath, projectId: memory.projectId, projectPath: memory.projectPath } : undefined,
        // Later hand-offs in the same request carry on Cline's conversation.
        session: request ? clineSessionFor(request) : undefined
      },
      (activity) => {
        onActivity?.(activity)
        const note = progressNote(activity)
        if (note) onProgress(note)
      }
    )
    recordUsage(memory?.projectId, 'handoff', 'cline', result.usage)
    if (signal?.aborted) throw new Error('Cline run was cancelled')
    const blocked = result.blocked.length
      ? `\n[Starwright refused ${result.blocked.length === 1 ? 'one thing' : `${result.blocked.length} things`} Cline tried: ${[...new Set(result.blocked)].join('; ')}. If it's needed, ask the user or do it yourself.]`
      : ''
    return {
      report: `${result.text || result.error || '(Cline finished with no final message.)'}${result.ok || !result.text || !result.error ? '' : `\n[${result.error}]`}${blocked}`,
      ok: result.ok
    }
    }

  const localWork =
    (prompt: string, timeoutMs?: number) =>
    async (): Promise<{ report: string; ok: boolean }> => {
      const signal = getStopSignal?.()
      const request = getRequestContext?.()
    if (!getSettings().localHandoffs) {
      return { report: "Hand-offs to the local model are switched off in Starwright's Settings. Do the work yourself or hand it to Codex.", ok: false }
    }
    const context = memory ? await attemptLater(() => handoffContext(memory.projectId, prompt, request)) : undefined
    // Kept short: the local model's room is limited, and the task matters most.
    const background = [
      memory ? `Key facts:\n${currentKeyFacts(memory.projectId) ?? '(none yet)'}` : undefined,
      memory ? attempt(() => briefBlock(memory.projectId)) : undefined,
      context
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, LOCAL_CONTEXT_CHARS)
    const task = [
      background ? `Background on the project (from Starwright's memory):\n${background}` : undefined,
      secretsNote(),
      `Task from Claude:\n${prompt}`
    ]
      .filter(Boolean)
      .join('\n\n')
    const result = await runLocalAgent({
      task,
      env: secrets(),
      cwd: projectPath,
      goNutz: isGoNutzMode(),
      signal,
      timeoutMs: timeoutMs ?? HANDOFF_TIMEOUT_MS,
      onActivity: (activity) => {
        onActivity?.(activity)
        const note = progressNote(activity)
        if (note) onProgress(note)
      }
    })
    recordUsage(memory?.projectId, 'handoff', 'lmstudio', result.usage)
    if (signal?.aborted) throw new Error('The local model run was cancelled')
    const blocked = result.blocked.length
      ? `\n[Starwright refused ${result.blocked.length === 1 ? 'one thing' : `${result.blocked.length} things`} the local model tried: ${[...new Set(result.blocked)].join('; ')}. If it's needed, ask the user or do it yourself.]`
      : ''
    const failed = result.ok || !result.text || !result.error ? '' : `\n[${result.error}]`
    return {
      report: `${result.text || result.error || '(The local model finished with no report.)'}${failed}\n[${result.model ?? 'local model'}, ${result.steps} steps]${blocked}`,
      ok: result.ok
    }
    }

  /**
   * A hand-off Starwright routes: Claude says what the task is and how hard; the agents are tried
   * in the order chooseRoutes gives, the next one taking over when one fails without changing anything.
   */
  async function routedHandOff(args: {
    prompt: string
    kind: TaskKind
    difficulty: TaskDifficulty
    agent?: HelperRoute
    timeoutMs?: number
  }): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }> {
    const { available, codexLow } = await helperAvailability(getSettings())
    const routes = chooseRoutes({ difficulty: args.difficulty, kind: args.kind, available, codexLow, asked: args.agent })
    if (!routes.length) {
      return {
        content: [
          {
            type: 'text' as const,
            text: "No other agent can take work right now (Codex isn't signed in, and Cline and the local model are switched off or not running). Do it yourself."
          }
        ],
        isError: true
      }
    }
    return tryInOrder(routes, (route, last) => {
      const agent = ROUTE_AGENT[route]
      onProgress(routedNote(agent, args.difficulty, args.kind))
      // A cheaper agent with another behind it gets less time: a stall shouldn't hold the request up.
      const timeoutMs = !last && route !== 'codex' ? Math.min(args.timeoutMs ?? HANDOFF_TIMEOUT_MS, FALLBACK_TIMEOUT_MS) : args.timeoutMs
      const work = route === 'codex' ? codexWork(args.prompt, timeoutMs) : route === 'cline' ? clineWork(args.prompt, timeoutMs) : localWork(args.prompt, timeoutMs)
      return handOff(agent, args.prompt, work, { kind: args.kind, difficulty: args.difficulty })
    }, `${args.difficulty} ${args.kind}`)
  }

  return createSdkMcpServer({
    name: 'vibe_tools',
    version: '1.0.0',
    tools: [
      tool(
        'leave_plan_mode',
        "Plan mode only: ask the user to let you stop planning and do something now (Starwright turned away a tool call because Plan mode is on). Use it only when the user's message needs it done now, not to look around or to run checks you could put in the plan. Starwright shows the user one prompt with what and why; if they allow it, the rest of this request is a normal Build. Ask at most once per request.",
        {
          what: z.string().min(3).describe('What you want to do now, in plain words, e.g. "deploy the server, then check the live admin page".'),
          why: z.string().min(3).describe('Why it needs doing now rather than in a plan, in plain words.')
        },
        async (args) => {
          const text = leavePlan ? await leavePlan(args.what.slice(0, 400), args.why.slice(0, 400)) : 'Plan mode is not available here.'
          return { content: [{ type: 'text' as const, text }] }
        },
        // Claude needs it at the moment a call is turned away, without a tool search first.
        { alwaysLoad: true }
      ),
      tool(
        'plan_progress',
        'While building a plan the user approved: report that a step (by its number in the plan) has started ("doing") or is finished ("done"). When a step finishes, pass next with the step you start now, so one call covers both. The user sees the plan as a checklist that ticks off as you go.',
        {
          step: z.number().int().min(1).describe('The step number in the approved plan.'),
          status: z.enum(['doing', 'done']),
          next: z.number().int().min(1).optional().describe('With status "done": the step you start next.')
        },
        async (args) => {
          // The end-to-end test switches the tool off to check VibeApp's backups (to-do list, honest finish).
          if (process.env.VIBEAPP_TEST_HOOKS === '1' && existsSync(join(app.getPath('userData'), 'test-no-plan-progress'))) {
            return { content: [{ type: 'text' as const, text: 'Progress reporting is not available right now; carry on.' }] }
          }
          onPlanProgress?.(args.step, args.status)
          const next = args.status === 'done' && args.next && args.next !== args.step ? args.next : undefined
          if (next) onPlanProgress?.(next, 'doing')
          return { content: [{ type: 'text' as const, text: `Step ${args.step}: ${args.status}.${next ? ` Step ${next}: doing.` : ''}` }] }
        }
      ),
      tool(
        'run_deploy',
        "Run this project's saved Deploy: Starwright runs the steps the user checked, with no AI, then the site check (and the rollback steps if something fails), and returns the result. Use it whenever the user asks to deploy or put it live, and for a deploy step in an approved plan, instead of deploying by hand. If the project has no saved Deploy yet, or it hasn't been checked, this says so: then offer to write one with save_deploy_recipe, and deploy by hand only if the user wants it live right now.",
        {},
        async () => {
          if (!runDeploy) return { content: [{ type: 'text' as const, text: 'Deploy is not available here.' }], isError: true }
          const result = await runDeploy()
          return { content: [{ type: 'text' as const, text: result.text }], isError: !result.ok }
        }
      ),
      tool(
        'save_deploy_recipe',
        "Save this project's one-click Deploy recipe, which Starwright runs by itself (no AI) when the user presses Deploy. Only when the user asks to set up or change Deploy. Use the steps that have actually worked before (the \"Procedure -\" facts from recall, the conversation history, the project's scripts): exact commands in order, each run from the project folder in Git Bash (or PowerShell if you set shell), non-interactive, and stopping with an error if something fails (a non-zero exit stops the deploy). Back up live data first if earlier deploys did. Add a check URL that should answer once it's live, and rollback steps that put the previous version back if a step or the check fails, if that's possible. Refer to passwords and keys only as $NAME environment variables from the project's Secrets; never put a value in a step. Don't run the deploy yourself: the user checks the recipe and presses Deploy.",
        {
          name: z.string().describe('Short name, e.g. "Deploy Glyphlands to the VPS".'),
          shell: z.enum(['bash', 'powershell']).optional().describe('bash (Git Bash, the default) or powershell.'),
          steps: z
            .array(
              z.object({
                label: z.string().describe('What the step does, in plain words, e.g. "Back up the live data".'),
                run: z.string().describe('The command(s) to run.'),
                timeoutSec: z.number().int().optional().describe('Seconds before it counts as stuck (default 600).')
              })
            )
            .describe('In order.'),
          check: z
            .object({ url: z.string(), expectStatus: z.number().int().optional() })
            .optional()
            .describe('A web address that answers (2xx/3xx, or expectStatus) once the deploy is live.'),
          rollback: z
            .array(z.object({ label: z.string(), run: z.string(), timeoutSec: z.number().int().optional() }))
            .optional()
            .describe('Steps that restore the previous live version if a step or the check fails.'),
          notes: z.string().optional().describe('Anything the user should know (one or two sentences).')
        },
        async (args) => {
          if (!memory?.projectId) return { content: [{ type: 'text' as const, text: 'Deploy recipes are not available here.' }], isError: true }
          try {
            const saved = saveRecipe(memory.projectId, args, 'claude', false)
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Saved "${saved.name}" (${saved.steps.length} steps${saved.check ? ', with a site check' : ''}${saved.rollback ? ', with rollback' : ''}). The user now checks it in Starwright's Deploy window before it can run; tell them that, briefly, and don't deploy yourself.`
                }
              ]
            }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Not saved: ${(err as Error).message}` }], isError: true }
          }
        }
      ),
      tool(
        'save_schedule',
        "Save a schedule for this project, which Starwright runs by itself while it's running (in the tray is enough). Only when the user asks for something to happen on a schedule or after each Deploy (\"every weekday at 7am run the tests\", \"check the site every 15 minutes\"). It's saved as a draft: the user checks it and turns it on in Starwright's Schedules window, so tell them that, briefly. Don't run the work now as well. A request runs as a normal chat message with nobody watching, so write it as a complete instruction (what to do, and what to report). Pass id to change an existing schedule (from list_schedules).",
        {
          id: z.string().optional().describe('An existing schedule to change (from list_schedules).'),
          name: z.string().describe('Short name, e.g. "Morning test run".'),
          action: z
            .discriminatedUnion('kind', [
              z.object({ kind: z.literal('request'), text: z.string().describe('The message to send, as the user would type it.'), mode: z.enum(['build', 'plan', 'ask']).describe('build changes code; plan proposes a plan and waits for approval; ask answers without changing anything.') }),
              z.object({ kind: z.literal('next_todo'), mode: z.enum(['build', 'plan']) }),
              z.object({ kind: z.literal('deploy') }),
              z.object({ kind: z.literal('site_check'), url: z.string(), onDown: z.string().optional().describe('A request to send you when the site goes down (once per outage).') }),
              z.object({ kind: z.literal('github_backup') })
            ])
            .describe("What runs: a request; the top to-do; the project's saved Deploy; a check that a web address is up (no AI); or an upload to the project's GitHub copy (no AI)."),
          when: z
            .discriminatedUnion('kind', [
              z.object({ kind: z.literal('once'), at: z.string().describe('Local date and time, e.g. 2026-11-02T19:00.') }),
              z.object({ kind: z.literal('daily'), time: z.string().describe('HH:MM, 24-hour, this computer\'s time.'), days: z.array(z.number().int().min(0).max(6)).describe('0 = Sunday … 6 = Saturday; all seven for every day.') }),
              z.object({ kind: z.literal('every'), minutes: z.number().int().describe('At least 60 for requests, 5 for site checks.') }),
              z.object({ kind: z.literal('after_deploy') })
            ])
            .describe('When it runs.'),
          maxPerDay: z.number().int().optional().describe('Requests: at most this many runs a day (default 3).'),
          skipAboveUsage: z.number().int().optional().describe("Requests: skip when Claude's plan usage is at or above this percent (default 90; 0 = never skip).")
        },
        async (args) => {
          if (!memory?.projectId) return { content: [{ type: 'text' as const, text: 'Schedules are not available here.' }], isError: true }
          try {
            const saved = saveSchedule(memory.projectId, args, 'claude', false)
            return {
              content: [
                { type: 'text' as const, text: `Saved the draft schedule "${saved.name}" (${summarizeSchedule(saved)}). It runs once the user checks it and turns it on in the Schedules window.` }
              ]
            }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Not saved: ${(err as Error).message}` }], isError: true }
          }
        }
      ),
      tool(
        'list_schedules',
        "This project's schedules: what each runs, when, whether it's on, and how its last runs went.",
        {},
        async () => {
          if (!memory?.projectId) return { content: [{ type: 'text' as const, text: 'Schedules are not available here.' }], isError: true }
          const list = listSchedules(memory.projectId)
          const text = list.length
            ? list
                .map((s) => {
                  const last = s.runs[0]
                  return `- ${s.id}: "${s.name}" — ${summarizeSchedule(s)} — ${s.enabled ? 'on' : s.confirmed ? 'off' : 'draft, not yet checked'}${last ? ` — last run ${last.at}: ${last.status}${last.detail ? ` (${last.detail})` : ''}` : ''}`
                })
                .join('\n')
            : 'No schedules yet.'
          return { content: [{ type: 'text' as const, text }] }
        }
      ),
      tool(
        'install_extension',
        "Install an MCP server (a set of tools) for the user, available to you and to Codex in every project, switchable in Starwright's Extensions screen. Use it after you have built an MCP server in the project, or when the user asks to add one. The user is asked to confirm and the server is started once to check it works. Put the server's code in a project folder and pass it as sourceDir: the folder is copied into Starwright's data so it outlives the project, and \"{{dir}}\" in args becomes that copy's path (for example command \"node\", args [\"{{dir}}/index.js\"]). If it needs API keys, list their names in keys and read them from environment variables; never ask the user to paste a key into the chat.",
        {
          name: z.string().describe('Short human name, e.g. "Weather lookup".'),
          description: z.string().optional().describe('One sentence on what the tools do.'),
          command: z.string().describe('Program that runs the server, e.g. node, npx, python.'),
          args: z.array(z.string()).describe('Arguments; {{dir}} stands for the copied folder.'),
          sourceDir: z.string().optional().describe('Folder inside the project with the server code (relative or absolute).'),
          instructions: z.string().optional().describe('One or two sentences telling the agents when to use these tools.'),
          keys: z.array(z.string()).optional().describe('Names of environment variables it needs (e.g. WEATHER_API_KEY).')
        },
        async (args) => {
          if (!installExtension) {
            return { content: [{ type: 'text' as const, text: 'Installing extensions is not available here.' }], isError: true }
          }
          try {
            const result = await installExtension(args)
            return { content: [{ type: 'text' as const, text: result.message }], isError: !result.ok }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Install failed: ${(err as Error).message}` }],
              isError: true
            }
          }
        }
      ),
      tool(
        'run_subtask',
        "Hand a scoped coding subtask to another agent and get its result. Starwright picks the agent from the user's settings, what each plan has left and how hard you say the task is: the local model (free, on this computer) or Cline (on its own plan) for simple, well-specified work, Codex for harder work; if one fails without changing anything, the next one gets it. Each is given the user's request, the key facts and relevant memories, and several Codex hand-offs in one request continue the same Codex session, so say what to do, which files are involved, what \"done\" looks like and how to check it (tests to run; for visible changes, what to try in the browser, where the agents have the same Playwright tools). Split bigger jobs and hand the simple parts off separately. The result says who did it, with its report, the files changed (with a small diff) and the automatic checks (script syntax, JSON, the project's npm test); the full report is available from the handoffs tool. Hand-offs run one at a time (they share the project folder), so asking for several at once doesn't make them faster.",
        {
          prompt: z.string().describe('The subtask: what to do, which files, what "done" looks like, and how to check it.'),
          kind: z.enum(['feature', 'bugfix', 'tests', 'refactor', 'boilerplate', 'docs', 'other']).describe('What kind of task it is.'),
          difficulty: z
            .enum(['simple', 'moderate', 'hard'])
            .describe(
              'simple: a clear change in named files, boilerplate, tests for existing code, a bug with a failing test. moderate: a typical feature or fix across a few files. hard: tricky, vague, or wide-reaching work.'
            ),
          agent: z.enum(['codex', 'cline', 'local']).optional().describe('Only when the user asked for a particular agent: that one is tried first.'),
          timeoutMs: z.number().optional().describe('Optional timeout in milliseconds. Defaults to 15 minutes.')
        },
        (args) => oneAtATime(() => routedHandOff(args))
      )
    ]
  })

  /**
   * One hand-off: logged in memory, with snapshots before and after so the
   * files changed (and a diff) come back to Claude, and the automatic checks.
   */
  async function handOff(
    agent: HandoffAgent,
    prompt: string,
    execute: () => Promise<{ report: string; ok: boolean }>,
    task?: { kind: TaskKind; difficulty: TaskDifficulty }
  ): Promise<HandOffResult> {
    const signal = getStopSignal?.()
    const request = getRequestContext?.()
    const projectId = memory?.projectId

    const handoffId = projectId
      ? attempt(() => startHandoff(memoryDb(), projectId, agent === 'Local model' ? 'local' : agent.toLowerCase(), prompt, request?.text ?? null, task))
      : undefined
    const before = await takeSnapshot(projectPath, 'before hand-off').catch(() => undefined)

    interface Outcome {
      changes: FileChange[] | null
      diff: string
      checks: string
      checksOk: boolean | null
    }
    const outcome = async (status: 'done' | 'error' | 'stopped', report: string): Promise<Outcome> => {
      let changes: FileChange[] | null = null
      let diff = ''
      let checks = ''
      let checksOk: boolean | null = null
      if (before) {
        const after = await takeSnapshot(projectPath, 'after hand-off').catch(() => undefined)
        if (after) {
          changes = await changeStats(projectPath, before, after).catch(() => null)
          if (changes?.length && status === 'done') {
            diff = await diffSnapshots(projectPath, before, after).catch(() => '')
          }
        }
      }
      // Only worth running when the agent finished normally and changed something.
      if (status === 'done' && changes?.length) {
        const verdict = await verifyChanges(
          projectPath,
          changes.map((c) => c.path)
        ).catch(() => ({ ok: null, summary: '' }))
        checks = verdict.summary
        checksOk = verdict.ok
      }
      if (handoffId !== undefined) {
        attempt(() =>
          finishHandoff(memoryDb(), handoffId, {
            status,
            report: [report, checks].filter(Boolean).join('\n\n'),
            files: changes?.map((c) => c.path) ?? null,
            checksOk
          })
        )
      }
      // Earlier hand-offs in this request whose files this one changed again were redone.
      if (projectId && changes?.length && request?.startedAt) {
        const since = request.startedAt
        attempt(() => markReworked(memoryDb(), projectId, changes!.map((c) => c.path), since, handoffId))
      }
      return { changes, diff, checks, checksOk }
    }

    try {
      const { report: full, ok } = await execute()
      const { changes, diff, checks, checksOk } = await outcome(ok ? 'done' : 'error', full)

      const summary =
        full.length > SUMMARY_CHARS
          ? `${full.slice(0, SUMMARY_CHARS)}\n… (shortened; the full report is saved: handoffs tool, id ${handoffId ?? '?'})`
          : full
      const parts = [`${agent === 'Codex' ? 'Hand-off' : `${agent} hand-off`}${handoffId !== undefined ? ` #${handoffId}` : ''}`]
      if (changes) parts.push(changes.length ? `files changed: ${describeChanges(changes)}` : 'no files changed')
      const lines = [summary, `[${parts.join(' · ')}]`]
      if (checks) lines.push(`[${checks}]`)
      if (diff.trim()) {
        if (diff.length <= DIFF_INLINE_CHARS) {
          lines.push(`Diff:\n${diff.trim()}`)
        } else {
          // Too big to hand back whole: a digest built from the code map and the request.
          const summaries =
            (projectId && changes
              ? attempt(() =>
                  codeSummariesFor(
                    memoryDb(),
                    projectId,
                    changes.map((c) => c.path)
                  )
                )
              : undefined) ?? new Map<string, string>()
          lines.push(digestDiff(diff, changes ?? [], `${request?.text ?? ''} ${prompt}`, summaries))
        }
      }
      // Remembered conventions that bear on this change, so the review checks against them.
      if (projectId && changes?.length) {
        const text = [request?.text, prompt, ...changes.map((c) => c.path)].filter(Boolean).join(' ')
        const rules = await attemptLater(() => conventionsFor(memoryDb(), projectId, text))
        if (rules?.length) {
          lines.push(
            `[Remembered conventions that apply here; check the change against them:\n${rules
              .map((r) => `- ${r.text}`)
              .join('\n')}]`
          )
        }
      }
      return {
        content: [{ type: 'text' as const, text: lines.join('\n\n') }],
        isError: !ok || checksOk === false,
        outcome: { ok, stopped: false, changed: changes?.length ?? 0 }
      }
    } catch (err) {
      const message = (err as Error).message
      const partial = await outcome(signal?.aborted ? 'stopped' : 'error', message).catch(() => undefined)
      // The agent may have changed files before it failed or was stopped; say which, so
      // nobody assumes the project is as it was.
      const touched = partial?.changes?.length
        ? `
[Files ${agentName(agent)} changed before it stopped: ${describeChanges(partial.changes)}. Check them before continuing; they may be half-done.]`
        : ''
      return {
        content: [{ type: 'text' as const, text: `${agentName(agent)} couldn't finish: ${message}${touched}` }],
        isError: true,
        outcome: { ok: false, stopped: !!signal?.aborted, changed: partial?.changes?.length ?? 0 }
      }
    }
  }
}
