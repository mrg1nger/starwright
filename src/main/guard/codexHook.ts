import { starwrightDataDanger, starwrightDataReason } from './starwrightData'

/** Codex's "deny" answer for a PreToolUse hook. */
export interface CodexHookDeny {
  hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string }
}

/**
 * The hook's answer to one call (Codex's PreToolUse JSON on stdin), or null to let it run. The whole
 * tool input is checked, so a shell command, a patch's file paths and an MCP tool's arguments alike.
 */
export function codexHookAnswer(raw: string, dataPaths: string[]): CodexHookDeny | null {
  let input: unknown = raw
  try {
    const payload = JSON.parse(raw) as { hook_event_name?: string; tool_input?: unknown }
    if (payload.hook_event_name && payload.hook_event_name !== 'PreToolUse') return null
    input = payload.tool_input ?? payload
  } catch {
    // not JSON: check the text as it is
  }
  const command = (input as { command?: unknown })?.command
  const text = typeof command === 'string' ? `${command}\n${JSON.stringify(input)}` : typeof input === 'string' ? input : JSON.stringify(input)
  const what = starwrightDataDanger(text, dataPaths)
  if (!what) return null
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: starwrightDataReason(what) }
  }
}
