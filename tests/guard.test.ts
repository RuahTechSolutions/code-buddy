// Feature 1, Staging guard: which calls are held, and what the pane says.

import { describe, expect, test } from 'claude-code/testing'

import { configOf, hostsIn, inspectGuard, productionMatch, urlHostsIn } from '../hooks/guard'
import type { Io } from '../hooks/guard'
import { mask } from '../hooks/mask'

const cfg = configOf({
  productionDomains: 'example.com, *.example.com, example.net, *.example.net',
  stagingDomains: '*.example.net, *.example.com, staging.example.com',
  protectedBranch: 'main',
  guard: true,
})

const io = (branch = 'feature/x', extra: Record<string, string> = {}): Io => ({
  cwd: async () => '/repo',
  run: async argv => {
    const key = argv.join(' ')
    if (key === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: `${branch}\n` }
    if (key in extra) return { exitCode: 0, stdout: extra[key] ?? '' }
    return { exitCode: 1, stdout: '' }
  },
  list: async () => [],
})

const bash = (command: string, branch?: string, extra?: Record<string, string>) =>
  inspectGuard(io(branch, extra), { tool: 'Bash', command }, cfg)

describe('domains', () => {
  test('production wins on overlap, exact staging host goes through', () => {
    expect(productionMatch('example.com', cfg)).not.toBeNull()
    expect(productionMatch('api.example.com', cfg)?.alsoStaging).toBe('*.example.com')
    expect(productionMatch('staging.example.com', cfg)).toBeNull()
    expect(productionMatch('example.org', cfg)).toBeNull()
    expect(productionMatch('notexample.com', cfg)).toBeNull()
  })

  test('hosts are read from shell text and URLs', () => {
    expect(hostsIn('curl -s https://api.example.com/v1 && ssh deploy@example.net')).toEqual(['api.example.com', 'example.net'])
    expect(hostsIn('cat example.com.md')).toEqual(['example.com.md'])
    expect(urlHostsIn('https://app.example.com/login?x=1')).toEqual(['app.example.com'])
    expect(urlHostsIn('example.com')).toEqual(['example.com'])
  })

  test('a shell command that reaches production is held', async () => {
    const f = await bash('curl -X POST https://api.example.com/orders')
    expect(f?.rules).toEqual(['production domain: api.example.com'])
    expect(f?.affects.note).toContain('production wins')
  })

  test('staging and unrelated hosts go through', async () => {
    expect(await bash('curl https://staging.example.com/health')).toBeNull()
    expect(await bash('curl https://unrelated.dev && ls -la')).toBeNull()
  })

  test('WebFetch and browser tools are held on production URLs', async () => {
    const fetch = await inspectGuard(io(), { tool: 'WebFetch', url: 'https://example.com/pricing', prompt: 'x' }, cfg)
    expect(fetch?.rules).toEqual(['production domain: example.com'])
    const nav = await inspectGuard(io(), { tool: 'mcp__Claude_Browser__navigate', url: 'https://admin.example.net' }, cfg)
    expect(nav?.rules).toEqual(['production domain: admin.example.net'])
    const read = await inspectGuard(io(), { tool: 'Read', file_path: '/repo/example.com.txt' }, cfg)
    expect(read).toBeNull()
  })
})

describe('live Stripe keys', () => {
  const live = 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0'

  test('in a command, masked to 8 characters', async () => {
    const f = await bash(`curl https://api.stripe.com -u ${live}:`)
    expect(f?.rules[0]).toBe('live Stripe key in the command: sk_live_••••••')
    expect(f?.command).not.toContain('a1B2c3')
    expect(JSON.stringify(f)).not.toContain('a1B2c3')
  })

  test('in file content being written', async () => {
    const f = await inspectGuard(io(), { tool: 'Write', file_path: '/repo/.env', content: `STRIPE_KEY=${'rk_live_'}zzzzzzzzzzzz` }, cfg)
    expect(f?.rules[0]).toBe('live Stripe key in file content: rk_live_••••••')
    const edit = await inspectGuard(io(), { tool: 'Edit', file_path: '/repo/a.ts', old_string: 'x', new_string: `const k = '${'pk_live_'}yyyyyyyyyy'` }, cfg)
    expect(edit).not.toBeNull()
  })

  test('test keys go through', async () => {
    expect(await inspectGuard(io(), { tool: 'Write', file_path: '/repo/.env', content: 'STRIPE_KEY=sk_test_abcdefghijkl' }, cfg)).toBeNull()
  })
})

describe('protected branch', () => {
  test('push to main by refspec, with the commits it would push', async () => {
    const f = await bash('git push origin feature/x:main', 'feature/x', { 'git log --oneline --no-decorate origin/main..feature/x': 'abc123 add thing\ndef456 fix\n' })
    expect(f?.rules).toEqual(['push to protected branch: origin/main'])
    expect(f?.affects.summary).toBe('push 2 commits to origin/main')
    expect(f?.affects.lines).toEqual(['abc123 add thing', 'def456 fix'])
  })

  test('plain push while on main', async () => {
    const f = await bash('git push', 'main')
    expect(f?.rules).toEqual(['push to protected branch: origin/main'])
  })

  test('push of a feature branch goes through', async () => {
    expect(await bash('git push -u origin feature/x', 'feature/x')).toBeNull()
  })

  test('force push and delete of main are held', async () => {
    expect((await bash('git push --force origin +main'))?.rules).toEqual(['push to protected branch: origin/main'])
    expect((await bash('git push origin --delete main'))?.rules).toEqual(['push to protected branch: deletes origin/main'])
  })

  test('merge into main, including after a checkout on the same line', async () => {
    expect((await bash('git merge feature/x', 'main'))?.rules).toEqual(['merge into protected branch: main'])
    expect((await bash('git checkout main && git merge feature/x', 'feature/x'))?.rules).toEqual(['merge into protected branch: main'])
    expect(await bash('git merge main', 'feature/x')).toBeNull()
    expect(await bash('git pull', 'main')).toBeNull()
  })
})

describe('deploys', () => {
  for (const command of ['vercel --prod', 'npx vercel deploy --prod', 'terraform apply -auto-approve', 'cd infra && cdk deploy MyStack', 'kubectl apply -f k8s/', 'docker push ghcr.io/acme/api:1.2']) {
    test(`${command} is held`, async () => {
      const f = await bash(command)
      expect(f?.rules[0]).toMatch(/^deploy: /)
    })
  }

  test('non-production commands go through', async () => {
    for (const command of ['vercel', 'terraform plan', 'cdk synth', 'kubectl get pods', 'docker build .', 'git status']) {
      expect(await bash(command), command).toBeNull()
    }
  })
})

describe('mask', () => {
  // Fake keys are built from two halves, so secret scanners don't flag the source.
  const stripeKey = `${'sk_live_'}abcdefghijklmnop`
  const githubToken = `${'ghp_'}abcdefghijklmnopqrstuvwxyz0123`

  test('keeps the first 8 characters of a key', () => {
    expect(mask(stripeKey)).toBe('sk_live_••••••')
    expect(mask('Authorization: Bearer abcdefghijklmnopqrstu')).toBe('Authorization: Bearer abcdefgh••••••')
    expect(mask('API_TOKEN=abcdefghijklmnop')).toBe('API_TOKEN=abcdefgh••••••')
    expect(mask('--password hunter2hunter2')).toBe('--password hunter2h••••••')
    expect(mask(githubToken)).toBe('ghp_abcd••••••')
    expect(mask(mask(stripeKey))).toBe('sk_live_••••••')
    expect(mask('git push origin main')).toBe('git push origin main')
  })
})
