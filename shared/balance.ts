import type { TaskDifficulty, TaskKind, WorkRoute } from './types'

// How work is split between Claude (leads, plans, reviews) and the helpers (Codex, Cline, the
// local model). The old Claude/Codex slider's steps live on as the lean under the equalizer's
// faders; "auto" follows plan headroom.

export const BALANCE_STEPS = ['claude', 'lean-claude', 'balanced', 'lean-codex', 'codex'] as const
export type BalanceStep = (typeof BALANCE_STEPS)[number]
export type AgentBalance = 'auto' | BalanceStep

export const BALANCE_LABELS: Record<BalanceStep, string> = {
  claude: 'Claude-led',
  'lean-claude': 'Leaning Claude',
  balanced: 'Balanced',
  'lean-codex': 'Leaning Codex',
  codex: 'Codex-led'
}

export const BALANCE_HELP: Record<BalanceStep, string> = {
  claude: 'Claude does the work itself. Codex is only used for reviews and clearly separate pieces.',
  'lean-claude': 'Claude does most of the work; Codex gets at most a separate piece of bigger requests.',
  balanced: 'Starwright decides, request by request, how much suits Codex.',
  'lean-codex': 'Straightforward implementation goes to Codex more often; Claude plans and reviews.',
  codex: 'Claude plans and reviews; Codex builds nearly everything that isn\'t a quick tweak.'
}

/** -2 (all Claude) .. +2 (all Codex). */
export function leanOfStep(step: BalanceStep): number {
  return BALANCE_STEPS.indexOf(step) - 2
}

export function stepOfLean(lean: number): BalanceStep {
  return BALANCE_STEPS[Math.max(0, Math.min(4, Math.round(lean) + 2))]
}

/**
 * Auto: lean toward whichever plan has more left. Inputs are the share of
 * each plan's tightest window still available (0-100); unknown means balanced.
 */
export function autoLean(claudeLeft: number | undefined, codexLeft: number | undefined): number {
  if (claudeLeft === undefined || codexLeft === undefined) return 0
  const diff = codexLeft - claudeLeft
  if (diff >= 40) return 2
  if (diff >= 15) return 1
  if (diff <= -40) return -2
  if (diff <= -15) return -1
  return 0
}

export function leanFor(balance: AgentBalance, claudeLeft?: number, codexLeft?: number): number {
  return balance === 'auto' ? autoLean(claudeLeft, codexLeft) : leanOfStep(balance)
}

export type CodexShare = 'none' | 'some' | 'most'
const SHARES: CodexShare[] = ['none', 'some', 'most']

/**
 * How much of a request goes to Codex once the slider is applied to
 * Haiku's judgement. Quick requests are never delegated.
 */
export function applyBalance(
  share: CodexShare,
  size: 'quick' | 'normal' | 'complex',
  lean: number
): CodexShare {
  if (size === 'quick') return 'none'
  let i = SHARES.indexOf(share)
  if (lean <= -2) i = size === 'complex' ? Math.min(i, 1) : 0
  else if (lean === -1) i = Math.min(i, 1)
  else if (lean === 1) i = Math.min(2, i + 1)
  else if (lean >= 2) i = 2
  return SHARES[i]
}

// ---- The work equalizer: a fader per route (0 off .. 4 first choice) ----


export type WorkMode = 'auto' | 'manual'
export type WorkFaders = Record<WorkRoute, number>
export type HelperRoute = Exclude<WorkRoute, 'claude'>

export const FADER_MAX = 4
export const FADER_LABELS = ['Off', 'Rarely', 'Sometimes', 'Often', 'First choice'] as const

export const FADER_HELP: Record<WorkRoute, string> = {
  claude: 'How much Claude builds itself. It always plans, leads and reviews; at Off, Codex takes every request instead (no Claude usage at all).',
  codex: 'Hand-offs to Codex: any difficulty, and it reviews Claude\'s work.',
  cline: 'Hand-offs to Cline, on its own ClinePass plan: well-specified building, tests, background jobs.',
  local: 'Hand-offs to the local model in LM Studio (free): simple, clearly specified parts only, never hard work.'
}

/** Equal faders keep Starwright's usual order (simple work: local, Cline, Codex; harder: Codex first). */
export const DEFAULT_FADERS: WorkFaders = { claude: 3, codex: 3, cline: 3, local: 3 }

export interface FaderPreset {
  id: string
  label: string
  help: string
  faders: WorkFaders
}

export const FADER_PRESETS: FaderPreset[] = [
  { id: 'balanced', label: 'Balanced', help: 'Claude and the helpers share the work; simple parts go to the cheaper agents first.', faders: DEFAULT_FADERS },
  { id: 'save-claude', label: 'Save Claude', help: 'Claude plans and reviews; the helpers do nearly all the building.', faders: { claude: 1, codex: 3, cline: 3, local: 3 } },
  { id: 'free-first', label: 'Free first', help: 'The free local model and Cline before Codex wherever the work allows.', faders: { claude: 2, codex: 2, cline: 3, local: 4 } },
  { id: 'best-quality', label: 'Best quality', help: 'Claude and Codex do the work; Cline only as a fallback, the local model not at all.', faders: { claude: 4, codex: 4, cline: 1, local: 0 } }
]

export function presetOf(faders: WorkFaders): FaderPreset | undefined {
  return FADER_PRESETS.find((p) => (Object.keys(p.faders) as WorkRoute[]).every((r) => p.faders[r] === faders[r]))
}

/** The faders matching an old slider position, so a user's choice carries over. */
export function fadersFromBalance(step: BalanceStep): WorkFaders {
  const claude = { claude: 4, 'lean-claude': 3, balanced: 3, 'lean-codex': 2, codex: 1 }[step]
  const helpers = step === 'claude' || step === 'lean-claude' ? 2 : 3
  return { claude, codex: helpers, cline: helpers, local: helpers }
}

export function clampFader(n: unknown): number {
  const v = Math.round(Number(n))
  return Number.isFinite(v) ? Math.max(0, Math.min(FADER_MAX, v)) : 3
}

/** The user's faders, filled in and in range (settings saved by older versions have none). */
export function fadersOf(settings: { workFaders?: Partial<WorkFaders> | null; agentBalance?: AgentBalance }): WorkFaders {
  const saved = settings.workFaders
  if (!saved) return settings.agentBalance && settings.agentBalance !== 'auto' ? fadersFromBalance(settings.agentBalance) : { ...DEFAULT_FADERS }
  return {
    claude: clampFader(saved.claude ?? DEFAULT_FADERS.claude),
    codex: clampFader(saved.codex ?? DEFAULT_FADERS.codex),
    cline: clampFader(saved.cline ?? DEFAULT_FADERS.cline),
    local: clampFader(saved.local ?? DEFAULT_FADERS.local)
  }
}

/** Manual unless the user has never left Auto (an old slider position counts as manual). */
export function workModeOf(settings: { workMode?: WorkMode | null; agentBalance?: AgentBalance }): WorkMode {
  if (settings.workMode) return settings.workMode
  return settings.agentBalance && settings.agentBalance !== 'auto' ? 'manual' : 'auto'
}

/** Why these faders can't be used as they are, or null. */
export function faderProblem(f: WorkFaders): string | null {
  if (f.claude === 0 && f.codex === 0) return 'With Claude off, Codex leads every request, so Codex can\'t be off too.'
  return null
}

/**
 * How far Claude leans toward handing work off (-2 does it all itself .. +2 hands off nearly
 * everything): the strongest helper that can take work, against Claude's own fader. The local
 * model only takes simple parts, so it counts for at most "Sometimes" here: turning it up sends
 * it more of the simple parts, not whole jobs. No helper able to take work: Claude does it all.
 */
export function leanFromFaders(f: WorkFaders, available: Record<HelperRoute, boolean>): number {
  const weights = [available.codex ? f.codex : 0, available.cline ? f.cline : 0, available.local ? Math.min(f.local, 2) : 0]
  const strongest = Math.max(...weights)
  if (strongest === 0) return -2
  return Math.max(-2, Math.min(2, strongest - f.claude))
}

/**
 * The helpers in order of trying under the faders: higher faders first; off ones dropped. Equal
 * faders share the work: the one given fewer hand-offs lately (`used`) goes first, and only a tie
 * there too keeps the usual order for this difficulty (which put Codex first every time at 3/3/3).
 * The local model never moves ahead of the others for work above simple (it's a last resort there).
 */
export function orderByFaders(
  order: HelperRoute[],
  f: WorkFaders,
  difficulty: TaskDifficulty,
  used: Partial<Record<HelperRoute, number>> = {}
): HelperRoute[] {
  const on = order.filter((r) => f[r] > 0)
  const ranked = (list: HelperRoute[]): HelperRoute[] =>
    list
      .map((r, i) => ({ r, i }))
      .sort((a, b) => f[b.r] - f[a.r] || (used[a.r] ?? 0) - (used[b.r] ?? 0) || a.i - b.i)
      .map((x) => x.r)
  if (difficulty === 'simple') return ranked(on)
  return [...ranked(on.filter((r) => r !== 'local')), ...on.filter((r) => r === 'local')]
}

/** Claude's fader at Off (in Manual): Codex leads every request, as when Claude's plan is used up. */
export function claudeAtZero(settings: { workMode?: WorkMode | null; workFaders?: Partial<WorkFaders> | null; agentBalance?: AgentBalance }): boolean {
  if (workModeOf(settings) !== 'manual') return false
  const f = fadersOf(settings)
  return f.claude === 0 && !faderProblem(f)
}

/** Short form for the request log and the route tag, e.g. "Claude 1 · Codex 3 · Cline 3 · local 3". */
export function fadersText(f: WorkFaders): string {
  return `Claude ${f.claude} · Codex ${f.codex} · Cline ${f.cline} · local ${f.local}`
}

/**
 * Who a hand-off goes to, in order of trying (the next one gets it if one fails without changing
 * anything). Simple work goes to the free local model first, then Cline, then Codex; moderate work
 * to Codex first; hard work to Codex, else Cline, never the local model. Tests, boilerplate and docs
 * count as simple unless Claude says they're hard. A nearly used-up Codex plan moves Codex last; an
 * agent the user asked for goes first. Only agents that can take work right now are included.
 * With the equalizer on Manual, the faders reorder that (higher first, off dropped; see orderByFaders).
 */
export function chooseRoutes(input: {
  difficulty: TaskDifficulty
  kind: TaskKind
  available: Record<HelperRoute, boolean>
  codexLow: boolean
  asked?: HelperRoute
  /** The user's faders, when the equalizer is on Manual. */
  faders?: WorkFaders
  /** Hand-offs each agent took lately: equal faders go to the one used least. */
  used?: Partial<Record<HelperRoute, number>>
}): HelperRoute[] {
  const plain = input.kind === 'tests' || input.kind === 'boilerplate' || input.kind === 'docs'
  const level = input.difficulty === 'moderate' && plain ? 'simple' : input.difficulty
  let order: HelperRoute[] = level === 'simple' ? ['local', 'cline', 'codex'] : level === 'moderate' ? ['codex', 'cline', 'local'] : ['codex', 'cline']
  if (input.faders) order = orderByFaders(order, input.faders, level, input.used)
  if (input.codexLow && order.includes('codex')) order = [...order.filter((r) => r !== 'codex'), 'codex']
  // An agent asked for by name goes first, unless the user switched it off on the faders.
  if (input.asked && (!input.faders || input.faders[input.asked] > 0)) order = [input.asked, ...order.filter((r) => r !== input.asked)]
  return order.filter((r) => input.available[r])
}

/** The helper a hand-off of this difficulty would most likely go to now (the plan card's "→ Cline"), or null. */
export function likelyHelper(
  difficulty: TaskDifficulty,
  settings: { workMode?: WorkMode | null; workFaders?: Partial<WorkFaders> | null; agentBalance?: AgentBalance },
  available: Record<HelperRoute, boolean>
): HelperRoute | null {
  const faders = workModeOf(settings) === 'manual' ? fadersOf(settings) : undefined
  return chooseRoutes({ difficulty, kind: 'feature', available, codexLow: false, faders })[0] ?? null
}
