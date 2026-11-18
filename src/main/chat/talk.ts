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
import { addTalkMessage, historyText, loadTalk } from './talkStore'

const SYSTEM = `You are a friendly, knowledgeable assistant inside Starwright, a desktop app for building software with AI. This is the general chat: no project is open, and you can't see or change any files. Answer questions, explain things, help think through ideas and plan, and draft text. The person may not be technical, so use plain language and short answers unless they ask for depth. If they want something built, tell them to open a project and ask there.`

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
    const prompt = `Conversation so far (the last message is the one to answer now):\n\n${historyText(withQuestion)}\n\nReply to the last User message.`
    // Cline and the local model record their own usage (even for a failed answer).
    let answer: { text: string; counts?: Parameters<typeof recordUsage>[3] }
    if (agent === 'claude') {
      try {
        const chosen = getSettings().claudeModel
        answer = await askClaude({
          prompt,
          cwd: scratchDir(),
          system: SYSTEM,
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
        prompt: `${SYSTEM}\n\n${prompt}`,
        cwd: scratchDir(),
        model: getSettings().codexModel ?? undefined,
        effort: getSettings().codexEffort ?? undefined,
        abort
      })
    } else if (agent === 'cline') {
      answer = await askCline(prompt, abort)
    } else {
      answer = await askLocal(prompt, abort)
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
async function askCline(prompt: string, abort: AbortController): Promise<{ text: string }> {
  const why = clineUnavailable()
  if (why) throw new Error(`Cline can't answer right now (${why}). Pick another agent to keep chatting.`)
  const cwd = mkdtempSync(join(tmpdir(), 'vibeapp-chat-cline-'))
  try {
    const result = await runCline({
      prompt,
      mode: 'helper',
      cwd,
      model: await clineModelFor('handoff'),
      thinking: 'none',
      system: `${SYSTEM} You have no tools and need none: the conversation is in the message.`,
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
async function askLocal(prompt: string, abort: AbortController): Promise<{ text: string }> {
  if (!(await lmStudioAvailable())) {
    throw new Error("The local model isn't reachable: start LM Studio (Settings → LM Studio), or pick another agent.")
  }
  try {
    const result = await runLmStudio({ system: SYSTEM, prompt, temperature: 0.6, timeoutMs: 5 * 60_000, signal: abort.signal })
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
