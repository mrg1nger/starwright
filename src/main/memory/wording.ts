// Comparing wordings without a model: which of a line's words another text also has. Used where a
// meaning search would be too loose (has the brief copied its own instructions? did the user ever
// say this rule?) or isn't available.

const SMALL = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'its', 'into', 'from', 'any', 'you', 'your'])

/** A text's words of three letters or more (numbers too), lower case, without the smallest ones. */
export function wordsOf(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !SMALL.has(w)))
}

/** Share of `line`'s words that `source` also has (1 = all of them; 0 when the line has none). */
export function coverage(line: string, source: string | Set<string>): number {
  const mine = wordsOf(line)
  if (!mine.size) return 0
  const theirs = typeof source === 'string' ? wordsOf(source) : source
  let shared = 0
  for (const w of mine) if (theirs.has(w)) shared++
  return shared / mine.size
}

/** A procedure fact ("Procedure - <name>: <steps>"), and its name. */
export function procedureName(text: string): string | null {
  const m = /^\s*Procedure\s*[-–—:]\s*([^:]{1,120}):/i.exec(text)
  return m ? m[1].trim() : /^\s*Procedure\s*[-–—]/i.test(text) ? '' : null
}

const DELETES = /\brm\s+-[a-z]*[rf]|\bRemove-Item\b|\bdel\s+\/[sq]|\brmdir\b|\brd\s+\/s\b|\bDROP\s+(TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+TABLE\b|\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i
const TEST_ONLY = /\btest[-_]?(key|secret|token|password|user)\b|\bdummy[-_]?(key|secret|token)\b|\bfake[-_]?(key|secret|token)\b/i
/** Names of routines a project is really run by (a procedure for one of these may delete old files). */
const ROUTINE = /deploy|release|publish|backup|back up|restore|migrat|install|provision|rollback|roll back|upgrade|build|ship|rotate/i
/** Names of steps that were only for trying something out. */
const TRYING = /\btry|\bdebug|\bclean\b|\breset\b|\bwipe|\bclear\b|\bscratch\b|\btemp\b/i

/** A command or procedure that uses a test key or password (it was for trying something out). */
export function usesTestKey(text: string): boolean {
  return TEST_ONLY.test(text)
}

export interface ProcedureRisk {
  /** It deletes things (rm -rf, Remove-Item, DROP TABLE, git reset --hard…). */
  deletes: boolean
  /** It uses a test key or password. */
  testOnly: boolean
  /** Its name is a routine the project is really run by (deploy, release, backup…), not a step for trying something out. */
  routine: boolean
}

/** What a procedure fact does that matters before it is saved, pushed or kept key. Null when it isn't a procedure. */
export function procedureRisk(text: string): ProcedureRisk | null {
  const name = procedureName(text)
  if (name === null) return null
  return {
    deletes: DELETES.test(text),
    testOnly: TEST_ONLY.test(text),
    routine: ROUTINE.test(name)
  }
}

/** The assistant's own check: a server started and stopped on this computer with data in the temp folder. */
const AD_HOC_CHECK = /(\$env:TEMP|%TEMP%)/i
const STARTS_AND_STOPS = /\bStart-Process\b[\s\S]*\bStop-Process\b|\bStop-Process\b[\s\S]*\bStart-Process\b/i

/**
 * A procedure that was only a step for trying something out (a test key, wiping data to start
 * again), or the assistant's own check with a temporary server and temp data: not worth saving.
 */
export function isThrowawayProcedure(text: string): boolean {
  const risk = procedureRisk(text)
  if (!risk) return false
  if (AD_HOC_CHECK.test(text) && STARTS_AND_STOPS.test(text)) return true
  return !risk.routine && (risk.deletes || risk.testOnly || TRYING.test(procedureName(text) ?? ''))
}
