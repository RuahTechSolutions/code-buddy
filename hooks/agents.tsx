// Feature 4, Agents panel: every subagent of the session with its model,
// status, elapsed time, tokens, estimated cost and what it is doing now; a
// progress bar of finished out of total in the band; a cost budget. Pure
// helpers and drawing: register.tsx records the runs from agent.spawn,
// tool.call, turn.step and turn.complete.
//
// The tracking approach and the token-cost estimate follow savvy-progress
// (claude-kit, MIT). Modified for Code Buddy: no companion skill or tool, no
// environment reads, current list prices, Ruah Tech theme. See NOTICE.

import type { EngineInterface } from 'claude-code'

import type { AgentRun } from '../types'
import { mask } from './mask'
import {
  AGENTS_HEADER_H,
  BAND_ROW_H,
  BRAND,
  COMPACT_ROW_H,
  GREEN,
  agentRowHeight,
  agentRowSvg,
  agentsBandSvg,
  agentsHeaderSvg,
  compactAgentRowSvg,
  labelSvg,
  pxOf,
} from './theme'
import type { AgentRowView, BudgetView } from './theme'

export const AGENTS_PANE = 'code-buddy-agents'

type Ui = ReturnType<EngineInterface['ui']['resolve']>
type Surface = 'terminal' | 'desktop' | 'mobile' | 'vscode'
export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

// ---- Settings ----------------------------------------------------------------

export type AgentsConfig = {
  /** USD; 0 means no budget. */
  budget: number
  autoOpen: boolean
}

export function agentsConfigOf(options: Record<string, unknown>): AgentsConfig {
  const budget = Number(String(options.agentBudgetUsd ?? '').replace(/[$\s]/g, ''))
  return { budget: Number.isFinite(budget) && budget > 0 ? budget : 0, autoOpen: options.autoOpenAgents !== false }
}

/** "2", "$2.50", "off" → dollars, 0 for off; null when it is not a number. */
export function parseBudget(text: string): number | null {
  if (/^(off|none|0)$/i.test(text.trim())) return 0
  const n = Number(text.replace(/[$\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}

/** The pane's open arguments: a wider dock, and as tall as its rows want. */
export function agentsPaneArgs(rows: number) {
  return { id: AGENTS_PANE, title: 'Agents', columns: 76, rows: Math.max(12, Math.min(34, rows)) }
}

/** Rows the panel wants for this many subagents, full or compact. */
export const agentsRows = (n: number, isCompact: boolean): number => 8 + (isCompact ? n : n * 3)

// ---- Pricing -----------------------------------------------------------------

// USD per million tokens: input, output, cache read, cache write (5-minute TTL,
// 1.25 × input). List prices as of 2026-10; the engine reports tokens, not money.
const PRICES: [RegExp, [number, number, number, number]][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 12.5]],
  [/fable|mythos/, [10, 50, 1, 12.5]],
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/opus/, [5, 25, 0.5, 6.25]],
  [/sonnet-4/, [3, 15, 0.3, 3.75]],
  [/sonnet/, [2, 10, 0.2, 2.5]],
  [/haiku-5/, [0.1, 0.5, 0.01, 0.125]],
  [/haiku/, [1, 5, 0.1, 1.25]],
]
const DEFAULT_PRICE: [number, number, number, number] = [4, 20, 0.2, 5]

export const priceOf = (model: string): [number, number, number, number] =>
  PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? DEFAULT_PRICE

export function costOf(model: string, u: Usage): number {
  const [i, o, r, w] = priceOf(model)
  return ((u.input_tokens || 0) * i + (u.output_tokens || 0) * o + (u.cache_read_input_tokens || 0) * r + (u.cache_creation_input_tokens || 0) * w) / 1e6
}

/** The cost of one request by kind of token. */
export function costParts(model: string, u: Usage): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const [i, o, r, w] = priceOf(model)
  return {
    input: ((u.input_tokens || 0) * i) / 1e6,
    output: ((u.output_tokens || 0) * o) / 1e6,
    cacheRead: ((u.cache_read_input_tokens || 0) * r) / 1e6,
    cacheWrite: ((u.cache_creation_input_tokens || 0) * w) / 1e6,
  }
}

export const tokensOf = (u: Usage): number =>
  (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

// ---- Formatting --------------------------------------------------------------

/** `claude-opus-5-5` → `Opus 5.5`. */
export function modelName(id: string): string {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? `.${minor}` : ''}`
}

export const fmtTokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`)
export const fmtCost = (usd: number): string =>
  usd > 0 && usd < 0.005 ? '<$0.01' : `≈$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`
export const fmtUsd = (usd: number): string => `$${usd.toFixed(2)}`
export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// ---- Activity ----------------------------------------------------------------

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const rel = (cwd: string, path: string): string => (cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

/** What a subagent's tool call is doing, in a few words, masked: "Read · src/api/routes.ts". */
export function activityOf(e: Record<string, unknown>, cwd: string): string {
  const tool = String(e.tool)
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(-1)[0] ?? tool : tool
  let what = ''
  if (s('command')) what = s('command').split('\n')[0] ?? ''
  else if (s('file_path') || s('notebook_path')) what = rel(cwd, s('file_path') || s('notebook_path'))
  else if (s('pattern')) what = `${s('pattern')}${s('path') ? ` in ${rel(cwd, s('path'))}` : ''}`
  else if (s('url')) what = s('url').replace(/^https?:\/\//, '')
  else if (s('query')) what = s('query')
  else if (s('description')) what = s('description')
  else if (s('prompt')) what = s('prompt')
  return mask(what ? `${name} · ${short(what, 80)}` : name)
}

// ---- Totals ------------------------------------------------------------------

export const elapsed = (a: AgentRun, now: number): number => (a.endedAt ?? Math.max(now, a.startedAt)) - a.startedAt

export function totals(list: AgentRun[], now: number) {
  const done = list.filter(a => a.status !== 'running').length
  const running = list.length - done
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = list.length ? Math.min(...list.map(a => a.startedAt)) : now
  const end = list.length ? Math.max(...list.map(a => a.endedAt ?? Math.max(now, a.startedAt))) : now
  return { done, running, total: list.length, cost, tokens, time: end - start }
}

/** The session's spend against the budget, or undefined with no budget set. */
export function budgetOf(list: AgentRun[], budget: number): BudgetView | undefined {
  if (budget <= 0) return undefined
  const used = list.reduce((s, a) => s + a.costUsd, 0)
  return { limit: fmtUsd(budget), used: fmtCost(used), ratio: Math.min(1, used / budget), isOver: used >= budget }
}

/** The runs the band's bar counts: this prompt's, plus any still running from before. */
export const barRuns = (list: AgentRun[], batch: number): AgentRun[] => list.filter(a => a.batch === batch || a.status === 'running')

// ---- Drawing -----------------------------------------------------------------

const STATUS_WORD = { running: 'running', done: 'finished', failed: 'failed', stopped: 'stopped' } as const
const STATUS_GLYPH = { running: '●', done: '✓', failed: '✗', stopped: '■' } as const
const STATUS_COLOR = { running: BRAND.sky, done: GREEN, failed: BRAND.coral, stopped: BRAND.muted } as const

const rowOf = (a: AgentRun, now: number): AgentRowView => ({
  status: a.status,
  title: a.description || a.type,
  type: a.type,
  model: modelName(a.model),
  elapsed: fmtTime(elapsed(a, now)),
  tokens: `${fmtTokens(a.tokens)} tokens`,
  cost: fmtCost(a.costUsd),
  activity: a.status === 'running' ? a.activity || 'starting…' : undefined,
  progress: `step ${a.steps} · ${a.tools ?? 0} ${(a.tools ?? 0) === 1 ? 'tool' : 'tools'}`,
})

export type AgentsView = { isCompact: boolean; budget: number }
export type AgentsActions = { toggleCompact: () => void; select: (id: string) => void }

/** The side panel: summary, then running and finished subagents, full or compact. */
export function drawAgents(ui: Ui, surface: Surface, list: AgentRun[], now: number, columns: number, view: AgentsView, act: AgentsActions) {
  const { Box, Text, Button } = ui
  const running = list.filter(a => a.status === 'running').reverse()
  const finished = list.filter(a => a.status !== 'running').reverse()
  const t = totals(list, now)
  const budget = budgetOf(list, view.budget)
  const stats: [string, string][] = [
    ['Cost', fmtCost(t.cost)],
    ['Tokens', fmtTokens(t.tokens)],
    ['Time', fmtTime(t.time)],
  ]
  const toggle = (
    <Button key="compact" label={view.isCompact ? 'Expand' : 'Compact'} hotkey="x" onPress={() => act.toggleCompact()} />
  )
  const note = (
    <Text key="note" dimColor italic wrap="wrap">
      {`Costs are estimates from list prices per model; the engine reports tokens, not money.${budget ? ` Budget ${budget.limit} this session${budget.isOver ? `, passed at ${budget.used}` : ''}.` : ''}`}
    </Text>
  )
  const empty = (
    <Text key="empty" dimColor wrap="wrap">
      No subagents yet this session. Each one shows here as soon as it starts.
    </Text>
  )

  if (surface === 'desktop' && 'Svg' in ui) {
    const { Svg } = ui
    const W = pxOf(columns, 16, 260)
    const rows = (items: AgentRun[]) =>
      items.map(a => {
        const r = rowOf(a, now)
        const alt = `${r.title}: ${STATUS_WORD[a.status]}, ${r.type}, ${r.model}, ${r.elapsed}, ${r.tokens}, ${r.cost}${r.activity ? `, now ${r.activity}` : ''}`
        const details = <Button key={`d-${a.id}`} label={`Details ›`} plain onPress={() => act.select(a.id)} />
        return (
          <Box key={`r-${a.id}`} flexDirection="column">
            {view.isCompact ? (
              <Svg key={a.id} source={compactAgentRowSvg(W, r)} alt={alt} width={W} height={COMPACT_ROW_H} />
            ) : (
              <Svg key={a.id} source={agentRowSvg(W, r)} alt={alt} width={W} height={agentRowHeight(r, W)} />
            )}
            {details}
          </Box>
        )
      })
    return (
      <Box flexDirection="column" gap={1}>
        <Svg
          key="head"
          source={agentsHeaderSvg(W, t.done, t.running, t.total, stats, budget)}
          alt={`Subagents: ${t.done} of ${t.total} finished. ${stats.map(s => s.join(' ')).join(', ')}${budget ? `, budget ${budget.limit}${budget.isOver ? ' passed' : ''}` : ''}`}
          width={W}
          height={AGENTS_HEADER_H}
        />
        {toggle}
        {list.length === 0 && empty}
        {running.length > 0 && <Svg key="l-run" source={labelSvg(W, `Running · ${running.length}`)} alt={`Running: ${running.length}`} width={W} height={18} />}
        {rows(running)}
        {finished.length > 0 && <Svg key="l-done" source={labelSvg(W, `Finished · ${finished.length}`)} alt={`Finished: ${finished.length}`} width={W} height={18} />}
        {rows(finished)}
        {list.length > 0 && note}
      </Box>
    )
  }

  const barW = Math.max(8, Math.min(24, columns - 40))
  const row = (a: AgentRun) => {
    const r = rowOf(a, now)
    const details = <Button key={`d-${a.id}`} label="Details ›" plain onPress={() => act.select(a.id)} />
    if (view.isCompact) {
      return (
        <Box key={a.id} flexDirection="row" gap={1}>
        <Text wrap="truncate-end">
          <Text color={STATUS_COLOR[a.status]} bold>{`${STATUS_GLYPH[a.status]} `}</Text>
          <Text bold>{r.title}</Text>
          <Text dimColor>{`  ${r.model} · ${r.elapsed} · ${r.cost}`}</Text>
          {r.activity ? <Text color={BRAND.sky}>{`  ▸ ${r.activity}`}</Text> : null}
        </Text>
        {details}
        </Box>
      )
    }
    return (
      <Box key={a.id} flexDirection="column" marginBottom={1}>
        <Text wrap="truncate-end">
          <Text color={STATUS_COLOR[a.status]} bold>{`${STATUS_GLYPH[a.status]} `}</Text>
          <Text bold>{r.title}</Text>
        </Text>
        <Text dimColor wrap="truncate-end">{`  ${r.type} · ${r.model} · ${r.elapsed} · ${r.tokens} · ${r.cost}`}</Text>
        {r.activity ? (
          <Text wrap="truncate-end">
            <Text color={BRAND.sky}>{`  ▸ ${r.activity}`}</Text>
            <Text dimColor>{`  ${r.progress}`}</Text>
          </Text>
        ) : null}
        {details}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box key="head" flexDirection="row" justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text backgroundColor={BRAND.royal} color={BRAND.white} bold>
            {' ≋ AGENTS '}
          </Text>
          <Text bold color={BRAND.sky}>{`  ${t.done} of ${t.total} finished`}</Text>
        </Text>
        {toggle}
      </Box>
      <Text key="bar" wrap="truncate-end">
        <Text color={budget?.isOver ? BRAND.coral : BRAND.blue}>{bar(t.done, t.total, barW)}</Text>
        <Text dimColor>{`  ${stats.map(([k, v]) => `${k.toLowerCase()} ${v}`).join(' · ')}`}</Text>
      </Text>
      {budget && (
        <Text key="budget" wrap="truncate-end">
          <Text dimColor>{'budget '}</Text>
          {budget.isOver ? (
            <Text backgroundColor={BRAND.coral} color={BRAND.white} bold>{` over ${budget.limit} `}</Text>
          ) : (
            <Text color={BRAND.sky}>{`${Math.round(budget.ratio * 100)}% of ${budget.limit}`}</Text>
          )}
        </Text>
      )}
      <Box key="list" flexDirection="column" marginTop={1}>
        {list.length === 0 && empty}
        {running.length > 0 && <Text color={BRAND.sky} bold>{`RUNNING · ${running.length}`}</Text>}
        {running.map(row)}
        {finished.length > 0 && <Text color={BRAND.sky} bold>{`FINISHED · ${finished.length}`}</Text>}
        {finished.map(row)}
      </Box>
      {list.length > 0 && note}
    </Box>
  )
}

const bar = (done: number, total: number, width: number): string => {
  const filled = total ? Math.round((width * done) / total) : 0
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

/** The band: finished out of total, and a button that toggles the panel. Coral past the budget. */
export function drawAgentsBand(ui: Ui, surface: Surface, list: AgentRun[], columns: number, isOver: boolean, toggle: () => void) {
  const { Box, Text, Button } = ui
  const t = totals(list, 0)
  const button = <Button key="toggle-agents" label="Agents" hotkey="a" onPress={toggle} />
  if (surface === 'desktop' && 'Svg' in ui) {
    const { Svg } = ui
    const W = Math.min(pxOf(columns, 110, 220), 760)
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Svg key="agents" source={agentsBandSvg(W, t.done, t.running, t.total, fmtCost(t.cost), isOver)} alt={`Agents: ${t.done} of ${t.total} finished, ${fmtCost(t.cost)}${isOver ? ', over budget' : ''}`} width={W} height={BAND_ROW_H} />
        {button}
      </Box>
    )
  }
  const barW = Math.max(6, Math.min(24, columns - 60))
  return (
    <Box flexDirection="row" gap={1}>
      <Text wrap="truncate-end">
        <Text backgroundColor={BRAND.royal} color={BRAND.white} bold>
          {' ≋ Code Buddy '}
        </Text>
        <Text bold>{'  Agents '}</Text>
        <Text color={isOver ? BRAND.coral : BRAND.blue}>{bar(t.done, t.total, barW)}</Text>
        <Text dimColor>{`  ${t.done}/${t.total} finished · ${fmtCost(t.cost)}`}</Text>
        {isOver ? <Text color={BRAND.coral} bold>{' · over budget'}</Text> : null}
      </Text>
      {button}
    </Box>
  )
}
