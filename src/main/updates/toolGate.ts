import type { ToolId } from '@shared/types'

// While Starwright updates Codex or Cline, the tool is held back from new work. Kept apart from
// the updater (no imports) so the code that starts Codex and Cline can ask without a cycle.
//
// - drain: no new runs (they fall back to another agent); the ones under way finish.
// - install: the tool's files are being replaced: nothing may start it at all, not even
//   --version (on Windows a running program can't be overwritten).
// - hold: the new version is being checked, or failed its check and the user hasn't chosen yet.
//   Only the check's own runs start it.

export type ToolGatePhase = 'drain' | 'install' | 'hold'

const gates = new Map<ToolId, { phase: ToolGatePhase; reason: string }>()

export function setToolGate(tool: ToolId, phase: ToolGatePhase, reason: string): void {
  gates.set(tool, { phase, reason })
}

export function clearToolGate(tool: ToolId): void {
  gates.delete(tool)
}

/** Why new work can't go to this tool now (undefined: it can). */
export function toolHeld(tool: ToolId): string | undefined {
  return gates.get(tool)?.reason
}

/** The tool's files are being replaced: nothing may start it. */
export function toolInstalling(tool: ToolId): boolean {
  return gates.get(tool)?.phase === 'install'
}
