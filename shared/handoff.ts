// Hand-offs Starwright routes (run_subtask): Claude describes the task, Starwright picks the agent.
// The chat card learns who got it from the progress note, written and read here.

export type HandoffAgent = 'Codex' | 'Cline' | 'Local model'

/** The routed hand-off tool, as the chat sees it. */
export const SUBTASK_TOOL_NAME = 'mcp__vibe_tools__run_subtask'

/** The agent's name in a sentence ("the local model"). */
export function agentName(agent: HandoffAgent): string {
  return agent === 'Local model' ? 'the local model' : agent
}

/** The progress note when Starwright gives a routed hand-off to an agent. */
export function routedNote(agent: HandoffAgent, difficulty: string, kind: string): string {
  return `Handed to ${agentName(agent)} (${difficulty} ${kind})`
}

/** Which agent a routed hand-off's progress note names, if it's one. */
export function agentOfRoutedNote(note: string): HandoffAgent | null {
  const m = /^Handed to (Codex|Cline|the local model) \(/.exec(note)
  if (!m) return null
  return m[1] === 'the local model' ? 'Local model' : (m[1] as HandoffAgent)
}
