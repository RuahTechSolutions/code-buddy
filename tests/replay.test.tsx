// Feature 3, Replay: edits are recorded unchanged, the band hints after the
// turn, and the pane steps through them with Prev, Next and Close.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { BAND_PROPS, PANE_PROPS, world } from './world'

const SURFACES = ['terminal', 'desktop'] as const
const FILES = { '/repo/src/app.ts': 'one\ntwo\nthree\n' }
const IDLE_BAND = { ...BAND_PROPS, isWorking: false }
const run = (args: string) => ({ command: 'code-buddy', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

async function turnWithEdits($: Engine): Promise<void> {
  await $.turn.start({ text: 'rename it', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'two', new_string: 'TWO' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/new.ts', content: 'export const x = 1\n' })
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
}

const band = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({ plugin: 'code-buddy', surface, component: 'AbovePrompt', props: IDLE_BAND })

const pane = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({ plugin: 'code-buddy', surface, component: 'Pane', requestId: 'code-buddy-replay', props: { ...PANE_PROPS, title: 'Code Buddy · replay' } })

describe('replay', () => {
  for (const surface of SURFACES) {
    test(`hint, then Prev, Next and Close step through the diffs (${surface})`, async ($, on) => {
      const w = world(on, { files: FILES })
      await turnWithEdits($)

      const b = await band($, surface)
      const hint = JSON.stringify(await b.drawn())
      expect(hint).toContain('Replay ready')
      expect(hint).toContain('2 edits in 2 files')
      await b.press({ key: 'open-replay' })
      expect(w.opened).toEqual(['code-buddy-replay'])

      const ui = await pane($, surface)
      expect((await ui.find({ key: 'next' }))?.props.autoFocus).toBe(true)
      expect(JSON.stringify(await ui.drawn())).toContain('step 1 of 2')
      const first = await ui.find({ type: 'Code' })
      expect(first?.props.format).toBe('diff')
      expect(String(first?.props.source).split('\n')).toEqual(['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three'])

      await ui.press({ key: 'next' })
      expect(JSON.stringify(await ui.drawn())).toContain('step 2 of 2')
      expect(String((await ui.find({ type: 'Code' }))?.props.source)).toContain('--- /dev/null')
      await ui.press({ key: 'next' }) // stays on the last step
      expect(JSON.stringify(await ui.drawn())).toContain('step 2 of 2')
      await ui.press({ key: 'prev' })
      expect(JSON.stringify(await ui.drawn())).toContain('step 1 of 2')
      await ui.press({ key: 'close' })
      expect(w.closed).toEqual(['code-buddy-replay'])

      // Opened once: the band goes back to its idle line.
      expect(JSON.stringify(await (await band($, surface)).drawn())).not.toContain('Replay ready')
    })
  }

  test('edits reach the tool unchanged', async ($, on) => {
    const w = world(on, { files: FILES })
    const input = { tool: 'Edit' as const, file_path: '/repo/src/app.ts', old_string: 'two', new_string: 'TWO', replace_all: false }
    await $.tool.call(input)
    expect(w.inputs[0]).toMatchObject(input)
  })

  test('failed edits and subagent turn ends do not make a replay', async ($, on) => {
    world(on, { files: FILES, failing: ['Write'] })
    await $.turn.start({ text: 'x', turnId: 't1' })
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.ts', content: 'a\n' })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    const none = await $.command.run(run('replay'))
    expect(none.text).toContain('no edits recorded yet')

    await $.turn.start({ text: 'y', turnId: 't2' })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'one', new_string: '1' })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub', reason: 'answer', agentId: 'agent-1' })
    expect((await $.command.run(run('replay'))).text).toContain('no edits recorded yet')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    expect((await $.command.run(run('replay'))).text).toContain('1 edit from the last turn')
  })

  test('/code-buddy replay opens the pane', async ($, on) => {
    const w = world(on, { files: FILES })
    await turnWithEdits($)
    const out = await $.command.run(run('replay'))
    expect(out.text).toContain('2 edits from the last turn')
    expect(w.opened).toEqual(['code-buddy-replay'])
  })

  test('a waiting hold outranks the replay hint in the band', async ($, on) => {
    const w = world(on, { files: FILES })
    await turnWithEdits($)
    const call = $.tool.call({ tool: 'Bash', command: 'terraform apply' })
    for (let i = 0; i < 100 && w.opened.length === 0; i += 1) {
      w.tick()
      await $.tool.call({ tool: 'Read', file_path: '/x' })
    }
    const drawn = JSON.stringify(await (await band($, 'terminal')).drawn())
    expect(drawn).toContain('HELD')
    expect(drawn).not.toContain('Replay ready')
    const ui = await $.ui.mount({ plugin: 'code-buddy', surface: 'terminal', component: 'Pane', requestId: 'code-buddy-hold', props: PANE_PROPS })
    await ui.press({ key: 'cancel' })
    for (let i = 0; i < 100; i += 1) {
      w.tick()
      await $.tool.call({ tool: 'Read', file_path: '/x' })
    }
    expect((await call).deny).toContain('Cancel')
  })
})
