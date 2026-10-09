// Feature 4, Agents panel: every subagent of the session with its model,
// status, elapsed time, tokens and estimated cost; a progress bar of finished
// out of total in the band. Pure helpers and drawing: register.tsx records
// the runs from agent.spawn, turn.step and turn.complete.
//
// The tracking approach and the token-cost estimate follow savvy-progress
// (claude-kit, MIT). Modified for Code Buddy: no companion skill or tool, no
// environment reads, current list prices, Ruah Tech theme. See NOTICE.

import type { EngineInterface } from 'claude-code'

import type { AgentRun } from '../types'
import { AGENTS_HEADER_H, AGENT_ROW_H, BAND_ROW_H, BRAND, GREEN, agentRowSvg, agentsBandSvg, agentsHeaderSvg, labelSvg, pxOf } from './theme'
import type { AgentRowView } from './theme'

export const AGENTS_PANE = 'code-buddy-agents'

type Ui = ReturnType<EngineInterface['ui']['resolve']>
type Surface = 'terminal' | 'desktop' | 'mobile' | 'vscode'
export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

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

export const tokensOf = (u: Usage): number =>
  (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

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
export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

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

/** The runs the band's bar counts: this prompt's, plus any still running from before. */
export const barRuns = (list: AgentRun[], batch: number): AgentRun[] => list.filter(a => a.batch === batch || a.status === 'running')

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
})

/** The side panel: summary, then running and finished subagents. */
export function drawAgents(ui: Ui, surface: Surface, list: AgentRun[], now: number, columns: number) {
  const { Box, Text } = ui
  const running = list.filter(a => a.status === 'running').reverse()
  const finished = list.filter(a => a.status !== 'running').reverse()
  const t = totals(list, now)
  const stats: [string, string][] = [
    ['Cost', fmtCost(t.cost)],
    ['Tokens', fmtTokens(t.tokens)],
    ['Time', fmtTime(t.time)],
  ]
  const note = (
    <Text key="note" dimColor italic wrap="wrap">
      Costs are estimates from list prices per model; the engine reports tokens, not money.
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
        return <Svg key={a.id} source={agentRowSvg(W, r)} alt={`${r.title}: ${STATUS_WORD[a.status]}, ${r.type}, ${r.model}, ${r.elapsed}, ${r.tokens}, ${r.cost}`} width={W} height={AGENT_ROW_H} />
      })
    return (
      <Box flexDirection="column" gap={1}>
        <Svg key="head" source={agentsHeaderSvg(W, t.done, t.running, t.total, stats)} alt={`Subagents: ${t.done} of ${t.total} finished. ${stats.map(s => s.join(' ')).join(', ')}`} width={W} height={AGENTS_HEADER_H} />
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
    return (
      <Box key={a.id} flexDirection="column" marginBottom={1}>
        <Text wrap="truncate-end">
          <Text color={STATUS_COLOR[a.status]} bold>{`${STATUS_GLYPH[a.status]} `}</Text>
          <Text bold>{r.title}</Text>
        </Text>
        <Text dimColor wrap="truncate-end">{`  ${r.type} · ${r.model} · ${r.elapsed} · ${r.tokens} · ${r.cost}`}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text key="head" wrap="truncate-end">
        <Text backgroundColor={BRAND.royal} color={BRAND.white} bold>
          {' ≋ AGENTS '}
        </Text>
        <Text bold color={BRAND.sky}>{`  ${t.done} of ${t.total} finished`}</Text>
      </Text>
      <Text key="bar" wrap="truncate-end">
        <Text color={BRAND.blue}>{bar(t.done, t.total, barW)}</Text>
        <Text dimColor>{`  ${stats.map(([k, v]) => `${k.toLowerCase()} ${v}`).join(' · ')}`}</Text>
      </Text>
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

/** The band: finished out of total, and a button that toggles the panel. */
export function drawAgentsBand(ui: Ui, surface: Surface, list: AgentRun[], columns: number, toggle: () => void) {
  const { Box, Text, Button } = ui
  const t = totals(list, 0)
  const button = <Button key="toggle-agents" label="Agents" hotkey="a" onPress={toggle} />
  if (surface === 'desktop' && 'Svg' in ui) {
    const { Svg } = ui
    const W = Math.min(pxOf(columns, 110, 220), 720)
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Svg key="agents" source={agentsBandSvg(W, t.done, t.running, t.total, fmtCost(t.cost))} alt={`Agents: ${t.done} of ${t.total} finished, ${fmtCost(t.cost)}`} width={W} height={BAND_ROW_H} />
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
        <Text color={BRAND.blue}>{bar(t.done, t.total, barW)}</Text>
        <Text dimColor>{`  ${t.done}/${t.total} finished · ${fmtCost(t.cost)}`}</Text>
      </Text>
      {button}
    </Box>
  )
}
