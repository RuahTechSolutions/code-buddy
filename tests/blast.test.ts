// Feature 2, Blast radius: which commands are destructive, and what each
// would delete or change.

import { describe, expect, test } from 'claude-code/testing'

import { classify, inspectBlast, merge } from '../hooks/blast'
import { configOf, inspectGuard } from '../hooks/guard'
import type { Io } from '../hooks/guard'

type Answer = { exitCode: number; stdout: string }

/** An Io that answers each command by a rule, and records what was run. */
function fakeIo(answer: (argv: string[]) => Answer | undefined, folders: Record<string, string[]> = {}) {
  const ran: string[][] = []
  const io: Io = {
    cwd: async () => '/repo',
    run: async argv => {
      ran.push(argv)
      // the folder resolver: echo the folder back as absolute
      if (argv[5]?.startsWith('unset CDPATH')) return { exitCode: 0, stdout: `${argv[7]?.startsWith('/') ? argv[7] : `/repo/${argv[7]}`}\n` }
      return answer(argv) ?? { exitCode: 1, stdout: '' }
    },
    list: async dir => folders[dir] ?? [],
  }
  return { io, ran }
}

const bash = (command: string) => ({ tool: 'Bash', command })

describe('classify', () => {
  const held = [
    'rm -rf build',
    'rm -r node_modules',
    'rm -f .env.local',
    'sudo rm -Rf /tmp/x',
    'cd app && rm -rf dist',
    'git reset --hard',
    'git reset --hard origin/main',
    'git checkout -- .',
    'git checkout .',
    'git restore .',
    'git clean -fdx',
    'git push --force',
    'git push -f origin feature',
    'git push origin +feature',
    'git push --force-with-lease',
    'npx prisma migrate deploy',
    'python manage.py migrate',
    'bin/rails db:migrate',
    'alembic upgrade head',
    'npx knex migrate:latest',
  ]
  for (const command of held) {
    test(`holds: ${command}`, () => {
      expect(classify(command).length, command).toBeGreaterThan(0)
    })
  }

  const passed = ['rm file.txt', 'git reset HEAD~1', 'git reset --soft HEAD~1', 'git restore --staged .', 'git clean -n', 'git clean -fdn', 'git push origin feature', 'git checkout feature', 'bin/rails db:migrate:status', 'echo migrate', 'grep -r migrate .', 'ls -rf']
  for (const command of passed) {
    test(`passes: ${command}`, () => {
      expect(classify(command), command).toEqual([])
    })
  }
})

describe('measure', () => {
  test('rm counts the files and size, with ~ expanded without HOME', async () => {
    const { io, ran } = fakeIo(argv => (argv[0] === 'env' ? { exitCode: 0, stdout: '3 12288 1\nbuild/a.js\nbuild/b.js\nbuild/c.js\n' } : undefined))
    const f = await inspectBlast(io, bash('rm -rf build'))
    expect(f?.rules).toEqual(['destructive: rm -rf'])
    expect(f?.affects.summary).toBe('delete 3 files (about 12 KB)')
    expect(f?.affects.lines).toEqual(['build/a.js', 'build/b.js', 'build/c.js'])
    const rm = ran.find(a => a.includes('build'))
    expect(rm?.slice(0, 5)).toEqual(['env', '-u', 'HOME', 'bash', '-c'])
  })

  test('rm after cd measures in that folder', async () => {
    const { io, ran } = fakeIo(argv => (argv[0] === 'env' ? { exitCode: 0, stdout: '1 4096 1\ndist/x.js\n' } : undefined))
    const f = await inspectBlast(io, bash('cd app && rm -rf dist'))
    expect(f?.affects.summary).toBe('delete 1 file (about 4.0 KB)')
    expect(ran.some(a => a.at(-1) === 'app')).toBe(true)
  })

  test('rm of nothing says so', async () => {
    const { io } = fakeIo(() => ({ exitCode: 0, stdout: '0 0 0\n' }))
    const f = await inspectBlast(io, bash('rm -rf nope'))
    expect(f?.affects.summary).toBe('delete nothing: no file matches nope')
  })

  test('git reset --hard lists the uncommitted changes it drops', async () => {
    const { io } = fakeIo(argv => {
      const k = argv.join(' ')
      if (k === 'git status --porcelain') return { exitCode: 0, stdout: ' M src/app.ts\nM  src/db.ts\n?? new.txt\n' }
      if (k === 'git diff --shortstat HEAD') return { exitCode: 0, stdout: ' 2 files changed, 10 insertions(+), 3 deletions(-)\n' }
      return undefined
    })
    const f = await inspectBlast(io, bash('git reset --hard'))
    expect(f?.affects.summary).toBe('discard uncommitted changes in 2 files')
    expect(f?.affects.lines).toEqual([' M src/app.ts', 'M  src/db.ts'])
    expect(f?.affects.note).toContain("can't be recovered")
  })

  test('git checkout -- . drops only unstaged changes', async () => {
    const { io } = fakeIo(argv => (argv.join(' ') === 'git status --porcelain' ? { exitCode: 0, stdout: ' M a.ts\nM  b.ts\n' } : undefined))
    const f = await inspectBlast(io, bash('git checkout -- .'))
    expect(f?.affects.lines).toEqual([' M a.ts'])
  })

  test('git clean is dry-run first', async () => {
    const { io, ran } = fakeIo(argv => (argv[1] === 'clean' ? { exitCode: 0, stdout: 'Would remove dist/\nWould remove tmp.log\n' } : undefined))
    const f = await inspectBlast(io, bash('git clean -fdx'))
    expect(f?.affects.summary).toBe('remove 2 untracked paths')
    expect(ran.find(a => a[1] === 'clean')).toEqual(['git', 'clean', '-n', '-dx', '--'])
  })

  test('force push lists the commits it would drop', async () => {
    const { io } = fakeIo(argv => {
      const k = argv.join(' ')
      if (k === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'feature\n' }
      if (k === 'git rev-parse --verify --quiet origin/feature') return { exitCode: 0, stdout: 'abc\n' }
      if (k === 'git log --oneline --no-decorate HEAD..origin/feature') return { exitCode: 0, stdout: 'aaa111 teammate fix\n' }
      return undefined
    })
    const f = await inspectBlast(io, bash('git push --force'))
    expect(f?.affects.summary).toBe('force-push to origin/feature: drops 1 commit')
    expect(f?.affects.lines).toEqual(['aaa111 teammate fix'])
  })

  test('migrations are listed from files, never by connecting to the database', async () => {
    const { io, ran } = fakeIo(() => undefined, { '/repo/prisma/migrations': ['20260101_init', '20260901_add_orders', 'migration_lock.toml'] })
    const f = await inspectBlast(io, bash('npx prisma migrate deploy'))
    expect(f?.affects.summary).toBe('run prisma migrate against the configured database (2 migrations in prisma/migrations)')
    expect(f?.affects.lines).toEqual(['20260901_add_orders', '20260101_init'])
    expect(ran.some(a => a.includes('prisma'))).toBe(false)
  })
})

test('a force push to main is one hold with both rules', async () => {
  const cfg = configOf({ productionDomains: '', stagingDomains: '', protectedBranch: 'main', guard: true })
  const { io } = fakeIo(() => undefined)
  const e = bash('git push --force origin main')
  const f = merge(await inspectGuard(io, e, cfg), await inspectBlast(io, e))
  expect(f?.rules).toEqual(['push to protected branch: origin/main', 'destructive: git push --force'])
})
