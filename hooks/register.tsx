// Code Buddy: one plugin, four features.
//   1. Staging guard  (guard.ts)  holds calls that reach production
//   2. Blast radius   (blast.ts)  holds destructive shell commands
//   3. Replay         (replay.tsx, diff.ts)  steps through a turn's edits
//   4. Agents panel   (agents.tsx)  tracks every subagent
// Features 1 and 2 share the hold pane (hold.tsx); all four share the band.
// Only this file calls the engine (`$`); the others are pure logic and drawing.
// No network requests, no model calls, no environment variables.

import type { EngineInterface, Register } from 'claude-code'

import type { AgentDetail, AgentRun, AgentsUi, HeldRecord, Pauses, HoldOutcome, HoldView, Replay, ReplayStep } from '../types'
import {
  AGENTS_PANE,
  activityOf,
  agentsConfigOf,
  agentsPaneArgs,
  agentsRows,
  barRuns,
  budgetOf,
  costOf,
  costParts,
  drawAgents,
  drawAgentsBand,
  fmtUsd,
  parseBudget,
  tokensOf,
} from './agents'
import type { AgentsConfig, Usage } from './agents'
import { inspectBlast, looksDestructive, merge } from './blast'
import { drawAgentDetail, newDetail, onFinish, onStep, onToolEnd, onToolStart } from './detail'
import { applyEdits, buildStep, relPath } from './diff'
import { CONTROL_PANE, controlRows, drawControl } from './control'
import type { SettingField } from './control'
import { FEATURES, durText, enabledOf, expire, featureOf, isPaused, leftText, nameOf, parseDuration } from './features'
import type { Feature } from './features'
import { configOf, inspectGuard, looksRisky, parseList } from './guard'
import type { Finding, GuardConfig, Io } from './guard'
import { HOLD_LIMIT_MS, HOLD_PANE, OUTCOME_LABEL, POLL_SECONDS, drawHold, drawHoldBand, drawIdleBand, paneRows, pending, refusal } from './hold'
import type { Pending } from './hold'
import { mask } from './mask'
import { REPLAY_PANE, drawReplay, drawReplayBand, replayRows } from './replay'

const COMMAND = 'code-buddy'
const QUEUE = { plugin: 'code-buddy', key: 'queue' } as const
const LOG = { plugin: 'code-buddy', key: 'log' } as const
const RECORDING = { plugin: 'code-buddy', key: 'recording' } as const
const REPLAY = { plugin: 'code-buddy', key: 'replay' } as const
const AGENTS = { plugin: 'code-buddy', key: 'agents' } as const
const BATCH = { plugin: 'code-buddy', key: 'batch' } as const
const AGENTS_UI = { plugin: 'code-buddy', key: 'agentsUi' } as const
const DETAILS = { plugin: 'code-buddy', key: 'details' } as const
const SEEN = { plugin: 'code-buddy', key: 'seenSurface' } as const
const PAUSES = { plugin: 'code-buddy', key: 'pauses' } as const
const UI_DEFAULT: AgentsUi = { isCompact: false, autoOpenedBatch: -1, budgetAlertedAt: 0 }

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const MAX_STEPS = 100

const CONFIG_FIELDS: Record<string, { key: string; label: string }> = {
  production: { key: 'productionDomains', label: 'Production domains' },
  staging: { key: 'stagingDomains', label: 'Staging domains' },
  branch: { key: 'protectedBranch', label: 'Protected branch' },
  guard: { key: 'guard', label: 'Guard' },
  budget: { key: 'agentBudgetUsd', label: 'Subagent budget' },
  autoopen: { key: 'autoOpenAgents', label: 'Auto-open agents panel' },
  stagingguard: { key: 'stagingGuard', label: 'Staging guard' },
  blast: { key: 'blastRadius', label: 'Blast radius' },
  replay: { key: 'replay', label: 'Replay' },
  agents: { key: 'agentsPanel', label: 'Agents panel' },
}

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  return `${Math.round(s / 3600)} h ago`
}

let serial = 0
// Whether anyone could ever answer a hold: a REPL session, or one some surface has
// drawn Code Buddy on (the desktop app attaches its window after the session starts).
let isInteractive = false
let hasDrawn = false
// Whether `seenSurface` is already written, so the tick doesn't read it every second.
let isSeenSaved = false

/**
 * Remembers in session state, which outlives a reload of this module, that a
 * window has been attached: a hold then waits for an answer instead of refusing.
 */
async function markSeen($: EngineInterface): Promise<void> {
  if (isSeenSaved) return
  if ((await $.state.get(SEEN)).value !== true) await $.state.set(SEEN, true)
  isSeenSaved = true
}

// ---- Engine access (every `$` call lives in this file) ----------------------

/** What guard.ts may read: the session folder, local commands, folder listings. */
function ioOf($: EngineInterface): Io {
  return {
    cwd: () => $.session.cwd(),
    run: async (argv, cwd, timeoutMs) => {
      try {
        const r = await $.process.run(argv, { cwd, timeoutMs })
        return { exitCode: r.exitCode, stdout: r.stdout }
      } catch {
        return null
      }
    },
    list: async dir => {
      try {
        return (await $.fs.list(dir)).map(f => f.name)
      } catch {
        return []
      }
    },
  }
}

async function readLog($: EngineInterface): Promise<HeldRecord[]> {
  return (await $.state.get(LOG)).value ?? []
}

/** Writes the log with read-modify-write, again on a lost race. */
async function writeLog($: EngineInterface, change: (list: HeldRecord[]) => HeldRecord[]): Promise<void> {
  for (let tries = 0; tries < 5; tries += 1) {
    const now = await $.state.get(LOG)
    const done = await $.state.set(LOG, change(now.value ?? []), { ifVersion: now.version })
    if (done.isSet) return
  }
}

async function record($: EngineInterface, view: HoldView, outcome: HoldOutcome, at: number): Promise<void> {
  await writeLog($, list => {
    const row: HeldRecord = { id: view.id, at, tool: view.tool, rules: view.rules, command: view.command, outcome }
    return list.some(r => r.id === view.id) ? list.map(r => (r.id === view.id ? row : r)) : [...list, row].slice(-200)
  })
}

async function publish($: EngineInterface): Promise<void> {
  await $.state.set(QUEUE, pending.map(p => p.view))
}

async function pause($: EngineInterface): Promise<void> {
  await $.process.run(['sleep', POLL_SECONDS], { timeoutMs: 5000 })
}

/**
 * Holds the call until the person answers, one hold shown at a time. Resolves
 * the outcome: `proceeded` runs the call, anything else refuses it.
 */
async function hold($: EngineInterface, signal: AbortSignal, tool: string, found: Finding, isSubagent: boolean): Promise<HoldOutcome> {
  serial += 1
  const heldAt = await $.clock.now()
  const view: HoldView = { id: `h${heldAt}-${serial}`, tool, rules: found.rules, command: found.command, affects: found.affects, isSubagent }

  // Nobody could ever answer (a -p run, an SDK session no surface ever drew): refuse at
  // once. A desktop window that is only detached for now gets the usual 10 minutes.
  const surfaces = await $.session.surfaces()
  if (surfaces.length > 0 || hasDrawn) await markSeen($)
  else if (!isInteractive && (await $.state.get(SEEN)).value !== true) {
    await record($, view, 'no-one', heldAt)
    return 'no-one'
  }

  const mine: Pending = { view, decision: null }
  pending.push(mine)
  let outcome: HoldOutcome = 'error'
  try {
    await record($, view, 'waiting', heldAt)
    await publish($)

    while (pending[0] !== mine) {
      if (signal.aborted) {
        outcome = 'interrupted'
        return outcome
      }
      await pause($)
    }

    await $.ui.open({ id: HOLD_PANE, title: 'Code Buddy · held', focus: true, rows: paneRows(view) })
    $.ui.invalidate('ui.render')
    const shownAt = await $.clock.now()
    for (;;) {
      if (mine.decision !== null) {
        outcome = mine.decision === 'proceed' ? 'proceeded' : 'cancelled'
        break
      }
      if (signal.aborted) {
        outcome = 'interrupted'
        break
      }
      if ((await $.clock.now()) - shownAt >= HOLD_LIMIT_MS) {
        outcome = 'timeout'
        break
      }
      await pause($)
    }
    return outcome
  } catch {
    outcome = 'error' // anything unexpected refuses the call
    return outcome
  } finally {
    const i = pending.indexOf(mine)
    if (i >= 0) pending.splice(i, 1)
    try {
      if (pending.length === 0) await $.ui.close({ id: HOLD_PANE })
      await publish($)
      await record($, view, outcome, heldAt)
    } catch {
      // the pane is already gone
    }
    $.ui.invalidate('ui.render')
  }
}

// ---- Replay (feature 3) -------------------------------------------------------

/** The step an edit makes: the file's text before, the edit applied. Null when not an edit. */
async function stepFor($: EngineInterface, e: Record<string, unknown>): Promise<ReplayStep | null> {
  const tool = String(e.tool)
  const path = String(e.file_path ?? e.notebook_path ?? '')
  if (!EDIT_TOOLS.has(tool) || !path) return null
  let before = ''
  let isNew = true
  try {
    if (await $.fs.exists(path)) {
      before = await $.fs.read(path)
      isNew = false
    }
  } catch {
    // unreadable: shown as a new file
  }
  const file = relPath(await $.session.cwd(), path)
  if (tool === 'Write') return buildStep(file, tool, isNew ? '' : 'rewrite', before, String(e.content ?? ''), isNew)
  if (tool === 'NotebookEdit') return buildStep(file, tool, `cell ${String(e.edit_mode ?? 'replace')}`, '', String(e.new_source ?? ''), false)
  const edits = tool === 'MultiEdit' && Array.isArray(e.edits) ? (e.edits as Record<string, unknown>[]) : [e]
  const after = applyEdits(before, edits)
  if (after === null) return null
  const note = tool === 'MultiEdit' ? `${edits.length} edits` : e.replace_all === true ? 'replace all' : ''
  return buildStep(file, tool, note, before, after, isNew)
}

async function recordStep($: EngineInterface, step: ReplayStep): Promise<void> {
  for (let tries = 0; tries < 5; tries += 1) {
    const now = await $.state.get(RECORDING)
    const done = await $.state.set(RECORDING, [...(now.value ?? []), step].slice(-MAX_STEPS), { ifVersion: now.version })
    if (done.isSet) return
  }
}

/** Opens the replay pane on step 1; false when there is nothing to replay. */
async function openReplay($: EngineInterface): Promise<boolean> {
  const r = (await $.state.get(REPLAY)).value
  if (!r || r.steps.length === 0) return false
  await $.state.set(REPLAY, { ...r, index: 0, isSeen: true })
  await $.ui.open({ id: REPLAY_PANE, title: 'Code Buddy · replay', focus: true, closeOnEscape: true, rows: replayRows(r) })
  return true
}

async function goToStep($: EngineInterface, index: number): Promise<void> {
  const r = (await $.state.get(REPLAY)).value
  if (!r) return
  await $.state.set(REPLAY, { ...r, index: Math.max(0, Math.min(index, r.steps.length - 1)) })
}

// ---- Agents (feature 4) ---------------------------------------------------------

/** Changes the list of runs with read-modify-write, again on a lost race. */
async function writeAgents($: EngineInterface, change: (list: AgentRun[]) => AgentRun[]): Promise<void> {
  for (let tries = 0; tries < 5; tries += 1) {
    const now = await $.state.get(AGENTS)
    const done = await $.state.set(AGENTS, change(now.value ?? []), { ifVersion: now.version })
    if (done.isSet) return
  }
}

/** Opens the agents panel, or closes it when it is up; true when it ends up open. */
async function toggleAgents($: EngineInterface): Promise<boolean> {
  if ((await $.ui.panes()).some(p => p.id === AGENTS_PANE)) {
    await $.ui.close({ id: AGENTS_PANE })
    return false
  }
  const n = ((await $.state.get(AGENTS)).value ?? []).length
  await $.ui.open(agentsPaneArgs(agentsRows(n, (await readUi($)).isCompact)))
  return true
}

async function readUi($: EngineInterface): Promise<AgentsUi> {
  return { ...UI_DEFAULT, ...((await $.state.get(AGENTS_UI)).value ?? {}) }
}

/** Full rows or one line each; the open pane is resized to match. */
async function toggleCompact($: EngineInterface): Promise<void> {
  const ui = await readUi($)
  await $.state.set(AGENTS_UI, { ...ui, isCompact: !ui.isCompact })
  if ((await $.ui.panes()).some(p => p.id === AGENTS_PANE)) {
    const n = ((await $.state.get(AGENTS)).value ?? []).length
    await $.ui.open(agentsPaneArgs(agentsRows(n, !ui.isCompact)))
  }
}

/** Opens the panel by itself once a turn has two subagents; once per turn, so a close sticks. */
async function maybeAutoOpen($: EngineInterface, batch: number): Promise<void> {
  const list = (await $.state.get(AGENTS)).value ?? []
  if (list.filter(a => a.batch === batch).length < 2) return
  const ui = await readUi($)
  if (ui.autoOpenedBatch === batch) return
  await $.state.set(AGENTS_UI, { ...ui, autoOpenedBatch: batch })
  if ((await $.ui.panes()).some(p => p.id === AGENTS_PANE)) return
  await $.ui.open(agentsPaneArgs(agentsRows(list.length, ui.isCompact)))
}

/** A subagent's tool call: what it is doing now, and one more tool. */
async function noteActivity($: EngineInterface, agentId: string, activity: string): Promise<void> {
  await writeAgents($, list => list.map(a => (a.agentId === agentId && a.status === 'running' ? { ...a, activity, tools: (a.tools ?? 0) + 1 } : a)))
}

/** Changes one subagent's detail record, again on a lost race; nothing when it has none. */
async function writeDetail($: EngineInterface, id: string, change: (d: AgentDetail) => AgentDetail): Promise<void> {
  for (let tries = 0; tries < 5; tries += 1) {
    const cur = await $.state.get({ ...DETAILS, id })
    if (!cur.value) return
    const done = await $.state.set({ ...DETAILS, id }, change(cur.value), { ifVersion: cur.version })
    if (done.isSet) return
  }
}

let entrySerial = 0

/** A subagent's tool call starts: its timeline entry. Returns the entry's id ('' when not recorded). */
async function startDetailEntry($: EngineInterface, agentId: string, input: Record<string, unknown>): Promise<string> {
  try {
    const at = await $.clock.now()
    entrySerial += 1
    const id = `${at}-${entrySerial}`
    const cwd = await $.session.cwd()
    await writeDetail($, agentId, d => onToolStart(d, input, cwd, id, at))
    return id
  } catch {
    return ''
  }
}

/** It ended: ok, an error, or held by Code Buddy. */
async function endDetailEntry($: EngineInterface, agentId: string, input: Record<string, unknown>, entryId: string, ran: { deny?: string; isError?: boolean }): Promise<void> {
  try {
    const status = ran.deny !== undefined ? (ran.deny.startsWith('Code Buddy') ? 'held' : 'error') : ran.isError === true ? 'error' : 'ok'
    const at = await $.clock.now()
    const cwd = await $.session.cwd()
    await writeDetail($, agentId, d => onToolEnd(d, input, cwd, entryId, status, at))
  } catch {
    // details must never fail a call
  }
}

/** Shows one subagent's details in the panel, or the list again (undefined). */
async function selectAgent($: EngineInterface, id: string | undefined): Promise<void> {
  const ui = await readUi($)
  await $.state.set(AGENTS_UI, { ...ui, selected: id })
  if (id !== undefined && (await $.ui.panes()).some(p => p.id === AGENTS_PANE)) await $.ui.open(agentsPaneArgs(34))
}

async function copyText($: EngineInterface, text: string, surface: 'terminal' | 'desktop' | 'mobile' | 'vscode'): Promise<void> {
  const done = await $.ui.copy({ text, surface })
  $.ui.toast(done.isCopied ? 'Code Buddy: copied' : 'Code Buddy: could not copy here')
}

/** One toast when the session's subagents pass the budget (again only if the budget changes). */
async function checkBudget($: EngineInterface, budget: number): Promise<void> {
  if (budget <= 0) return
  const b = budgetOf((await $.state.get(AGENTS)).value ?? [], budget)
  if (!b?.isOver) return
  const ui = await readUi($)
  if (ui.budgetAlertedAt === budget) return
  await $.state.set(AGENTS_UI, { ...ui, budgetAlertedAt: budget })
  $.ui.toast(`Code Buddy: subagents have used ${b.used} this session, over your ${b.limit} budget.`, { timeoutMs: 8000 })
}

/** One model request of a subagent: its tokens and estimated cost. */
async function addUsage($: EngineInterface, agentId: string, model: string, usage: Usage): Promise<void> {
  await writeAgents($, list =>
    list.map(a =>
      a.agentId !== agentId
        ? a
        : { ...a, model: model || a.model, tokens: a.tokens + tokensOf(usage), costUsd: a.costUsd + costOf(model || a.model, usage), steps: a.steps + 1 },
    ),
  )
}

/** A subagent's turn ended: done, failed or stopped, with the turn's usage when no step was seen. */
async function finishAgent($: EngineInterface, agentId: string, reason: string, usage: (Usage & { model?: string }) | undefined): Promise<void> {
  const at = await $.clock.now()
  const status: AgentRun['status'] = reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'
  await writeAgents($, list =>
    list.map(a => {
      if (a.agentId !== agentId || a.status !== 'running') return a
      const model = usage?.model || a.model
      const fallback = a.steps === 0 && usage ? { model, tokens: tokensOf(usage), costUsd: costOf(model, usage) } : {}
      return { ...a, ...fallback, status, endedAt: at, activity: undefined }
    }),
  )
}

// ---- Feature 5: pausing features and the control panel ---------------------------

let version = ''

async function readVersion($: EngineInterface): Promise<string> {
  try {
    const text = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)
    return String((JSON.parse(text) as { version?: unknown }).version ?? '')
  } catch {
    return ''
  }
}

async function pausesOf($: EngineInterface): Promise<Pauses> {
  return (await $.state.get(PAUSES)).value ?? {}
}

/** On in the settings and not paused right now. */
async function isActive($: EngineInterface, enabled: Record<Feature, boolean>, f: Feature): Promise<boolean> {
  if (!enabled[f]) return false
  const p = await pausesOf($)
  return p[f] === undefined || !isPaused(p, f, await $.clock.now())
}

async function writePauses($: EngineInterface, change: (p: Pauses) => Pauses): Promise<void> {
  for (let tries = 0; tries < 5; tries += 1) {
    const cur = await $.state.get(PAUSES)
    const done = await $.state.set(PAUSES, change(cur.value ?? {}), { ifVersion: cur.version })
    if (done.isSet) return
  }
}

/** Pauses one feature, or every one that is on, for `ms` (0: until resumed). */
async function pauseFeature($: EngineInterface, f: Feature | 'all', ms: number, enabled: Record<Feature, boolean>): Promise<string> {
  const ids = f === 'all' ? FEATURES.map(x => x.id).filter(id => enabled[id]) : [f]
  const until = ms > 0 ? (await $.clock.now()) + ms : 0
  await writePauses($, p => {
    const next: Pauses = { ...p }
    for (const id of ids) next[id] = until
    return next
  })
  $.ui.invalidate('ui.render')
  const what = f === 'all' ? 'All features' : nameOf(f)
  const text = `Code Buddy: ${what} paused ${ms > 0 ? `for ${durText(ms)}` : 'until you resume'}. /code-buddy resume${f === 'all' ? '' : ` ${f}`} brings ${f === 'all' ? 'them' : 'it'} back.`
  $.ui.toast(text)
  return text
}

async function resumeFeature($: EngineInterface, f: Feature | 'all'): Promise<string> {
  const before = await pausesOf($)
  const ids = f === 'all' ? (Object.keys(before) as Feature[]) : [f]
  await writePauses($, p => {
    const next: Pauses = { ...p }
    for (const id of ids) delete next[id]
    return next
  })
  $.ui.invalidate('ui.render')
  const was = ids.filter(id => before[id] !== undefined)
  const text = was.length ? `Code Buddy: ${was.map(nameOf).join(', ')} resumed.` : `Code Buddy: ${f === 'all' ? 'nothing was' : `${nameOf(f)} wasn't`} paused.`
  $.ui.toast(text)
  return text
}

/** Turns a feature on or off in the settings, for every session. */
async function setFeatureOn($: EngineInterface, f: Feature, on: boolean, options: Record<string, unknown>): Promise<string> {
  const key = FEATURES.find(x => x.id === f)?.key
  if (!key) return ''
  if (on && (f === 'guard' || f === 'blast') && options.guard === false) await $.config.set({ key: 'code-buddy.guard', value: true })
  const done = await $.config.set({ key: `code-buddy.${key}`, value: on })
  const text = 'deny' in done && done.deny !== undefined ? `Couldn't change ${nameOf(f)}: ${done.deny}` : `Code Buddy: ${nameOf(f)} turned ${on ? 'on' : 'off'} for every session.`
  $.ui.toast(text)
  return text
}

const SETTING_KEYS: Record<SettingField, { key: string; label: string }> = {
  production: { key: 'productionDomains', label: 'Production domains' },
  staging: { key: 'stagingDomains', label: 'Staging domains' },
  branch: { key: 'protectedBranch', label: 'Protected branch' },
  budget: { key: 'agentBudgetUsd', label: 'Subagent budget' },
}

/** Saves one field of the control panel's settings. */
async function saveSetting($: EngineInterface, field: SettingField, text: string): Promise<void> {
  let value: string | number
  let shown: string
  if (field === 'budget') {
    const budget = parseBudget(text.trim() || 'off')
    if (budget === null) {
      $.ui.toast('Code Buddy: the budget takes an amount in dollars, like 2 or 2.50, or off.')
      return
    }
    value = budget
    shown = budget > 0 ? fmtUsd(budget) : 'off'
  } else {
    value = parseList(text).join(', ')
    shown = value || '(none)'
    if (field === 'branch' && !value) {
      $.ui.toast("Code Buddy: the protected branch can't be empty.")
      return
    }
  }
  const { key, label } = SETTING_KEYS[field]
  const done = await $.config.set({ key: `code-buddy.${key}`, value })
  $.ui.toast('deny' in done && done.deny !== undefined ? `Code Buddy: couldn't save ${label}: ${done.deny}` : `Code Buddy: ${label} set to ${shown}.`)
}

async function openControl($: EngineInterface): Promise<void> {
  await $.ui.open({ id: CONTROL_PANE, title: 'Code Buddy', focus: true, rows: controlRows(), columns: 72 })
}

/** Everything the guard and blast radius hold this call for; null lets it through. */
async function inspect($: EngineInterface, e: Record<string, unknown>, cfg: GuardConfig, enabled: Record<Feature, boolean>): Promise<Finding | null> {
  const guardOn = await isActive($, enabled, 'guard')
  const blastOn = await isActive($, enabled, 'blast')
  if (!guardOn && !blastOn) return null
  const io = ioOf($)
  return merge(guardOn ? await inspectGuard(io, e, cfg) : null, blastOn ? await inspectBlast(io, e) : null)
}

/** "Staging guard on · Blast radius paused (28m left) · Replay on · Agents panel off" */
async function featuresLine($: EngineInterface, enabled: Record<Feature, boolean>): Promise<string> {
  const p = await pausesOf($)
  const now = await $.clock.now()
  return FEATURES.map(f => `${f.name} ${!enabled[f.id] ? 'off' : isPaused(p, f.id, now) ? `paused (${leftText(p, f.id, now)})` : 'on'}`).join(' · ')
}

// ---- /code-buddy -------------------------------------------------------------

async function statusText($: EngineInterface, cfg: GuardConfig, acfg: AgentsConfig, enabled: Record<Feature, boolean>): Promise<string> {
  const log = await readLog($)
  const now = await $.clock.now()
  const lines = [
    `Code Buddy · ${log.length} held this session`,
    `  Features:   ${await featuresLine($, enabled)}`,
    `  Production: ${cfg.production.join(', ') || '(none)'}`,
    `  Staging:    ${cfg.staging.join(', ') || '(none)'} (production wins on overlap)`,
    `  Protected:  ${cfg.branches.join(', ')}`,
    `  Subagents:  budget ${acfg.budget > 0 ? fmtUsd(acfg.budget) : 'off'} · auto-open ${acfg.autoOpen ? 'on' : 'off'}`,
    '',
  ]
  if (log.length === 0) {
    lines.push('No calls held this session.')
  } else {
    lines.push('Held calls, newest first:')
    for (const r of [...log].reverse()) {
      lines.push(`  ${ago(now - r.at).padEnd(10)} ${r.tool.padEnd(8)} ${OUTCOME_LABEL[r.outcome]}`)
      lines.push(`      ${r.rules.join('; ')}`)
      lines.push(`      ${r.command.length > 160 ? `${r.command.slice(0, 159)}…` : r.command}`)
    }
  }
  lines.push('', 'More: /code-buddy control · pause · resume · replay · agents · config')
  return mask(lines.join('\n'))
}

function configText(cfg: GuardConfig, acfg: AgentsConfig, enabled: Record<Feature, boolean>): string {
  return [
    'Code Buddy settings',
    `  production  ${cfg.production.join(', ') || '(none)'}`,
    `  staging     ${cfg.staging.join(', ') || '(none)'}`,
    `  branch      ${cfg.branches.join(', ')}`,
    `  guard       ${cfg.isOn ? 'on' : 'off'}   (master switch for both hold features)`,
    `  stagingguard ${enabled.guard ? 'on' : 'off'}`,
    `  blast       ${enabled.blast ? 'on' : 'off'}`,
    `  replay      ${enabled.replay ? 'on' : 'off'}`,
    `  agents      ${enabled.agents ? 'on' : 'off'}`,
    `  budget      ${acfg.budget > 0 ? fmtUsd(acfg.budget) : 'off'}   (estimated subagent spend per session)`,
    `  autoopen    ${acfg.autoOpen ? 'on' : 'off'}   (agents panel opens when a 2nd subagent starts)`,
    '',
    'Production wins on overlap: a host is let through only when staging lists it exactly (no wildcard).',
    '',
    'Change one with /code-buddy config <setting> <value>, for example:',
    '  /code-buddy config production example.com, *.example.com',
    '  /code-buddy config staging staging.example.com',
    '  /code-buddy config branch main',
    '  /code-buddy config guard off',
    '  /code-buddy config budget 2.50',
    '  /code-buddy config autoopen off',
    '  /code-buddy config blast off      (off in every session; /code-buddy pause blast 30m pauses it for now)',
    '',
    'Or open the control panel: /code-buddy control',
  ].join('\n')
}

async function setConfig($: EngineInterface, args: string, cfg: GuardConfig, acfg: AgentsConfig, enabled: Record<Feature, boolean>): Promise<string> {
  const [name = '', ...rest] = args.trim().split(/\s+/)
  if (!name) return configText(cfg, acfg, enabled)
  const field = CONFIG_FIELDS[name.toLowerCase()]
  if (!field) return `Unknown setting "${name}". Settings: ${Object.keys(CONFIG_FIELDS).join(', ')}.`
  const text = rest.join(' ').trim()
  if (!text) return `Give a value: /code-buddy config ${name} <value>`
  const isSwitch = ['guard', 'autoOpenAgents', 'stagingGuard', 'blastRadius', 'replay', 'agentsPanel'].includes(field.key)
  if (isSwitch && text !== 'on' && text !== 'off') return `${field.label} takes on or off.`
  const budget = field.key === 'agentBudgetUsd' ? parseBudget(text) : 0
  if (budget === null) return 'Budget takes an amount in dollars, like 2 or 2.50, or off.'
  const value = isSwitch ? text === 'on' : field.key === 'agentBudgetUsd' ? budget : text
  const result = await $.config.set({ key: `${COMMAND}.${field.key}`, value })
  if ('deny' in result && result.deny !== undefined) return `Couldn't change ${field.label}: ${result.deny}`
  return `${field.label} set to ${text}. Code Buddy reloads with it now.`
}

/** What /code-buddy answers, for every subcommand. */
async function answerBuddy(
  $: EngineInterface,
  args: string,
  cfg: GuardConfig,
  acfg: AgentsConfig,
  enabled: Record<Feature, boolean>,
): Promise<{ text: string }> {
  const [sub = '', ...rest] = args.trim().split(/\s+/)
  switch (sub.toLowerCase()) {
    case '':
    case 'status':
      return { text: await statusText($, cfg, acfg, enabled) }
    case 'config':
      return { text: await setConfig($, rest.join(' '), cfg, acfg, enabled) }
    case 'replay': {
      const r = (await $.state.get(REPLAY)).value
      if (!(await openReplay($)) || !r) return { text: 'Code Buddy · replay: no edits recorded yet. It fills after a turn that edits files.' }
      return { text: `Code Buddy · replay: ${r.steps.length} ${r.steps.length === 1 ? 'edit' : 'edits'} from the last turn. Prev, Next and Close step through them.` }
    }
    case 'agents': {
      const isOpen = await toggleAgents($)
      const n = ((await $.state.get(AGENTS)).value ?? []).length
      return { text: isOpen ? `Code Buddy · agents panel opened (${n} ${n === 1 ? 'subagent' : 'subagents'} this session).` : 'Code Buddy · agents panel closed.' }
    }
    case 'control':
    case 'settings':
    case 'features':
      await openControl($)
      return { text: 'Code Buddy · control panel opened.' }
    case 'pause': {
      if (!rest[0]) {
        await openControl($)
        return { text: 'Code Buddy · control panel opened. Or pause from here: /code-buddy pause <guard | blast | replay | agents | all> [30m].' }
      }
      const f = featureOf(rest[0])
      if (f === null) return { text: `Unknown feature "${rest[0]}". Features: guard, blast, replay, agents, all.` }
      const ms = parseDuration(rest.slice(1).join(' '))
      if (ms === null) return { text: 'Give a duration like 30m, 2h or 90s, or nothing to pause until you resume.' }
      if (f !== 'all' && !enabled[f]) return { text: `${nameOf(f)} is already off in the settings. Turn it on with /code-buddy config ${FEATURES.find(x => x.id === f)?.key === 'stagingGuard' ? 'stagingguard' : f} on.` }
      return { text: await pauseFeature($, f, ms, enabled) }
    }
    case 'resume': {
      const f = rest[0] ? featureOf(rest[0]) : 'all'
      if (f === null) return { text: `Unknown feature "${rest[0]}". Features: guard, blast, replay, agents, all.` }
      return { text: await resumeFeature($, f) }
    }
    default:
      return { text: `Unknown option "${sub}". Try /code-buddy, /code-buddy control, /code-buddy pause, /code-buddy replay, /code-buddy agents or /code-buddy config.` }
  }
}

// ---- Hooks -------------------------------------------------------------------

export const register: Register = (on, options) => {
  const cfg = configOf(options as Record<string, unknown>)
  const acfg = agentsConfigOf(options as Record<string, unknown>)
  const enabled = enabledOf(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isInteractive = e.isInteractive
    if (e.isInteractive || e.surface !== null) await markSeen($)
    version = await readVersion($)
    await $.command.register({
      name: 'code-buddy',
      description: 'Code Buddy: status and held calls; replay, agents or config',
      argumentHint: '[control | pause <feature> [30m] | resume | replay | agents | config]',
    })
    // Running subagents' clocks tick once a second; quiet when none runs.
    $.clock.every(1000, () => {
      void (async () => {
        if (hasDrawn && !isSeenSaved) await markSeen($)
        // Timed pauses end by themselves; the band counts them down.
        const paused = (await $.state.get(PAUSES)).value ?? {}
        if (Object.keys(paused).length > 0) {
          const { pauses, ended } = expire(paused, await $.clock.now())
          if (ended.length > 0) {
            await $.state.set(PAUSES, pauses)
            $.ui.toast(`Code Buddy: ${ended.map(nameOf).join(', ')} resumed (the pause ended).`)
          }
          if (Object.values(paused).some(until => until !== 0)) $.ui.invalidate('ui.render')
        }
        const list = (await $.state.get(AGENTS)).value ?? []
        if (list.some(a => a.status === 'running')) $.ui.invalidate('ui.render')
      })()
    })
    return started
  })

  on('command.run', { command: 'code-buddy' }, async ($, e) => answerBuddy($, e.args, cfg, acfg, enabled))

  // The same command from the plugin's commands/code-buddy.md. That file is
  // there so the desktop's / menu lists Code Buddy before a session starts (it
  // builds that menu with hooks off, when /code-buddy above is never registered);
  // with hooks on, it answers exactly as /code-buddy does and stays out of the menu.
  on('command.run', { command: 'code-buddy:code-buddy' }, async ($, e) => answerBuddy($, e.args, cfg, acfg, enabled))
  on('command.describe', { command: 'code-buddy:code-buddy' }, ($, e, next) => next({ ...e, isHidden: true }))

  // Features 1 and 2: hold a risky call until the person answers.
  // Feature 3: record each file edit that runs, never changing it.
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    if (e.agentId !== undefined) {
      try {
        await noteActivity($, e.agentId, activityOf(input, await $.session.cwd()))
      } catch {
        // showing activity must never stop a call
      }
    }
    const agentId = e.agentId
    const entryId = agentId !== undefined ? await startDetailEntry($, agentId, input) : ''
    const result = await (async () => {
    const found = await inspect($, input, cfg, enabled)
    if (found !== null) {
      const outcome = await hold($, next.signal, String(e.tool), found, e.agentId !== undefined)
      if (outcome !== 'proceeded') {
        $.ui.toast(`Code Buddy: refused (${OUTCOME_LABEL[outcome]})`)
        return { deny: refusal(outcome, found) }
      }
      $.ui.toast('Code Buddy: running it')
    }
    if (!EDIT_TOOLS.has(String(e.tool)) || !(await isActive($, enabled, 'replay'))) return next(e)
    let step: ReplayStep | null = null
    try {
      step = await stepFor($, input)
    } catch {
      // recording must never stop the edit
    }
    const ran = await next(e)
    if (step !== null && ran.deny === undefined && ran.isError !== true) {
      try {
        await recordStep($, step)
      } catch {
        // nor fail it
      }
    }
    return ran
    })()
    if (agentId !== undefined && entryId) await endDetailEntry($, agentId, input, entryId, result)
    return result
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : (enabled.guard && looksRisky(e as unknown as Record<string, unknown>, cfg)) || (enabled.blast && e.tool === 'Bash' && looksDestructive(String(e.command)))
        ? { deny: 'Code Buddy could not finish checking this call, and it looks risky, so it was refused. Do not retry it unless the user asks you to.' }
        : next(e),
  )

  // A window joined the session: holds can be answered from now on, reloads included.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    try {
      await markSeen($)
    } catch {
      // the hold falls back to its own checks
    }
    return attached
  })

  // Feature 4: every subagent, as it starts. Any Agent tool call, no companion skill.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started
    if (!(await isActive($, enabled, 'agents'))) return started
    try {
      const at = await $.clock.now()
      const batch = (await $.state.get(BATCH)).value ?? 0
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        type: e.subagentType || 'general-purpose',
        description: mask(e.description || e.name || ''),
        model: started.model,
        status: 'running',
        startedAt: at,
        tokens: 0,
        costUsd: 0,
        steps: 0,
        batch,
      }
      await writeAgents($, list => [...list.filter(a => a.id !== run.id), run].slice(-200))
      await $.state.set(
        { ...DETAILS, id: run.id },
        newDetail(
          {
            id: run.id,
            prompt: e.prompt,
            name: e.name,
            cwd: e.cwd,
            permissionMode: e.permissionMode,
            background: e.background,
            fork: e.fork,
            model: e.model,
            parentModel: e.parentModel,
            parentAgentId: e.parentAgentId,
            teammateId: started.teammateId,
          },
          at,
        ),
      )
      if (acfg.autoOpen) await maybeAutoOpen($, batch)
    } catch {
      // tracking must never stop a subagent
    }
    return started
  }).catch(($, e, next) => next(e)) // a failed hook still lets the subagent start

  // Each model request of a subagent: its tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId !== undefined && result.usage) {
      try {
        const model = result.usage.model || e.model
        await addUsage($, e.agentId, model, result.usage)
        const usage = result.usage
        const at = await $.clock.now()
        await writeDetail($, e.agentId, d => onStep(d, usage, costParts(model, usage), typeof e.effort === 'string' ? e.effort : undefined, result.answer, at))
        await checkBudget($, acfg.budget)
      } catch {
        // nor slow one down
      }
    }
    return result
  })

  // A new prompt starts a new recording and a new batch of subagents; the replay hint is put away.
  on('turn.start', async ($, e, next) => {
    await $.state.set(BATCH, ((await $.state.get(BATCH)).value ?? 0) + 1)
    await $.state.set(RECORDING, [])
    const r = (await $.state.get(REPLAY)).value
    if (r && !r.isSeen) await $.state.set(REPLAY, { ...r, isSeen: true })
    return next(e)
  })

  // The main turn's end: its edits become the replay (subagents' turns end too, carrying agentId).
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) {
      await finishAgent($, e.agentId, e.reason, e.usage)
      const at = await $.clock.now()
      const agentId = e.agentId
      await writeDetail($, agentId, d => onFinish(d, e.answer, e.reason, at))
      await checkBudget($, acfg.budget)
      return done
    }
    const steps = (await $.state.get(RECORDING)).value ?? []
    if (steps.length > 0) {
      const replay: Replay = { steps, index: 0, isSeen: false }
      await $.state.set(REPLAY, replay)
      await $.state.set(RECORDING, [])
    }
    return done
  })

  on('ui.render', { component: 'Pane', requestId: 'code-buddy-replay' }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const r = (await $.state.get(REPLAY)).value
    if (!r || r.steps.length === 0) return <ui.Text dimColor>No edits to replay yet.</ui.Text>
    return drawReplay(ui, e.surface, r, e.props.bodyColumns, {
      go: index => void goToStep($, index),
      close: () => void $.ui.close({ id: REPLAY_PANE }),
    })
  })

  on('ui.render', { component: 'Pane', requestId: 'code-buddy-agents' }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const list = (await $.state.get(AGENTS)).value ?? []
    const agentsUi = await readUi($)
    const chosen = agentsUi.selected === undefined ? undefined : list.find(a => a.id === agentsUi.selected)
    if (chosen !== undefined) {
      const detail = (await $.state.get({ ...DETAILS, id: chosen.id })).value
      return drawAgentDetail(ui, e.surface, chosen, detail ?? undefined, await $.clock.now(), e.props.bodyColumns, {
        back: () => void selectAgent($, undefined),
        copy: text => void copyText($, text, e.surface),
      })
    }
    const view = { isCompact: agentsUi.isCompact, budget: acfg.budget }
    return drawAgents(ui, e.surface, list, await $.clock.now(), e.props.bodyColumns, view, {
      toggleCompact: () => void toggleCompact($),
      select: id => void selectAgent($, id),
    })
  })

  on('ui.render', { component: 'Pane', requestId: 'code-buddy-control' }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const p = await pausesOf($)
    const now = await $.clock.now()
    const log = (await $.state.get(LOG)).value ?? []
    const view = {
      version,
      held: log.length,
      features: FEATURES.map(f => ({
        id: f.id,
        state: !enabled[f.id] ? ('off' as const) : isPaused(p, f.id, now) ? ('paused' as const) : ('on' as const),
        left: leftText(p, f.id, now),
      })),
      settings: {
        production: cfg.production.join(', '),
        staging: cfg.staging.join(', '),
        branch: cfg.branches.join(', '),
        budget: acfg.budget > 0 ? String(acfg.budget) : 'off',
        autoOpen: acfg.autoOpen,
      },
    }
    return drawControl(ui, e.surface, view, e.props.bodyColumns, {
      pause: (f, ms) => void pauseFeature($, f, ms, enabled),
      resume: f => void resumeFeature($, f),
      setOn: (f, turnOn) => void setFeatureOn($, f, turnOn, options as Record<string, unknown>),
      set: (field, value) => void saveSetting($, field, value),
      setAutoOpen: turnOn => void $.config.set({ key: 'code-buddy.autoOpenAgents', value: turnOn }),
    })
  })

  on('ui.render', { component: 'Pane', requestId: 'code-buddy-hold' }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const queue = (await $.state.get(QUEUE)).value ?? []
    const head = queue[0]
    if (head === undefined) return <ui.Text dimColor>Nothing is held.</ui.Text>
    return drawHold(ui, e.surface, head, queue.length - 1, e.props.bodyColumns)
  })

  // The one band above the prompt. Priority: a waiting hold, then the agents
  // progress bar, then the replay hint, then the idle status.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    hasDrawn = true
    if (e.props.hasSurvey) return next(e)
    const ui = $.ui.resolve(e)
    const queue = (await $.state.get(QUEUE)).value ?? []
    const head = queue[0]
    if (head !== undefined) return drawHoldBand(ui, e.surface, head, queue.length - 1, e.props.bodyColumns)
    const all = (await $.state.get(AGENTS)).value ?? []
    const spend = budgetOf(all, acfg.budget)
    const runs = barRuns(all, (await $.state.get(BATCH)).value ?? 0)
    const agentsOn = await isActive($, enabled, 'agents')
    if (agentsOn && (runs.some(a => a.status === 'running') || (e.props.isWorking && runs.length > 0))) {
      return drawAgentsBand(ui, e.surface, runs, e.props.bodyColumns, spend?.isOver ?? false, () => void toggleAgents($))
    }
    const replay = (await $.state.get(REPLAY)).value
    if (replay && !replay.isSeen && replay.steps.length > 0 && !e.props.isWorking && (await isActive($, enabled, 'replay'))) {
      return drawReplayBand(ui, e.surface, replay, e.props.bodyColumns, () => void openReplay($))
    }
    const log = (await $.state.get(LOG)).value ?? []
    const p = await pausesOf($)
    const now = await $.clock.now()
    const paused = FEATURES.filter(f => enabled[f.id] && isPaused(p, f.id, now)).map(f => `${f.name} · ${leftText(p, f.id, now)}`)
    const holdsOn = (enabled.guard && !isPaused(p, 'guard', now)) || (enabled.blast && !isPaused(p, 'blast', now))
    return drawIdleBand(ui, e.surface, holdsOn, log.length, e.props.bodyColumns, spend?.isOver ? `over budget · ${spend.used}` : '', paused, () => void resumeFeature($, 'all'))
  })
}
