// The shared hold pane and band: Proceed, Cancel (focused), the queue, the
// 10-minute limit, non-interactive runs, and /code-buddy.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { BAND_PROPS, OPTS, PANE_PROPS, world } from './world'
import type { World } from './world'

const SURFACES = ['terminal', 'desktop'] as const
const run = (args: string) => ({ command: 'code-buddy', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
const PROD = 'curl -X POST https://api.example.com/orders -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"'

/** Lets the plugin's hooks run, its polls answered, until `cond` holds. */
async function until($: Engine, w: World, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i += 1) {
    w.tick()
    await $.tool.call({ tool: 'Read', file_path: '/repo/README.md' })
  }
  expect(cond(), 'waited for the plugin').toBe(true)
}

/** The call's result, once the plugin's hold loop has seen the answer. */
async function settle<T>($: Engine, w: World, call: Promise<T>): Promise<T> {
  let done = false
  void call.then(() => (done = true))
  await until($, w, () => done)
  return call
}

const pane = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({ plugin: 'code-buddy', surface, component: 'Pane', requestId: 'code-buddy-hold', props: PANE_PROPS })

const band = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({ plugin: 'code-buddy', surface, component: 'AbovePrompt', props: BAND_PROPS })

describe('hold pane', () => {
  for (const surface of SURFACES) {
    test(`Cancel has the focus and refuses the call (${surface})`, { options: OPTS }, async ($, on) => {
      const w = world(on)
      const call = $.tool.call({ tool: 'Bash', command: PROD })
      await until($, w, () => w.opened.length > 0)
      const ui = await pane($, surface)
      expect((await ui.find({ key: 'cancel' }))?.props.autoFocus).toBe(true)
      expect((await ui.find({ key: 'proceed' }))?.props.autoFocus).toBeUndefined()
      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn).toContain('production domain: api.example.com')
      expect(drawn).toContain(surface === 'desktop' ? '#012D96' : '#0745A4') // the logo blues
      expect(drawn).toContain('Bearer abcdefgh••••••')
      expect(drawn).not.toContain('ijklmnop')
      await ui.press({ key: 'cancel' })
      const result = await settle($, w, call)
      expect(result.deny).toContain('the user pressed Cancel')
      expect(w.ran).toEqual([])
      expect(w.closed).toContain('code-buddy-hold')
    })

    test(`Proceed runs the call (${surface})`, { options: OPTS }, async ($, on) => {
      const w = world(on)
      const call = $.tool.call({ tool: 'Bash', command: 'vercel --prod' })
      await until($, w, () => w.opened.length > 0)
      const ui = await pane($, surface)
      await ui.press({ key: 'proceed' })
      const result = await settle($, w, call)
      expect(result.deny).toBeUndefined()
      expect(w.ran).toEqual(['Bash'])
    })
  }

  for (const surface of SURFACES) {
    test(`a destructive command shows its blast radius (${surface})`, { options: OPTS }, async ($, on) => {
      const w = world(on, { run: argv => (argv[0] === 'env' ? { exitCode: 0, stdout: '2 8192 1\nbuild/a.js\nbuild/b.js\n' } : undefined) })
      const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
      await until($, w, () => w.opened.length > 0)
      const ui = await pane($, surface)
      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn).toContain('blast radius')
      expect(drawn).toContain('destructive: rm -rf')
      expect(drawn).toContain('delete 2 files (about 8.0 KB)')
      expect(drawn).toContain('build/a.js')
      expect((await ui.find({ key: 'cancel' }))?.props.autoFocus).toBe(true)
      await ui.press({ key: 'cancel' })
      expect((await settle($, w, call)).deny).toContain('destructive: rm -rf')
      expect(w.ran).toEqual([])
    })
  }

  test('ordinary calls are never held', { options: OPTS }, async ($, on) => {
    const w = world(on)
    const result = await $.tool.call({ tool: 'Bash', command: 'ls -la && git status' })
    expect(result.deny).toBeUndefined()
    expect(w.opened).toEqual([])
  })

  test('refused after 10 minutes without an answer', { options: OPTS }, async ($, on) => {
    let t = 0
    const w = world(on, { now: () => (t += 61_000), instantSleep: true })
    const result = await $.tool.call({ tool: 'Bash', command: 'kubectl apply -f k8s/' })
    expect(result.deny).toContain('nobody answered within 10 minutes')
    expect(w.ran).toEqual([])
  })

  test('refused at once in a non-interactive run', { options: OPTS }, async ($, on) => {
    const w = world(on, { surfaces: [] })
    const result = await $.tool.call({ tool: 'Bash', command: 'terraform apply' })
    expect(result.deny).toContain('non-interactive')
    expect(w.opened).toEqual([])
  })

  test('a desktop window that is only detached still gets to answer', async ($, on) => {
    const w = world(on, { surfaces: [] })
    await band($, 'desktop') // the window drew Code Buddy earlier in the session
    const call = $.tool.call({ tool: 'Bash', command: 'terraform apply' })
    await until($, w, () => w.opened.length > 0)
    const ui = await pane($, 'desktop')
    await ui.press({ key: 'cancel' })
    expect((await settle($, w, call)).deny).toContain('the user pressed Cancel')
  })

  test('a window attached earlier still gets to answer after a reload, with none attached now', async ($, on) => {
    const w = world(on, { surfaces: [] })
    await $.session.attach({ surface: 'desktop', clientId: 'window-1' }) // remembered in session state
    const call = $.tool.call({ tool: 'Bash', command: 'terraform apply' })
    await until($, w, () => w.opened.length > 0)
    const ui = await pane($, 'desktop')
    await ui.press({ key: 'cancel' })
    expect((await settle($, w, call)).deny).toContain('the user pressed Cancel')
  })

  test('holds queue: one shows at a time', { options: OPTS }, async ($, on) => {
    const w = world(on)
    const first = $.tool.call({ tool: 'Bash', command: 'docker push ghcr.io/acme/api:1' })
    await until($, w, () => w.opened.length === 1)
    const second = $.tool.call({ tool: 'WebFetch', url: 'https://example.com/admin', prompt: 'read it' })
    for (let i = 0; i < 20; i += 1) {
      w.tick()
      await $.tool.call({ tool: 'Read', file_path: '/repo/README.md' })
    }
    expect(w.opened).toHaveLength(1)

    const b = await band($, 'desktop')
    expect(JSON.stringify(await b.drawn())).toContain('Held +1')
    await b.press({ key: 'band-cancel' })
    expect((await settle($, w, first)).deny).toContain('Cancel')

    await until($, w, () => w.opened.length === 2)
    const ui = await pane($, 'desktop')
    expect(JSON.stringify(await ui.drawn())).toContain('production domain: example.com')
    await ui.press({ key: 'proceed' })
    expect((await settle($, w, second)).deny).toBeUndefined()
    expect(w.ran).toEqual(['WebFetch'])
  })
})

describe('band', () => {
  test('idle: guard on and the count held', { options: OPTS }, async ($, on) => {
    world(on)
    for (const surface of SURFACES) {
      const b = await band($, surface)
      const drawn = JSON.stringify(await b.drawn())
      expect(drawn).toContain('Guard on'.slice(surface === 'desktop' ? 0 : 6))
      expect(drawn).toContain('0 held')
    }
  })

  test('guard off lets everything through', { options: { guard: false } }, async ($, on) => {
    const w = world(on)
    const result = await $.tool.call({ tool: 'Bash', command: 'vercel --prod' })
    expect(result.deny).toBeUndefined()
    const b = await band($, 'terminal')
    expect(JSON.stringify(await b.drawn())).toContain('guard off')
    expect(w.opened).toEqual([])
  })
})

describe('/code-buddy', () => {
  test('status lists this session held calls, masked', { options: OPTS }, async ($, on) => {
    world(on, { surfaces: [] })
    await $.tool.call({ tool: 'Bash', command: `curl https://example.com -u ${'sk_live_'}abcdefghijklmnop:` })
    const out = await $.command.run(run(''))
    expect(out.text).toContain('1 held this session')
    expect(out.text).toContain('refused: non-interactive')
    expect(out.text).toContain('sk_live_••••••')
    expect(out.text).not.toContain('abcdefghijklmnop')
  })

  test('config shows settings and changes one', { options: OPTS }, async ($, on) => {
    world(on)
    const set: unknown[] = []
    on('config.set', ($, e) => {
      set.push([e.key, e.value])
      return { value: e.value }
    })
    const shown = await $.command.run(run('config'))
    expect(shown.text).toContain('production  example.com, *.example.com, example.net, *.example.net')
    expect(shown.text).toContain('branch      main')
    const changed = await $.command.run(run('config branch release'))
    expect(changed.text).toContain('Protected branch set to release')
    expect(set).toEqual([['code-buddy.protectedBranch', 'release']])
  })
})
