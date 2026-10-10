// Feature 4, agent details: click Details on a subagent to see its task,
// model, timeline, tools, files, commands, token and cost breakdown, latest
// message or final report, and the facts about how it runs.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { newDetail, onFinish, onStep, onToolEnd, onToolStart } from '../hooks/detail'
import { agentRowSvg } from '../hooks/theme'
import { PANE_PROPS, world } from './world'

const run = (args: string) => ({ command: 'code-buddy', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
const FILES = { '/repo/src/api/routes.ts': 'export const routes = []\n' }
const PROMPT = 'Map every API route in src/api.\n\n- list each route\n- note its auth\n\nToken for the staging API: API_TOKEN=abcdefghijklmnop'

function engine(on: On) {
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: `ag-${e.tool_use_id}` }))
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'Found 12 routes so far.',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 20_000, output_tokens: 3_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000, model: e.model },
    }
  })
}

const spawn = ($: Engine, id: string) =>
  $.agent.spawn({
    tool_use_id: id,
    prompt: PROMPT,
    description: 'Map the checkout API routes',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    model: 'opus',
    background: true,
    fork: false,
    permissionMode: 'default',
    cwd: '/repo',
  })

async function step($: Engine, agentId: string): Promise<void> {
  const s = $.turn.step({ turnId: `t-${agentId}`, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, agentId })
  for await (const _ of s) {
    // drain
  }
  await s.result
}

const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)

const pane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'code-buddy', surface, component: 'Pane', requestId: 'code-buddy-agents', props: { ...PANE_PROPS, title: 'Agents' } })

describe('agent details', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`Details shows the task, timeline, files, commands, numbers and final report (${surface})`, async ($, on) => {
      const w = world(on, { files: FILES, failing: ['Write'] })
      engine(on)
      await $.turn.start({ text: 'go', turnId: 'p1' })
      await spawn($, 'tu1')
      await step($, 'ag-tu1')
      await call($, { tool: 'Read', file_path: '/repo/src/api/routes.ts', agentId: 'ag-tu1' })
      await call($, { tool: 'Edit', file_path: '/repo/src/api/routes.ts', old_string: '[]', new_string: '[auth]', agentId: 'ag-tu1' })
      await call($, { tool: 'Bash', command: 'npm test -- routes', agentId: 'ag-tu1' })
      await call($, { tool: 'Write', file_path: '/repo/src/api/new.ts', content: 'x', agentId: 'ag-tu1' })
      await $.command.run(run('agents'))

      const ui = await pane($, surface)
      await ui.press({ key: 'd-ag-tu1' })
      const running = JSON.stringify(await ui.drawn())
      for (const want of ['Map the checkout API routes', 'Now', 'Write · src/api/new.ts', 'Found 12 routes so far.', 'Latest message', 'high effort', 'Opus 5.5']) {
        expect(running.toLowerCase(), want).toContain(want.toLowerCase())
      }

      await $.turn.complete({ answer: '## Routes\n\n12 routes, 3 without auth.', durationMs: 1, isAborted: false, turnId: 't-ag-tu1', reason: 'answer', agentId: 'ag-tu1' })
      const done = JSON.stringify(await ui.drawn())
      for (const want of [
        'Map every API route in src/api.', // the task
        'API_TOKEN=abcdefgh••••••', // masked
        'Final report',
        '## Routes',
        'Timeline',
        'Read',
        'src/api/routes.ts',
        'Files changed · 1',
        'Files read · 1',
        'npm test -- routes',
        'Tools used · 4',
        'Edit 1',
        'Cache reads',
        'Agent ID',
        'ag-tu1',
        'claude-opus-5-5 (asked for opus)',
        'in the background',
        'finished with an answer',
      ]) {
        expect(done.toLowerCase(), want).toContain(want.toLowerCase())
      }
      expect(done).not.toContain('ijklmnop')
      expect(done).not.toContain('src/api/new.ts\\n') // the failed Write changed nothing

      await ui.press({ key: 'copy-report' })
      expect(w.copied).toEqual(['## Routes\n\n12 routes, 3 without auth.'])
      expect(w.toasts).toContain('Code Buddy: copied')

      await ui.press({ key: 'back' })
      expect(JSON.stringify(await ui.drawn())).toContain('Details ›')
    })
  }

  test('a subagent call Code Buddy refuses shows as held; a failed one as an error', async ($, on) => {
    world(on, { surfaces: [], failing: ['Write'] })
    engine(on)
    await $.turn.start({ text: 'go', turnId: 'p1' })
    await spawn($, 'tu1')
    await call($, { tool: 'Bash', command: 'terraform apply', agentId: 'ag-tu1' })
    await call($, { tool: 'Write', file_path: '/repo/a.ts', content: 'x', agentId: 'ag-tu1' })
    await $.command.run(run('agents'))
    const ui = await pane($, 'terminal')
    await ui.press({ key: 'd-ag-tu1' })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('⏸ ')
    expect(drawn).toContain('✗ ')
    expect(drawn).toContain('Errors 1 (1 held)')
  })
})

describe('detail record', () => {
  const facts = { id: 'a', prompt: 'p', background: false, fork: false, parentModel: 'claude-opus-5-5' }
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }

  test('tool calls, steps and the end fold into one record', () => {
    let d = newDetail(facts, 0)
    d = onToolStart(d, { tool: 'Read', file_path: '/repo/a.ts' }, '/repo', 'e1', 1000)
    d = onToolEnd(d, { tool: 'Read', file_path: '/repo/a.ts' }, '/repo', 'e1', 'ok', 1500)
    d = onToolStart(d, { tool: 'Edit', file_path: '/repo/b.ts' }, '/repo', 'e2', 2000)
    d = onToolEnd(d, { tool: 'Edit', file_path: '/repo/b.ts' }, '/repo', 'e2', 'ok', 2500)
    d = onToolStart(d, { tool: 'Bash', command: 'ls\nmore' }, '/repo', 'e3', 3000)
    d = onStep(d, usage, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, 'medium', 'working', 3500)
    d = onFinish(d, 'done', 'answer', 4000)
    expect(d.filesRead).toEqual(['a.ts'])
    expect(d.filesChanged).toEqual(['b.ts'])
    expect(d.commands).toEqual(['ls'])
    expect(d.toolCounts).toEqual({ Read: 1, Edit: 1, Bash: 1 })
    expect(d.timeline.map(t => t.status)).toEqual(['ok', 'ok', 'error']) // still running at the end
    expect(d.usage).toEqual({ input: 10, output: 5, cacheRead: 100, cacheWrite: 20 })
    expect(d.lastContext).toBe(130)
    expect([d.effort, d.lastMessage, d.finalReport, d.endReason]).toEqual(['medium', 'working', 'done', 'answer'])
  })

  test('a narrow row keeps the full model name and title', () => {
    const row = { status: 'running' as const, title: 'Build GCP service accounts', type: 'general-purpose', model: 'Opus 5.5', elapsed: '14:25', tokens: '16.6M tokens', cost: '≈$5.90', activity: 'Bash · terraform plan', progress: 'step 9 · 30 tools' }
    const svg = agentRowSvg(360, row)
    expect(svg).toContain('>Opus 5.5<')
    expect(svg).toContain('>Build GCP service accounts<')
    expect(svg).toContain('16.6M tokens · ≈$5.90')
  })
})
