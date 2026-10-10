// Test helpers: answers every engine call Code Buddy makes, from memory.

import type { On, RenderSurface } from 'claude-code'

export type GitAnswer = { exitCode: number; stdout: string }

export type WorldOptions = {
  surfaces?: RenderSurface[]
  /** Answers each non-sleep command by argv. */
  run?: (argv: readonly string[]) => GitAnswer | undefined
  /** The time `$.clock.now()` reads, asked each call. */
  now?: () => number
  /** Answer each poll's sleep at once instead of when the test ticks. */
  instantSleep?: boolean
  /** Files the plugin can read, by absolute path. */
  files?: Record<string, string>
  /** Tools whose calls come back as errors. */
  failing?: string[]
}

export type World = {
  opened: string[]
  /** Each $.ui.open's arguments, in order. */
  openArgs: Record<string, unknown>[]
  closed: string[]
  toasts: string[]
  /** Texts put on the clipboard. */
  copied: string[]
  ran: string[]
  /** What each tool that ran was handed, after every plugin hook. */
  inputs: Record<string, unknown>[]
  sleeps: () => number
  /** Ends every sleep the plugin is waiting on, so its hold loop looks again. */
  tick: () => void
}

export function world(on: On, opts: WorldOptions = {}): World {
  const waiting: (() => void)[] = []
  const w: World = {
    opened: [],
    openArgs: [],
    closed: [],
    toasts: [],
    copied: [],
    ran: [],
    inputs: [],
    sleeps: () => sleeps,
    tick: () => waiting.splice(0).forEach(go => go()),
  }
  let sleeps = 0
  on('session.surfaces', () => ({ value: opts.surfaces ?? ['desktop'] }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('clock.now', () => ({ value: opts.now ? opts.now() : 1_000 }))
  on('process.run', ($, e) => {
    const done = { stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv[0] === 'sleep') {
      sleeps += 1
      // A hold nobody answers would spin forever on an instant sleep: give up.
      if (sleeps > 3000) return { deny: 'test: the hold was never answered' }
      const slept = { value: { exitCode: 0, stdout: '', ...done } }
      if (opts.instantSleep) return slept
      return new Promise<typeof slept>(resolve => waiting.push(() => resolve(slept)))
    }
    const answer = opts.run?.(e.argv) ?? { exitCode: 1, stdout: '' }
    return { value: { ...answer, ...done } }
  })
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', ($, e) => ({ value: (e as { path: string }).path in (opts.files ?? {}) }))
  on('fs.read', ($, e) => {
    const text = (opts.files ?? {})[(e as { path: string }).path]
    return text === undefined ? { deny: 'no such file' } : { value: text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    w.openArgs.push({ ...e })
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => {
    const open = w.opened.filter((id, i) => w.opened.slice(0, i + 1).filter(x => x === id).length > w.closed.filter(x => x === id).length)
    return { value: [...new Set(open)].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.copy', ($, e) => {
    w.copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  // The tool itself: a call that gets through "runs".
  on('tool.call', ($, e) => {
    if (e.tool === 'Read') return { result: 'ran' } // Read is the tests' yield
    w.ran.push(String(e.tool))
    w.inputs.push({ ...e })
    if (opts.failing?.includes(String(e.tool))) return { result: 'failed', isError: true }
    return { result: 'ran' }
  })
  return w
}

export const PANE_PROPS = {
  title: 'Code Buddy · held',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

export const BAND_PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

/** Domains and branch the tests that need them run with (the shipped defaults are empty). */
export const OPTS = {
  productionDomains: 'example.com, *.example.com, example.net, *.example.net',
  stagingDomains: '*.example.net, *.example.com',
  protectedBranch: 'main',
  guard: true,
}
