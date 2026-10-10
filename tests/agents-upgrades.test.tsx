// Feature 4 upgrades: a bigger panel with a compact view, auto-open on the
// second subagent of a turn, live activity per subagent, and a cost budget.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { activityOf, parseBudget } from '../hooks/agents'
import { BAND_PROPS, PANE_PROPS, world } from './world'

const WORKING = { ...BAND_PROPS, isWorking: true }
const IDLE = { ...BAND_PROPS, isWorking: false }
const run = (args: string) => ({ command: 'code-buddy', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
const NONE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** The engine beneath: starts subagents and answers their model requests. */
function engine(on: On, usage: Record<string, typeof NONE> = {}) {
  on('agent.spawn', ($, e) => ({ model: 'claude-sonnet-5-5', agentId: `ag-${e.tool_use_id}` }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { ...(usage[e.agentId ?? ''] ?? NONE), model: e.model } }
  })
}

const spawn = ($: Engine, id: string, description = `task ${id}`) =>
  $.agent.spawn({ tool_use_id: id, prompt: 'do the work', description, subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false })

async function step($: Engine, agentId: string): Promise<void> {
  const s = $.turn.step({ turnId: `t-${agentId}`, index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId })
  for await (const _ of s) {
    // drain
  }
  await s.result
}

const finish = ($: Engine, agentId: string) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: `t-${agentId}`, reason: 'answer', agentId })
const prompt = ($: Engine, turnId: string) => $.turn.start({ text: 'go', turnId })
const endPrompt = ($: Engine, turnId: string) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' })

const pane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'code-buddy', surface, component: 'Pane', requestId: 'code-buddy-agents', props: { ...PANE_PROPS, title: 'Agents' } })
const band = ($: Engine, props = WORKING) => $.ui.mount({ plugin: 'code-buddy', surface: 'terminal', component: 'AbovePrompt', props })

describe('1. bigger panel and compact view', () => {
  test('the panel asks for a wide dock and rows for its subagents', async ($, on) => {
    const w = world(on)
    engine(on)
    await prompt($, 'p1')
    await spawn($, 'a')
    await $.command.run(run('agents'))
    expect(w.openArgs[0]).toMatchObject({ id: 'code-buddy-agents', title: 'Agents', columns: 76 })
    expect(Number(w.openArgs[0]?.rows)).toBeGreaterThanOrEqual(12)
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`Compact shows one line per subagent, Expand brings the rows back (${surface})`, async ($, on) => {
      world(on)
      engine(on)
      await prompt($, 'p1')
      await spawn($, 'a', 'Map the routes')
      const ui = await pane($, surface)
      expect((await ui.find({ key: 'compact' }))?.props.label).toBe('Compact')
      const full = JSON.stringify(await ui.drawn())
      expect(full).toContain('0 tokens ·') // the full row's stats line
      await ui.press({ key: 'compact' })
      expect((await ui.find({ key: 'compact' }))?.props.label).toBe('Expand')
      const compact = JSON.stringify(await ui.drawn())
      expect(compact).toContain('Map the routes')
      expect(compact).not.toContain('0 tokens ·')
      await ui.press({ key: 'compact' })
      expect(JSON.stringify(await ui.drawn())).toContain('0 tokens ·')
    })
  }
})

describe('2. auto-open', () => {
  test('opens when the second subagent of a turn starts, once per turn', async ($, on) => {
    const w = world(on)
    engine(on)
    await prompt($, 'p1')
    await spawn($, 'a')
    expect(w.opened).toEqual([])
    await spawn($, 'b')
    expect(w.opened).toEqual(['code-buddy-agents'])
    await $.command.run(run('agents')) // the person closes it
    await spawn($, 'c')
    expect(w.opened).toEqual(['code-buddy-agents'])
    await endPrompt($, 'p1')

    await prompt($, 'p2')
    await spawn($, 'd')
    await spawn($, 'e')
    expect(w.opened).toEqual(['code-buddy-agents', 'code-buddy-agents'])
  })

  test('can be turned off', { options: { autoOpenAgents: false } }, async ($, on) => {
    const w = world(on)
    engine(on)
    await prompt($, 'p1')
    await spawn($, 'a')
    await spawn($, 'b')
    expect(w.opened).toEqual([])
  })
})

describe('3. live activity', () => {
  test('a running subagent shows its current tool and counts; a finished one does not', async ($, on) => {
    world(on)
    engine(on)
    await prompt($, 'p1')
    await spawn($, 'a')
    await step($, 'ag-a')
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/api/routes.ts', agentId: 'ag-a' } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await pane($, surface)
      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn).toContain('Read · src/api/routes.ts')
      expect(drawn).toContain('step 1 · 1 tool')
      await ui.unmount()
    }
    await finish($, 'ag-a')
    expect(JSON.stringify(await (await pane($, 'terminal')).drawn())).not.toContain('routes.ts')
  })

  test('activity reads well and is masked', () => {
    expect(activityOf({ tool: 'Bash', command: 'npm test -- --watch=false\nmore' }, '/repo')).toBe('Bash · npm test -- --watch=false')
    expect(activityOf({ tool: 'Grep', pattern: 'route', path: '/repo/src' }, '/repo')).toBe('Grep · route in src')
    expect(activityOf({ tool: 'mcp__docs__search', query: 'auth' }, '/repo')).toBe('search · auth')
    expect(activityOf({ tool: 'Bash', command: `curl -H "Authorization: Bearer abcdefghijklmnop" x` }, '/repo')).toContain('Bearer abcdefgh••••••')
  })
})

describe('4. cost budget', () => {
  const USAGE = { 'ag-a': { input_tokens: 100_000, output_tokens: 10_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } // ≈ $0.30 on Sonnet 5.5

  test('passing it raises one toast and turns the bar and band coral', { options: { agentBudgetUsd: 0.25 } }, async ($, on) => {
    const w = world(on)
    engine(on, USAGE)
    await prompt($, 'p1')
    await spawn($, 'a')
    await step($, 'ag-a')
    await step($, 'ag-a')
    expect(w.toasts.filter(t => t.includes('over your $0.25 budget'))).toHaveLength(1)
    expect(JSON.stringify(await (await band($)).drawn())).toContain('over budget')
    const drawn = JSON.stringify(await (await pane($, 'terminal')).drawn())
    expect(drawn).toContain(' over $0.25 ')

    await finish($, 'ag-a')
    await endPrompt($, 'p1')
    expect(JSON.stringify(await (await band($, IDLE)).drawn())).toContain('over budget · ≈$0.60')
  })

  test('under budget: a share of it, no toast', { options: { agentBudgetUsd: 5 } }, async ($, on) => {
    const w = world(on)
    engine(on, USAGE)
    await prompt($, 'p1')
    await spawn($, 'a')
    await step($, 'ag-a')
    expect(w.toasts).toEqual([])
    expect(JSON.stringify(await (await pane($, 'terminal')).drawn())).toContain('6% of $5.00')
  })

  test('/code-buddy config budget takes dollars or off', async ($, on) => {
    world(on)
    engine(on)
    const set: unknown[] = []
    on('config.set', ($, e) => {
      set.push([e.key, e.value])
      return { value: e.value }
    })
    expect((await $.command.run(run('config budget $2.50'))).text).toContain('Subagent budget set to $2.50')
    expect((await $.command.run(run('config budget off'))).text).toContain('set to off')
    expect((await $.command.run(run('config budget lots'))).text).toContain('Budget takes an amount in dollars')
    expect((await $.command.run(run('config autoopen off'))).text).toContain('Auto-open agents panel set to off')
    expect(set).toEqual([
      ['code-buddy.agentBudgetUsd', 2.5],
      ['code-buddy.agentBudgetUsd', 0],
      ['code-buddy.autoOpenAgents', false],
    ])
    expect(parseBudget('3')).toBe(3)
    expect(parseBudget('-1')).toBeNull()
  })
})
