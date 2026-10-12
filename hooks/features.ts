// Pausing and switching off features. Each of the four can be paused for this
// session (for a while, or until resumed) or turned off in the settings.
// Pure helpers: register.tsx stores the pauses in session state.

export type Feature = 'guard' | 'blast' | 'replay' | 'agents'

export const FEATURES: { id: Feature; name: string; key: string; words: string[]; what: string }[] = [
  { id: 'guard', name: 'Staging guard', key: 'stagingGuard', words: ['guard', 'staging', 'stagingguard'], what: 'holds calls to production, live keys, protected-branch pushes and deploys' },
  { id: 'blast', name: 'Blast radius', key: 'blastRadius', words: ['blast', 'blastradius', 'destructive'], what: 'holds destructive shell commands' },
  { id: 'replay', name: 'Replay', key: 'replay', words: ['replay', 'edits'], what: "records each turn's edits for /code-buddy replay" },
  { id: 'agents', name: 'Agents panel', key: 'agentsPanel', words: ['agents', 'agentspanel', 'panel', 'subagents'], what: 'tracks subagents in the band and the panel' },
]

export const nameOf = (f: Feature): string => FEATURES.find(x => x.id === f)?.name ?? f

/** A word the person typed → one feature, all of them, or null. */
export function featureOf(word: string): Feature | 'all' | null {
  const w = word.toLowerCase().replace(/[^a-z]/g, '')
  if (w === 'all' || w === 'everything') return 'all'
  return FEATURES.find(f => f.words.includes(w))?.id ?? null
}

/** "30m", "2h", "90s", "45" (minutes) → milliseconds; "" → 0, until resumed; null when not a duration. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase()
  if (!t || t === 'session' || t === 'forever') return 0
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)?$/.exec(t)
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] ?? 'm')[0]
  const ms = unit === 's' ? n * 1000 : unit === 'h' ? n * 3_600_000 : n * 60_000
  return ms > 0 ? Math.round(ms) : null
}

/** Paused features: when each pause ends (ms since the epoch), 0 for until resumed. */
export type Pauses = Partial<Record<Feature, number>>

export const isPaused = (p: Pauses, f: Feature, now: number): boolean => {
  const until = p[f]
  return until !== undefined && (until === 0 || until > now)
}

/** "28m left", "1h 5m left", "40s left" or "until resumed". */
export function leftText(p: Pauses, f: Feature, now: number): string {
  const until = p[f]
  if (until === undefined) return ''
  if (until === 0) return 'until resumed'
  const s = Math.max(0, Math.ceil((until - now) / 1000))
  if (s < 60) return `${s}s left`
  const m = Math.ceil(s / 60)
  return m < 60 ? `${m}m left` : `${Math.floor(m / 60)}h ${m % 60}m left`
}

/** The pauses with ended ones dropped, and which ended. */
export function expire(p: Pauses, now: number): { pauses: Pauses; ended: Feature[] } {
  const pauses: Pauses = {}
  const ended: Feature[] = []
  for (const f of Object.keys(p) as Feature[]) {
    const until = p[f]
    if (until === undefined) continue
    if (until !== 0 && until <= now) ended.push(f)
    else pauses[f] = until
  }
  return { pauses, ended }
}

/**
 * Which features the settings leave on. `guard: false` (the older master switch)
 * also turns both hold features off.
 */
export function enabledOf(options: Record<string, unknown>): Record<Feature, boolean> {
  const master = options.guard !== false && options.guard !== 'off'
  return {
    guard: master && options.stagingGuard !== false,
    blast: master && options.blastRadius !== false,
    replay: options.replay !== false,
    agents: options.agentsPanel !== false,
  }
}

/** 30 min, 2 h, 1 h 30 min, 45 s. */
export function durText(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`
}
