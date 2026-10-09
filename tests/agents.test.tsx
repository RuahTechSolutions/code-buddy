// Feature 4, Agents panel: ordinary subagents are tracked from their start,
// their model requests and their end; the band shows finished of total; the
// panel lists them with model, status, elapsed time, tokens and cost.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { costOf, fmtTime, modelName } from '../hooks/agents'
import { BAND_PROPS, PANE_PROPS, world } from './world'

const SURFACES = ['terminal', 'desktop'] as const
const WORKING = { ...BAND_PROPS, isWorking: true }
const IDLE = { ...BAND_PROPS, isWorking: false }
const cents = (usd: number) => Math.round(usd * 100)
const run = (args: string) => ({ command: 'code-buddy', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** The engine beneath: starts subagents and answers their model requests. */
function engine(on: On, models: Record<string, string>, usage: Record<string, Usage> = {}) {
  on('agent.spawn', ($, e) => ({ model: models[e.description] ?? 'claude-opus-5-5', agentId: `ag-${e.tool_use_id}` }))
  on('turn.step', async function* ($, e) {
    const u = usage[e.agentId ?? ''] ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { ...u, model: e.model } }
  })
}

const spawn = ($: Engine, id: string, description: string, subagentType = 'general-purpose') =>
  $.agent.spawn({ tool_use_id: id, prompt: 'do the work', description, subagentType, provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false })

async function step($: Engine, agentId: string, model: string): Promise<void> {
  const s = $.turn.step({ turnId: `t-${agentId}`, index: 0, model, messageCount: 1, agentId })
  for await (const _ of s) {
    // drain
  }
  await s.result
}

const finish = ($: Engine, agentId: string, reason: 'answer' | 'aborted' | 'error' = 'answer') =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: `t-${agentId}`, reason, agentId })

const prompt = ($: Engine, turnId: string) => $.turn.start({ text: 'go', turnId })
const endPrompt = ($: Engine, turnId: string) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' })

const band = ($: Engine, surface: (typeof SURFACES)[number], props = WORKING) =>
  $.ui.mount({ plugin: 'code-buddy', surface, component: 'AbovePrompt', props })

const pane = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({ plugin: 'code-buddy', surface, component: 'Pane', requestId: 'code-buddy-agents', props: { ...PANE_PROPS, title: 'Agents' } })

describe('pricing', () => {
  test('list prices per million tokens, cache writes at 1.25 × input', () => {
    const u = (i: number, o: number, r = 0, w = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: w })
    expect(cents(costOf('claude-opus-5-5', u(1e6, 1e6)))).toBe(cents(24))
    expect(cents(costOf('claude-sonnet-5-5', u(1e6, 0, 1e6, 1e6)))).toBe(cents(2 + 0.2 + 2.5))
    expect(cents(costOf('claude-fable-5-1', u(0, 0, 1e6)))).toBe(cents(0.25))
    expect(cents(costOf('claude-haiku-4-5', u(1e6, 0)))).toBe(cents(1))
    expect(cents(costOf('claude-sonnet-4-6', u(1e6, 0)))).toBe(cents(3))
  })

  test('model names and times read well', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('claude-haiku-4-5')).toBe('Haiku 4.5')
    expect(modelName('claude-fable-5-1[1m]')).toBe('Fable 5.1')
    expect(fmtTime(61_000)).toBe('1:01')
    expect(fmtTime(3_725_000)).toBe('1:02:05')
  })
})

describe('agents', () => {
  for (const surface of SURFACES) {
    test(`an ordinary subagent is tracked start to finish (${surface})`, async ($, on) => {
      let t = 0
      const w = world(on, { now: () => t })
      engine(on, { 'Find the API routes': 'claude-sonnet-5-5' }, { 'ag-tu1': { input_tokens: 100_000, output_tokens: 10_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
      await prompt($, 'p1')
      t = 1_000
      await spawn($, 'tu1', 'Find the API routes', 'Explore')

      const running = JSON.stringify(await (await band($, surface)).drawn())
      expect(running).toContain('0 / 1 finished'.replace(' / ', surface === 'desktop' ? ' / ' : '/'))

      await step($, 'ag-tu1', 'claude-sonnet-5-5')
      t = 62_000
      await finish($, 'ag-tu1')

      const out = await $.command.run(run('agents'))
      expect(out.text).toContain('opened (1 subagent this session)')
      expect(w.opened).toContain('code-buddy-agents')

      const drawn = JSON.stringify(await (await pane($, surface)).drawn())
      expect(drawn).toContain('1 of 1 finished')
      expect(drawn).toContain('Find the API routes')
      expect(drawn).toContain('Explore')
      expect(drawn).toContain('Sonnet 5.5')
      expect(drawn).toContain('1:01')
      expect(drawn).toContain('110k tokens')
      expect(drawn).toContain('≈$0.30')

      // all finished and the prompt over: the band steps aside
      await endPrompt($, 'p1')
      expect(JSON.stringify(await (await band($, surface, IDLE)).drawn())).not.toContain('finished')
    })
  }

  test('the bar counts this prompt’s subagents, plus any still running', async ($, on) => {
    world(on)
    engine(on, {})
    await prompt($, 'p1')
    await spawn($, 'a', 'old one')
    await finish($, 'ag-a')
    await spawn($, 'b', 'still going from before')
    await endPrompt($, 'p1')

    await prompt($, 'p2')
    await spawn($, 'c', 'new one')
    await spawn($, 'd', 'another new one')
    await finish($, 'ag-c')
    expect(JSON.stringify(await (await band($, 'terminal')).drawn())).toContain('1/3 finished')
  })

  test('failed and stopped subagents are shown as such', async ($, on) => {
    world(on)
    engine(on, {})
    await prompt($, 'p1')
    await spawn($, 'x', 'breaks')
    await spawn($, 'y', 'interrupted')
    await finish($, 'ag-x', 'error')
    await finish($, 'ag-y', 'aborted')
    const drawn = JSON.stringify(await (await pane($, 'terminal')).drawn())
    expect(drawn).toContain('✗ ')
    expect(drawn).toContain('■ ')
    expect(drawn).toContain('2 of 2 finished')
  })

  test('/code-buddy agents toggles the panel; the band button does too', async ($, on) => {
    const w = world(on)
    engine(on, {})
    expect((await $.command.run(run('agents'))).text).toContain('opened (0 subagents')
    expect((await $.command.run(run('agents'))).text).toContain('closed')
    expect(w.closed).toEqual(['code-buddy-agents'])

    await prompt($, 'p1')
    await spawn($, 'a', 'work')
    const b = await band($, 'desktop')
    await b.press({ key: 'toggle-agents' })
    expect(w.opened).toEqual(['code-buddy-agents', 'code-buddy-agents'])
  })

  test('descriptions are masked', async ($, on) => {
    world(on)
    engine(on, {})
    await prompt($, 'p1')
    await spawn($, 'a', `rotate ${'sk_live_'}abcdefghijklmnop`)
    const drawn = JSON.stringify(await (await pane($, 'desktop')).drawn())
    expect(drawn).toContain('sk_live_••••••')
    expect(drawn).not.toContain('ijklmnop')
  })

  test('band priority: a hold, then the agents bar, then the replay hint', async ($, on) => {
    const w = world(on, { files: { '/repo/a.ts': 'x\n' } })
    engine(on, {})
    await prompt($, 'p1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' })
    await endPrompt($, 'p1')
    expect(JSON.stringify(await (await band($, 'terminal', IDLE)).drawn())).toContain('Replay ready')

    await spawn($, 'bg', 'background work') // still running after the prompt ended
    const withAgents = JSON.stringify(await (await band($, 'terminal', IDLE)).drawn())
    expect(withAgents).toContain('Agents')
    expect(withAgents).not.toContain('Replay ready')

    const call = $.tool.call({ tool: 'Bash', command: 'docker push ghcr.io/x/y:1' })
    for (let i = 0; i < 100 && w.opened.length === 0; i += 1) {
      w.tick()
      await $.tool.call({ tool: 'Read', file_path: '/x' })
    }
    expect(JSON.stringify(await (await band($, 'terminal', IDLE)).drawn())).toContain('HELD')
    const hold = await $.ui.mount({ plugin: 'code-buddy', surface: 'terminal', component: 'Pane', requestId: 'code-buddy-hold', props: PANE_PROPS })
    await hold.press({ key: 'cancel' })
    for (let i = 0; i < 100; i += 1) {
      w.tick()
      await $.tool.call({ tool: 'Read', file_path: '/x' })
    }
    expect((await call).deny).toContain('Cancel')
  })
})
