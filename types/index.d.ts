/** What a held call would affect, as the hold pane shows it. Every text is masked. */
export type Affects = {
  summary: string
  lines: string[]
  more: number
  note: string
}

/** One call waiting in the hold queue; the first one is the one shown. */
export type HoldView = {
  id: string
  tool: string
  /** Each rule that matched, e.g. "production domain: api.example.com". */
  rules: string[]
  /** The command, URL or file, masked. */
  command: string
  affects: Affects
  /** Whether a subagent made the call. */
  isSubagent: boolean
}

export type HoldOutcome =
  | 'waiting'
  | 'proceeded'
  | 'cancelled'
  | 'timeout'
  | 'interrupted'
  | 'no-one'
  | 'error'

/** One held call of this session, kept for /code-buddy. Masked. */
export type HeldRecord = {
  id: string
  at: number
  tool: string
  rules: string[]
  command: string
  outcome: HoldOutcome
}

/** One recorded file edit. The diff is unified-diff text, masked. */
export type ReplayStep = {
  file: string
  tool: string
  note: string
  diff: string
  adds: number
  dels: number
  isNew: boolean
}

/** The last finished turn's edits, and where the stepper stands. */
export type Replay = {
  steps: ReplayStep[]
  index: number
  /** False until the person has opened it, so the band shows the hint. */
  isSeen: boolean
}

export type AgentStatus = 'running' | 'done' | 'failed' | 'stopped'

/** One subagent of the session. */
export type AgentRun = {
  id: string
  agentId?: string
  /** The subagent type, e.g. general-purpose or Explore. */
  type: string
  /** The Agent tool's description, masked. */
  description: string
  model: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  /** All tokens of its model requests: input, output, cache reads and writes. */
  tokens: number
  /** Estimated from list prices. */
  costUsd: number
  /** Model requests seen. */
  steps: number
  /** Tool calls it has made. */
  tools?: number
  /** What it is doing now, e.g. "Read · src/api/routes.ts" (masked); cleared when it ends. */
  activity?: string
  /** The main prompt it was started under; the band's bar counts the current one. */
  batch: number
}

/** The agents panel's own state. */
export type AgentsUi = {
  isCompact: boolean
  /** The batch the panel last opened itself for, so a close sticks for that prompt. */
  autoOpenedBatch: number
  /** The budget the toast last fired for (0: none yet), so it fires once per budget. */
  budgetAlertedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'code-buddy': {
      queue: HoldView[]
      log: HeldRecord[]
      /** Edits recorded so far in the turn that is running. */
      recording: ReplayStep[]
      replay: Replay | null
      agents: AgentRun[]
      /** Counts main prompts, so the bar knows which subagents are this prompt's. */
      batch: number
      agentsUi: AgentsUi
    }
  }
}
