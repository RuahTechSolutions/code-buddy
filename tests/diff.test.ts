// Feature 3: the diffs a replay step shows.

import { describe, expect, test } from 'claude-code/testing'

import { MAX_DIFF_LINES, applyEdits, buildStep, relPath } from '../hooks/diff'

const lines = (n: number, f = (i: number) => `l${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n'

describe('buildStep', () => {
  test('an edit mid-file has real line numbers and 3 lines of context', () => {
    const before = lines(20)
    const after = before.replace('l10\n', 'L10\n')
    const step = buildStep('src/a.ts', 'Edit', '', before, after, false)
    expect(step.diff.split('\n')).toEqual(['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -7,7 +7,7 @@', ' l7', ' l8', ' l9', '-l10', '+L10', ' l11', ' l12', ' l13'])
    expect([step.adds, step.dels]).toEqual([1, 1])
  })

  test('a new file is all additions from /dev/null', () => {
    const step = buildStep('new.ts', 'Write', '', '', 'a\nb\n', true)
    expect(step.diff.split('\n')).toEqual(['--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1,2 @@', '+a', '+b'])
  })

  test('far-apart changes are separate hunks', () => {
    const before = lines(40)
    const after = before.replace('l5\n', 'L5\n').replace('l35\n', 'L35\n')
    const step = buildStep('a.ts', 'Edit', '', before, after, false)
    expect(step.diff.split('\n').filter(l => l.startsWith('@@'))).toEqual(['@@ -2,7 +2,7 @@', '@@ -32,7 +32,7 @@'])
  })

  test('a long rewrite is cut to whole, valid hunks', () => {
    const step = buildStep('big.ts', 'Write', 'rewrite', lines(400), lines(400, i => `x${i}`), false)
    const body = step.diff.split('\n').slice(2)
    expect(body.length).toBeLessThanOrEqual(MAX_DIFF_LINES)
    const [head = '', ...rest] = body
    const [, o = '', n = ''] = /^@@ -\d+,(\d+) \+\d+,(\d+) @@$/.exec(head) ?? []
    expect(rest.filter(l => !l.startsWith('+')).length).toBe(Number(o))
    expect(rest.filter(l => !l.startsWith('-')).length).toBe(Number(n))
    expect(step.note).toMatch(/more lines not shown$/)
  })

  test('secrets in the diff are masked', () => {
    const step = buildStep('.env', 'Write', '', '', `STRIPE=${'sk_live_'}abcdefghijklmnop\nAPI_TOKEN=abcdefghijklmnop\n`, true)
    expect(step.diff).toContain('sk_live_••••••')
    expect(step.diff).toContain('API_TOKEN=abcdefgh••••••')
    expect(step.diff).not.toContain('ijklmnop')
  })
})

describe('applyEdits', () => {
  test('replaces the first match, or all with replace_all, literally', () => {
    expect(applyEdits('a b a', [{ old_string: 'a', new_string: '$&x' }])).toBe('$&x b a')
    expect(applyEdits('a b a', [{ old_string: 'a', new_string: 'c', replace_all: true }])).toBe('c b c')
    expect(applyEdits('one two', [{ old_string: 'one', new_string: '1' }, { old_string: 'two', new_string: '2' }])).toBe('1 2')
    expect(applyEdits('abc', [{ old_string: 'zzz', new_string: 'y' }])).toBeNull()
  })

  test('paths are shown relative to the session folder', () => {
    expect(relPath('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(relPath('/repo', '/etc/hosts')).toBe('/etc/hosts')
  })
})
