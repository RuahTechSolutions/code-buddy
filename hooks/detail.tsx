// Feature 4, agent details: everything Code Buddy sees about one subagent,
// gathered from agent.spawn, its tool calls, its model requests and its end,
// and the view that shows it when you click Details on a row. Pure helpers
// and drawing: register.tsx calls the engine and stores the record.

import type { EngineInterface } from 'claude-code'

import type { AgentDetail, AgentRun, TimelineEntry } from '../types'
import { activityOf, fmtCost, fmtTime, fmtTokens, modelName } from './agents'
import type { Usage } from './agents'
import { mask } from './mask'
import { BRAND, GREEN, detailHeaderSvg, labelSvg, pxOf, statsGridSvg, tokenBreakdownSvg } from './theme'

type Ui = ReturnType<EngineInterface['ui']['resolve']>
type Surface = 'terminal' | 'desktop' | 'mobile' | 'vscode'

const PROMPT_MAX = 6000
const REPORT_MAX = 8000
const MESSAGE_MAX = 2000
const TIMELINE_MAX = 60
const LIST_MAX = 200
const COMMANDS_MAX = 30

const cap = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n)}\n\n… ${text.length - n} more characters not shown` : text)
const rel = (cwd: string, path: string): string => (cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)
const addUnique = (list: string[], item: string): string[] => (item && !list.includes(item) ? [...list, item].slice(-LIST_MAX) : list)

const READS = new Set(['Read', 'NotebookRead'])
const EDITS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

// ---- Building the record --------------------------------------------------------

export type SpawnFacts = {
  id: string
  prompt: string
  name?: string
  cwd?: string
  permissionMode?: string
  background: boolean
  fork: boolean
  model?: string
  parentModel: string
  parentAgentId?: string
  teammateId?: string
}

export function newDetail(f: SpawnFacts, at: number): AgentDetail {
  return {
    id: f.id,
    prompt: mask(cap(f.prompt, PROMPT_MAX)),
    name: f.name ? mask(f.name) : undefined,
    cwd: f.cwd,
    permissionMode: f.permissionMode,
    isBackground: f.background,
    isFork: f.fork,
    requestedModel: f.model,
    parentModel: f.parentModel,
    parentAgentId: f.parentAgentId,
    teammateId: f.teammateId,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    lastContext: 0,
    timeline: [],
    toolCounts: {},
    errors: 0,
    holds: 0,
    filesRead: [],
    filesChanged: [],
    commands: [],
    lastMessage: '',
    finalReport: '',
    lastActivityAt: at,
  }
}

/** What a tool call acted on, without the tool's name. */
const targetOf = (e: Record<string, unknown>, cwd: string): string => activityOf(e, cwd).replace(/^[^·]*·\s?/, '')

/** A tool call starts: a timeline entry, a count, a file read or a command. */
export function onToolStart(d: AgentDetail, e: Record<string, unknown>, cwd: string, entryId: string, at: number): AgentDetail {
  const tool = String(e.tool)
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(-1)[0] ?? tool : tool
  const entry: TimelineEntry = { id: entryId, at, tool: name, target: targetOf(e, cwd), status: 'running' }
  const path = typeof e.file_path === 'string' ? mask(rel(cwd, e.file_path)) : ''
  const command = tool === 'Bash' && typeof e.command === 'string' ? mask(e.command.split('\n')[0] ?? '').slice(0, 200) : ''
  return {
    ...d,
    timeline: [...d.timeline, entry].slice(-TIMELINE_MAX),
    toolCounts: { ...d.toolCounts, [name]: (d.toolCounts[name] ?? 0) + 1 },
    filesRead: READS.has(tool) ? addUnique(d.filesRead, path) : d.filesRead,
    commands: command ? [...d.commands, command].slice(-COMMANDS_MAX) : d.commands,
    lastActivityAt: at,
  }
}

/** A tool call ends: ok, an error, or held by Code Buddy; a successful edit adds its file. */
export function onToolEnd(d: AgentDetail, e: Record<string, unknown>, cwd: string, entryId: string, status: 'ok' | 'error' | 'held', at: number): AgentDetail {
  const path = typeof e.file_path === 'string' ? mask(rel(cwd, e.file_path)) : ''
  return {
    ...d,
    timeline: d.timeline.map(t => (t.id === entryId ? { ...t, status } : t)),
    errors: d.errors + (status === 'error' ? 1 : 0),
    holds: d.holds + (status === 'held' ? 1 : 0),
    filesChanged: status === 'ok' && EDITS.has(String(e.tool)) ? addUnique(d.filesChanged, path) : d.filesChanged,
    lastActivityAt: at,
  }
}

/** One model request: tokens and cost by kind, the context it held, its effort and its text. */
export function onStep(d: AgentDetail, u: Usage, cost: { input: number; output: number; cacheRead: number; cacheWrite: number }, effort: string | undefined, answer: string, at: number): AgentDetail {
  return {
    ...d,
    usage: {
      input: d.usage.input + (u.input_tokens || 0),
      output: d.usage.output + (u.output_tokens || 0),
      cacheRead: d.usage.cacheRead + (u.cache_read_input_tokens || 0),
      cacheWrite: d.usage.cacheWrite + (u.cache_creation_input_tokens || 0),
    },
    cost: {
      input: d.cost.input + cost.input,
      output: d.cost.output + cost.output,
      cacheRead: d.cost.cacheRead + cost.cacheRead,
      cacheWrite: d.cost.cacheWrite + cost.cacheWrite,
    },
    lastContext: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    effort: effort ?? d.effort,
    lastMessage: answer.trim() ? mask(cap(answer.trim(), MESSAGE_MAX)) : d.lastMessage,
    lastActivityAt: at,
  }
}

/** It ended: its answer is the final report. */
export function onFinish(d: AgentDetail, answer: string, reason: string, at: number): AgentDetail {
  return {
    ...d,
    finalReport: answer.trim() ? mask(cap(answer.trim(), REPORT_MAX)) : d.finalReport,
    endReason: reason,
    timeline: d.timeline.map(t => (t.status === 'running' ? { ...t, status: 'error' } : t)),
    lastActivityAt: at,
  }
}

// ---- Drawing -------------------------------------------------------------------

export type DetailActions = { back: () => void; copy: (text: string) => void }

const STATUS_GLYPH = { running: '●', ok: '✓', error: '✗', held: '⏸' } as const
const STATUS_COLOR = { running: BRAND.sky, ok: GREEN, error: BRAND.coral, held: BRAND.coral } as const
const END_WORD: Record<string, string> = { answer: 'finished with an answer', aborted: 'stopped (interrupted)', error: 'ended with an error', refusal: 'ended with a refusal' }

const windowOf = (model: string): number => (/haiku-4/i.test(model) ? 200_000 : 1_000_000)
const sinceText = (ms: number): string => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s ago` : `${fmtTime(ms)} ago`)
const pct = (n: number, of: number): string => (of > 0 ? `${Math.round((n / of) * 100)}%` : '0%')

/** The detail view of one subagent. */
export function drawAgentDetail(ui: Ui, surface: Surface, a: AgentRun, d: AgentDetail | undefined, now: number, columns: number, act: DetailActions) {
  const { Box, Text, Button, Markdown, Code } = ui
  const back = <Button key="back" label="◀ All agents" hotkey="b" onPress={() => act.back()} />
  if (d === undefined) {
    return (
      <Box flexDirection="column" gap={1}>
        {back}
        <Text dimColor wrap="wrap">
          No details were recorded for this subagent (it started before Code Buddy loaded).
        </Text>
      </Box>
    )
  }

  const elapsedMs = (a.endedAt ?? Math.max(now, a.startedAt)) - a.startedAt
  const title = a.description || d.name || a.type
  const effort = d.effort ? ` · ${d.effort} effort` : ''
  const meta = `${a.type} · ${modelName(a.model)}${effort}${d.isBackground ? ' · background' : ''}${d.isFork ? ' · fork' : ''}`
  const row = { status: a.status, title, type: a.type, model: modelName(a.model), elapsed: fmtTime(elapsedMs), tokens: '', cost: '' }
  const tools = Object.entries(d.toolCounts).sort((x, y) => y[1] - x[1])
  const toolTotal = tools.reduce((s, [, n]) => s + n, 0)
  const window = windowOf(a.model)
  const stats: [string, string, string?][] = [
    ['Tokens', fmtTokens(a.tokens)],
    ['Cost', fmtCost(a.costUsd)],
    ['Requests', String(a.steps)],
    ['Tool calls', String(toolTotal)],
    ['Errors', String(d.errors), d.holds ? `${d.holds} held` : undefined],
    ['Context', fmtTokens(d.lastContext), pct(d.lastContext, window)],
  ]
  const parts: [string, string, string, number][] = [
    ['Input', fmtTokens(d.usage.input), fmtCost(d.cost.input), d.usage.input],
    ['Output', fmtTokens(d.usage.output), fmtCost(d.cost.output), d.usage.output],
    ['Cache reads', fmtTokens(d.usage.cacheRead), fmtCost(d.cost.cacheRead), d.usage.cacheRead],
    ['Cache writes', fmtTokens(d.usage.cacheWrite), fmtCost(d.cost.cacheWrite), d.usage.cacheWrite],
  ]
  const recent = [...d.timeline].reverse().slice(0, 15)
  const facts: [string, string][] = [
    ['Agent ID', a.agentId ?? a.id],
    ['Status', a.status === 'running' ? `running for ${fmtTime(elapsedMs)}` : `${END_WORD[d.endReason ?? ''] ?? a.status} after ${fmtTime(elapsedMs)}`],
    ['Model', `${a.model}${d.requestedModel && d.requestedModel !== a.model ? ` (asked for ${d.requestedModel})` : ''}`],
    ['Parent model', d.parentModel],
    ...(d.effort ? ([['Effort', d.effort]] as [string, string][]) : []),
    ['Runs', `${d.isBackground ? 'in the background' : 'in the foreground'}${d.isFork ? ', as a fork' : ''}`],
    ...(d.teammateId ? ([['Teammate', d.teammateId]] as [string, string][]) : []),
    ...(d.parentAgentId ? ([['Started by', `agent ${d.parentAgentId}`]] as [string, string][]) : []),
    ...(d.permissionMode ? ([['Permissions', d.permissionMode]] as [string, string][]) : []),
    ...(d.cwd ? ([['Folder', d.cwd]] as [string, string][]) : []),
    ['Code Buddy holds', String(d.holds)],
  ]

  const isDesktop = surface === 'desktop' && 'Svg' in ui
  const W = pxOf(columns, 16, 240)
  const label = (key: string, text: string) =>
    isDesktop && 'Svg' in ui ? (
      <ui.Svg key={key} source={labelSvg(W, text)} alt={text} width={W} height={18} />
    ) : (
      <Text key={key} bold color={BRAND.sky}>{`\n${text.toUpperCase()}`}</Text>
    )

  const header =
    isDesktop && 'Svg' in ui ? (
      (() => {
        const card = detailHeaderSvg(W, row, meta)
        return <ui.Svg key="head" source={card.source} alt={`${title}. ${row.elapsed}. ${meta}`} width={W} height={card.height} />
      })()
    ) : (
      <Box key="head" flexDirection="column">
        <Text wrap="wrap">
          <Text backgroundColor={BRAND.royal} color={BRAND.white} bold>{` ${a.status.toUpperCase()} `}</Text>
          <Text bold>{`  ${title}`}</Text>
        </Text>
        <Text dimColor wrap="wrap">{`${meta} · ${row.elapsed}`}</Text>
      </Box>
    )
  const numbers =
    isDesktop && 'Svg' in ui ? (
      (() => {
        const g = statsGridSvg(W, stats)
        const t = tokenBreakdownSvg(W, parts)
        return (
          <Box key="numbers" flexDirection="column" gap={1}>
            <ui.Svg key="stats" source={g.source} alt={stats.map(([k, v, s]) => `${k} ${v}${s ? ` (${s})` : ''}`).join(', ')} width={W} height={g.height} />
            <ui.Svg key="tokens" source={t.source} alt={parts.map(([k, n, c]) => `${k} ${n} ${c}`).join(', ')} width={W} height={t.height} />
          </Box>
        )
      })()
    ) : (
      <Box key="numbers" flexDirection="column">
        <Text wrap="wrap">{stats.map(([k, v, s]) => `${k} ${v}${s ? ` (${s})` : ''}`).join(' · ')}</Text>
        <Text dimColor wrap="wrap">{parts.map(([k, n, c]) => `${k.toLowerCase()} ${n} ${c}`).join(' · ')}</Text>
      </Box>
    )

  return (
    <Box flexDirection="column" gap={isDesktop ? 1 : 0} paddingX={isDesktop ? 0 : 1}>
      {back}
      {header}
      {a.status === 'running' && (
        <Box key="now" flexDirection="column">
          <Text wrap="wrap">
            <Text color={BRAND.sky} bold>{'▸ Now  '}</Text>
            <Text color={BRAND.sky}>{a.activity || 'thinking…'}</Text>
          </Text>
          <Text dimColor>{`step ${a.steps} · last activity ${sinceText(now - d.lastActivityAt)}`}</Text>
        </Box>
      )}
      {numbers}

      {label('l-task', 'Task')}
      <Markdown key="task" text={d.prompt || '_No brief recorded._'} />
      <Button key="copy-task" label="Copy task" plain onPress={() => act.copy(d.prompt)} />

      {(d.finalReport || d.lastMessage) && label('l-report', d.finalReport ? 'Final report' : 'Latest message')}
      {(d.finalReport || d.lastMessage) && <Markdown key="report" text={d.finalReport || d.lastMessage} />}
      {d.finalReport && <Button key="copy-report" label="Copy report" plain onPress={() => act.copy(d.finalReport)} />}

      {label('l-timeline', `Timeline · last ${recent.length} of ${d.timeline.length}`)}
      {recent.length === 0 && <Text key="t-none" dimColor>No tool calls yet.</Text>}
      {recent.map(t => (
        <Text key={`t-${t.id}`} wrap="truncate-end">
          <Text dimColor>{`+${fmtTime(t.at - a.startedAt).padStart(5)} `}</Text>
          <Text color={STATUS_COLOR[t.status]} bold>{`${STATUS_GLYPH[t.status]} `}</Text>
          <Text bold>{`${t.tool} `}</Text>
          <Text dimColor>{t.target}</Text>
        </Text>
      ))}

      {tools.length > 0 && label('l-tools', `Tools used · ${toolTotal}`)}
      {tools.length > 0 && <Text key="tools" wrap="wrap">{tools.map(([n, c]) => `${n} ${c}`).join(' · ')}</Text>}

      {d.filesChanged.length > 0 && label('l-changed', `Files changed · ${d.filesChanged.length}`)}
      {d.filesChanged.length > 0 && <Code key="changed" source={d.filesChanged.slice(-20).join('\n')} language="text" wrap="truncate-end" />}

      {d.filesRead.length > 0 && label('l-read', `Files read · ${d.filesRead.length}`)}
      {d.filesRead.length > 0 && <Code key="read" source={`${d.filesRead.slice(-12).join('\n')}${d.filesRead.length > 12 ? `\n… and ${d.filesRead.length - 12} more` : ''}`} language="text" wrap="truncate-end" />}

      {d.commands.length > 0 && label('l-commands', `Commands run · ${d.commands.length}`)}
      {d.commands.length > 0 && <Code key="commands" source={d.commands.slice(-8).join('\n')} language="bash" wrap="truncate-end" />}

      {label('l-facts', 'Details')}
      {facts.map(([k, v]) => (
        <Text key={`f-${k}`} wrap="wrap">
          <Text dimColor>{`${k.padEnd(16)} `}</Text>
          <Text>{v}</Text>
        </Text>
      ))}
      <Button key="back-end" label="◀ All agents" onPress={() => act.back()} />
    </Box>
  )
}
