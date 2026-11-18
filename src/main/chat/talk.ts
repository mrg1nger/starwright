import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { rmSync } from 'fs'
import type { TalkAgent, TalkAgentsReady, TalkConversation } from '@shared/types'
import { clineModelFor } from '../cli/clineAcp'
import { clineUnavailable, resolveClineLaunch, runCline } from '../cli/clineExec'
import { lmStudioAvailable, runLmStudio } from '../cli/lmStudio'
import { getSettings } from '../settings/store'
import { claudeBlockedUntil, noteClaudeLimit } from '../usage/usage'
import { recordUsage } from '../usage/tokens'
import { askClaude, askCodex, ClaudeLimitError } from './ask'
import { addTalkMessage, historyText, loadTalk, TALK_AGENT_NAMES } from './talkStore'

const SYSTEM = `You are a friendly, knowledgeable assistant inside Starwright, a desktop app for building software with AI. This is the general chat: no project is open, and you can't see or change any files. Answer questions, explain things, help think through ideas and plan, and draft text. The person may not be technical, so use plain language and short answers unless they ask for depth. If they want something built, tell them to open a project and ask there.`

/**
 * Who the answering agent is, and that the chat is shared. Without it each agent only had the
 * general instructions above and the earlier replies to go by, and took on another's name.
 */
export function talkIdentity(agent: TalkAgent, model?: string | null): string {
  const self = {
    claude: `You are Claude, made by Anthropic${model ? `, running as the "${model}" model` : ''}.`,
    codex: `You are Codex, OpenAI's coding agent${model ? `, running the model ${model}` : ''}.`,
    cline: `You are Cline, an open-source AI agent, running the model ${model ?? 'chosen in Starwright'} on the user's ClinePass plan. You are not Claude or Codex. If asked what model you are, say Cline running ${model ?? 'that model'}, and go by the model's name for who made it.`,
    local: `You are the local model: ${model ?? 'the model loaded in LM Studio'}, running in LM Studio on the user's own computer. You are not Claude, Codex or Cline.`
  }[agent]
  return [
    self,
    'This chat is shared between four different AI agents: Claude (Anthropic), Codex (OpenAI), Cline (models on the ClinePass plan) and a local model in LM Studio. The user can switch who answers at any time, and each sees the whole conversation.',
    'In the conversation, each earlier reply is marked with the agent that wrote it. A reply marked "another agent, not you" was written by a different AI: never take on its name or what it said about itself, and if it got wrong how this chat works (for example, claiming the agent names are only labels), say so plainly.'
  ].join('\n')
}

/** The model each agent will answer with, as far as Starwright knows it. */
async function talkModel(agent: TalkAgent): Promise<string | null> {
  const settings = getSettings()
  if (agent === 'claude') return settings.claudeModel ?? null
  if (agent === 'codex') return settings.codexModel ?? null
  if (agent === 'cline') return (await clineModelFor('handoff').catch(() => undefined)) ?? null
  return settings.lmStudioModel ?? null
}

/** The prompt for one answer: the conversation, marked from the answering agent's side. */
export function talkPrompt(conversation: TalkConversation, agent: TalkAgent): string {
  const name = TALK_AGENT_NAMES[agent]
  return `Conversation so far (the last message is the one to answer now):\n\n${historyText(conversation, agent)}\n\nReply to the last User message, as ${name}.`
}

const running = new Map<string, AbortController>()

/** One scratch folder per app run, so Claude/Codex have somewhere harmless to start. */
let scratch: string | undefined
function scratchDir(): string {
  scratch ??= mkdtempSync(join(tmpdir(), 'vibeapp-chat-'))
  return scratch
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function stopTalk(id: string): void {
  running.get(id)?.abort()
}

/** Adds the user's message, gets a reply from the chosen agent, and returns the updated conversation. */
export async function runTalk(id: string, text: string, agent: TalkAgent): Promise<TalkConversation> {
  if (running.has(id)) throw new Error('Still answering the last message.')
  if (agent === 'claude') {
    const until = claudeBlockedUntil()
    if (until !== null) {
      throw new Error(`Claude is out until ${clock(until)}. Switch to Codex to keep chatting.`)
    }
  }
  const withQuestion = addTalkMessage(id, { role: 'user', text })
  const abort = new AbortController()
  running.set(id, abort)
  try {
    const prompt = talkPrompt(withQuestion, agent)
    const model = await talkModel(agent)
    const system = `${SYSTEM}\n\n${talkIdentity(agent, model)}`
    // Cline and the local model record their own usage (even for a failed answer).
    let answer: { text: string; counts?: Parameters<typeof recordUsage>[3] }
    if (agent === 'claude') {
      try {
        const chosen = getSettings().claudeModel
        answer = await askClaude({
          prompt,
          cwd: scratchDir(),
          system,
          model: chosen ?? undefined,
          abort
        })
      } catch (err) {
        if (err instanceof ClaudeLimitError) {
          noteClaudeLimit(null)
          throw new Error("Claude's plan limit was reached. Switch to Codex to keep chatting.")
        }
        throw err
      }
    } else if (agent === 'codex') {
      answer = await askCodex({
        prompt: `${system}\n\n${prompt}`,
        cwd: scratchDir(),
        model: getSettings().codexModel ?? undefined,
        effort: getSettings().codexEffort ?? undefined,
        abort
      })
    } else if (agent === 'cline') {
      answer = await askCline(prompt, system, model, abort)
    } else {
      answer = await askLocal(prompt, system, abort)
    }
    if (answer.counts && (agent === 'claude' || agent === 'codex')) recordUsage(undefined, 'chat', agent, answer.counts)
    return addTalkMessage(id, { role: 'assistant', text: answer.text, agent })
  } catch (err) {
    if (abort.signal.aborted) throw new Error('Stopped.')
    throw err
  } finally {
    running.delete(id)
  }
}

/** Cline, on the user's ClinePass plan: one answer, no tools (it reads the conversation and replies). */
async function askCline(prompt: string, system: string, model: string | null, abort: AbortController): Promise<{ text: string }> {
  const why = clineUnavailable()
  if (why) throw new Error(`Cline can't answer right now (${why}). Pick another agent to keep chatting.`)
  const cwd = mkdtempSync(join(tmpdir(), 'vibeapp-chat-cline-'))
  try {
    const result = await runCline({
      prompt,
      mode: 'helper',
      cwd,
      model: model ?? undefined,
      thinking: 'none',
      system: `${system}\nYou have no tools and need none: the conversation is in the message.`,
      timeoutMs: 5 * 60_000,
      signal: abort.signal
    })
    recordUsage(undefined, 'chat', 'cline', result.usage)
    if (abort.signal.aborted) throw new Error('Stopped.')
    if (!result.ok) throw new Error(result.error ?? "Cline couldn't answer.")
    if (!result.text.trim()) throw new Error('Cline returned no answer.')
    return { text: result.text.trim() }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

/** The local model in LM Studio: free, on this computer. */
async function askLocal(prompt: string, system: string, abort: AbortController): Promise<{ text: string }> {
  if (!(await lmStudioAvailable())) {
    throw new Error("The local model isn't reachable: start LM Studio (Settings → LM Studio), or pick another agent.")
  }
  try {
    const result = await runLmStudio({ system, prompt, temperature: 0.6, timeoutMs: 5 * 60_000, signal: abort.signal })
    recordUsage(undefined, 'chat', 'lmstudio', result.usage)
    return { text: result.text }
  } catch (err) {
    const usage = (err as { usage?: Parameters<typeof recordUsage>[3] }).usage
    if (usage) recordUsage(undefined, 'chat', 'lmstudio', usage)
    throw err
  }
}

/** Which of Cline and the local model the Chat tab can offer (Claude and Codex are always offered). */
export async function talkAgentsReady(): Promise<TalkAgentsReady> {
  const [cline, local] = await Promise.all([
    resolveClineLaunch().then((launch) => !!launch).catch(() => false),
    lmStudioAvailable().catch(() => false)
  ])
  return { cline, local }
}

export function getTalk(id: string): TalkConversation | undefined {
  return loadTalk(id)
}
