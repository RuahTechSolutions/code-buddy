// Feature 5, the control panel: pause, resume or switch off each feature, and
// change the settings from one pane.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { durText, enabledOf, expire, featureOf, isPaused, leftText, parseDuration } from '../hooks/features'
import { BAND_PROPS, PANE_PROPS, world } from './world'

const run = (args: string) => ({ command: 'code-buddy', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
const IDLE = { ...BAND_PROPS, isWorking: false }
const control = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'code-buddy', surface, component: 'Pane', requestId: 'code-buddy-control', props: { ...PANE_PROPS, title: 'Code Buddy' } })

describe('pause words and times', () => {
  test('features, durations and what is left', () => {
    expect([featureOf('blast'), featureOf('Blast-Radius'), featureOf('staging'), featureOf('agents'), featureOf('all'), featureOf('nope')]).toEqual(['blast', 'blast', 'guard', 'agents', 'all', null])
    expect([parseDuration('30m'), parseDuration('2h'), parseDuration('90s'), parseDuration('45'), parseDuration(''), parseDuration('soon')]).toEqual([1_800_000, 7_200_000, 90_000, 2_700_000, 0, null])
    const p = { blast: 1_000 + 28 * 60_000, replay: 0 }
    expect([isPaused(p, 'blast', 1_000), isPaused(p, 'replay', 9e12), isPaused(p, 'guard', 1_000)]).toEqual([true, true, false])
    expect([leftText(p, 'blast', 1_000), leftText(p, 'replay', 1_000)]).toEqual(['28m left', 'until resumed'])
    expect(expire(p, 1e12)).toEqual({ pauses: { replay: 0 }, ended: ['blast'] })
    expect([durText(1_800_000), durText(5_400_000), durText(45_000)]).toEqual(['30 min', '1 h 30 min', '45 s'])
  })

  test('the older guard switch turns both hold features off', () => {
    expect(enabledOf({})).toEqual({ guard: true, blast: true, replay: true, agents: true })
    expect(enabledOf({ guard: false })).toEqual({ guard: false, blast: false, replay: true, agents: true })
    expect(enabledOf({ blastRadius: false, agentsPanel: false })).toEqual({ guard: true, blast: false, replay: true, agents: false })
  })
})

describe('pausing', () => {
  test('pause blast 30m: destructive commands run unheld, the staging guard still holds, and the pause ends', async ($, on) => {
    let t = 1_000
    const w = world(on, { surfaces: [], now: () => t, run: argv => (argv[0] === 'env' ? { exitCode: 0, stdout: '1 10 1\nbuild/a\n' } : undefined) })
    expect((await $.command.run(run('pause blast 30m'))).text).toContain('Blast radius paused for 30 min')

    expect((await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })).deny).toBeUndefined()
    expect(w.ran).toEqual(['Bash'])
    expect((await $.tool.call({ tool: 'Bash', command: 'terraform apply' })).deny).toContain('deploy: terraform apply')

    t += 31 * 60_000 // the pause is over
    expect((await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })).deny).toContain('destructive: rm -rf')
  })

  test('resume brings it back; resume with nothing paused says so', async ($, on) => {
    world(on, { surfaces: [] })
    await $.command.run(run('pause blast'))
    expect((await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })).deny).toBeUndefined()
    expect((await $.command.run(run('resume'))).text).toContain('Blast radius resumed')
    expect((await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })).deny).toContain('destructive: git reset --hard')
    expect((await $.command.run(run('resume'))).text).toContain('nothing was paused')
    expect((await $.command.run(run('pause nope'))).text).toContain('Unknown feature')
    expect((await $.command.run(run('pause blast soon'))).text).toContain('Give a duration')
  })

  test('paused replay records nothing; paused agents track nothing', async ($, on) => {
    world(on, { files: { '/repo/a.ts': 'x\n' } })
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'ag-1' }))
    await $.command.run(run('pause replay'))
    await $.command.run(run('pause agents'))
    await $.turn.start({ text: 'go', turnId: 'p1' })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' })
    await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'd', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'p1', reason: 'answer' })
    expect((await $.command.run(run('replay'))).text).toContain('no edits recorded yet')
    expect((await $.command.run(run('agents'))).text).toContain('0 subagents')
  })

  test('the idle band shows what is paused, and Resume resumes it', async ($, on) => {
    world(on)
    await $.command.run(run('pause blast 30m'))
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ plugin: 'code-buddy', surface, component: 'AbovePrompt', props: IDLE })
      expect(JSON.stringify(await band.drawn())).toContain('Blast radius · 30m left')
      await band.unmount()
    }
    const band = await $.ui.mount({ plugin: 'code-buddy', surface: 'terminal', component: 'AbovePrompt', props: IDLE })
    await band.press({ key: 'resume-all' })
    expect(JSON.stringify(await band.drawn())).not.toContain('Blast radius ·')
  })

  test('off in the settings: not held, and status says so', { options: { blastRadius: false } }, async ($, on) => {
    world(on, { surfaces: [] })
    expect((await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })).deny).toBeUndefined()
    expect((await $.command.run(run(''))).text).toContain('Blast radius off')
    expect((await $.command.run(run('pause blast'))).text).toContain('already off in the settings')
  })
})

describe('control panel', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`opens from /code-buddy control and pauses, resumes and switches features (${surface})`, async ($, on) => {
      const w = world(on)
      const set: unknown[] = []
      on('config.set', ($, e) => {
        set.push([e.key, e.value])
        return { value: e.value }
      })
      expect((await $.command.run(run('control'))).text).toContain('control panel opened')
      expect(w.opened).toEqual(['code-buddy-control'])

      const ui = await control($, surface)
      expect(JSON.stringify(await ui.drawn())).toContain('4 of 4 features on')
      await ui.press({ key: 'pause30-blast' })
      expect(JSON.stringify(await ui.drawn())).toContain('30m left')
      await ui.press({ key: 'resume-blast' })
      expect(JSON.stringify(await ui.drawn())).toContain('4 of 4 features on')

      await ui.press({ key: 'off-replay' })
      await ui.input({ key: 'in-production', text: 'Example.com,  *.example.com' })
      await ui.input({ key: 'in-budget', text: '$3' })
      await ui.input({ key: 'in-budget', text: 'lots' })
      await ui.input({ key: 'in-branch', text: '' })
      await ui.press({ key: 'autoopen-toggle' })
      expect(set).toEqual([
        ['code-buddy.replay', false],
        ['code-buddy.productionDomains', 'example.com, *.example.com'],
        ['code-buddy.agentBudgetUsd', 3],
        ['code-buddy.autoOpenAgents', false],
      ])
      expect(w.toasts.some(t => t.includes('budget takes an amount'))).toBe(true)
      expect(w.toasts.some(t => t.includes("can't be empty"))).toBe(true)
    })
  }

  test('turning a hold feature on also turns the master switch back on', { options: { guard: false } }, async ($, on) => {
    world(on)
    const set: unknown[] = []
    on('config.set', ($, e) => {
      set.push([e.key, e.value])
      return { value: e.value }
    })
    const ui = await control($, 'terminal')
    expect(JSON.stringify(await ui.drawn())).toContain('2 of 4 features on')
    await ui.press({ key: 'on-blast' })
    expect(set).toEqual([
      ['code-buddy.guard', true],
      ['code-buddy.blastRadius', true],
    ])
  })
})
