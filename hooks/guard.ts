// Feature 1, Staging guard: decides whether a tool call should be held, and
// works out what it would affect. Reads the working copy with local git only:
// no network requests, no model calls, no environment variables.

import type { Affects } from '../types'
import { liveStripeKeys, mask } from './mask'
import { gitParts, segments } from './shell'
import type { Segment } from './shell'

/** What the guard may read, handed in by register.tsx (only it calls the engine). */
export type Io = {
  cwd: () => Promise<string>
  /** Runs a local command; null when it could not start. */
  run: (argv: string[], cwd: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string } | null>
  /** The names in a folder; empty when unreadable. */
  list: (dir: string) => Promise<string[]>
}

export type GuardConfig = {
  production: string[]
  staging: string[]
  branches: string[]
  isOn: boolean
}

/** What a held call is held for. Every text in it is masked. */
export type Finding = {
  rules: string[]
  command: string
  affects: Affects
}

const LIST_MAX = 10

export const parseList = (text: unknown): string[] =>
  String(text ?? '')
    .split(/[,\s]+/)
    .map(s => s.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean)

export function configOf(options: Record<string, unknown>): GuardConfig {
  return {
    production: parseList(options.productionDomains),
    staging: parseList(options.stagingDomains),
    branches: parseList(options.protectedBranch).length ? parseList(options.protectedBranch) : ['main'],
    isOn: options.guard !== false && options.guard !== 'off',
  }
}

// ---- Domains ---------------------------------------------------------------

const HOST = /(?<![A-Za-z0-9_%+.-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63})\.?(?![A-Za-z0-9_-])/g
// A URL's host, or a whole value that is a bare host (a browser's address bar).
const URL_HOST = /[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^\s/@]*@)?([A-Za-z0-9.-]+)/g

/** Every host named in shell text. */
export function hostsIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(HOST)) out.add((m[1] ?? '').toLowerCase())
  return [...out]
}

/** Hosts in a browser or fetch tool's values: URLs, or a value that is just a host. */
export function urlHostsIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(URL_HOST)) out.add((m[1] ?? '').toLowerCase().replace(/\.$/, ''))
  const bare = text.trim().toLowerCase().replace(/[/?#].*$/, '')
  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(bare)) out.add(bare)
  return [...out]
}

export const matchesHost = (host: string, pattern: string): boolean =>
  pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern

/**
 * Production wins on overlap: a host is let through only when an exact
 * (non-wildcard) staging entry names it. Returns null when it isn't held.
 */
export function productionMatch(host: string, cfg: GuardConfig): { pattern: string; alsoStaging: string | undefined } | null {
  const pattern = cfg.production.find(p => matchesHost(host, p))
  if (pattern === undefined) return null
  if (cfg.staging.some(p => !p.startsWith('*.') && p === host)) return null
  return { pattern, alsoStaging: cfg.staging.find(p => matchesHost(host, p)) }
}

function domainFindings(hosts: string[], cfg: GuardConfig, verb: string): { rules: string[]; lines: string[]; notes: string[] } {
  const rules: string[] = []
  const lines: string[] = []
  const notes: string[] = []
  for (const host of hosts) {
    const hit = productionMatch(host, cfg)
    if (!hit) continue
    rules.push(`production domain: ${host}`)
    lines.push(`${verb} ${host} (matches ${hit.pattern})`)
    if (hit.alsoStaging) notes.push(`${host} also matches staging ${hit.alsoStaging}; production wins.`)
  }
  return { rules, lines, notes }
}

// ---- Branches --------------------------------------------------------------

const globRe = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)

export const isProtected = (branch: string | undefined, cfg: GuardConfig): boolean =>
  branch !== undefined && cfg.branches.some(b => globRe(b).test(branch.replace(/^refs\/heads\//, '')))

const absDir = (cwd: string, dir: string | null): string | null => {
  if (dir === null) return cwd
  if (dir === '-' || dir.startsWith('~')) return null // depends on the shell's state
  return dir.startsWith('/') ? dir : `${cwd}/${dir}`
}

async function currentBranch(io: Io, dir: string | null): Promise<string | undefined> {
  if (dir === null) return undefined
  const run = await io.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], dir, 10000)
  const out = run?.stdout.trim()
  return run?.exitCode === 0 && out && out !== 'HEAD' ? out : undefined
}

async function gitLines(io: Io, dir: string | null, argv: string[]): Promise<string[] | null> {
  if (dir === null) return null
  const run = await io.run(['git', ...argv], dir, 15000)
  return run?.exitCode === 0 ? run.stdout.split('\n').filter(l => l !== '') : null
}

// Options of git push that take a value, so the value isn't read as the remote.
const PUSH_VALUE_OPTIONS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])

function positional(args: string[], valued: Set<string>): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? ''
    if (a === '--') {
      out.push(...args.slice(i + 1))
      break
    }
    if (valued.has(a)) i += 1
    else if (!a.startsWith('-')) out.push(a)
  }
  return out
}

type Hit = { rule: string; summary: string; lines: string[]; note?: string }

async function gitFindings(io: Io, seg: Segment, cwd: string, cfg: GuardConfig, switched: { branch?: string }): Promise<Hit[]> {
  const { dir, sub, rest } = gitParts(seg)
  const where = absDir(cwd, dir)
  const hits: Hit[] = []
  const branchNow = async () => switched.branch ?? (await currentBranch(io, where))

  if (sub === 'checkout' || sub === 'switch') {
    const pos = positional(rest, new Set(['-b', '-B', '-c', '-C', '--orphan']))
    const created = rest.findIndex(a => ['-b', '-B', '-c', '-C', '--orphan'].includes(a))
    const target = created >= 0 ? rest[created + 1] : pos.length === 1 ? pos[0] : undefined
    if (target && target !== '.' && target !== '--') switched.branch = target
    return hits
  }

  if (sub === 'push') {
    const flags = rest.filter(a => a.startsWith('-'))
    const pos = positional(rest, PUSH_VALUE_OPTIONS)
    const remote = pos[0] ?? 'origin'
    const specs = pos.slice(1)
    if (flags.some(f => f === '--all' || f === '--mirror' || f === '--branches')) {
      hits.push({ rule: `push to protected branch: ${flags.find(f => ['--all', '--mirror', '--branches'].includes(f))} includes ${cfg.branches.join(', ')}`, summary: `push every local branch to ${remote}, ${cfg.branches.join(', ')} included`, lines: [] })
      return hits
    }
    const deleting = flags.includes('-d') || flags.includes('--delete')
    const targets: { src: string; dst: string }[] = []
    if (specs.length === 0) {
      if (flags.includes('--tags')) return hits
      const b = await branchNow()
      if (b === undefined) {
        hits.push({ rule: 'push to protected branch: could not tell the current branch', summary: `push the current branch to ${remote}`, lines: [], note: "Couldn't read the current branch, so this is held to be safe." })
        return hits
      }
      targets.push({ src: 'HEAD', dst: b })
    }
    for (const spec of specs) {
      const s = spec.replace(/^\+/, '')
      const [src = '', dst = ''] = s.includes(':') ? s.split(':') : [s, s]
      const name = dst.replace(/^refs\/heads\//, '')
      targets.push({ src: src || '(delete)', dst: name === 'HEAD' ? ((await branchNow()) ?? 'HEAD') : name })
    }
    for (const t of targets) {
      if (!isProtected(t.dst, cfg)) continue
      if (deleting || t.src === '(delete)') {
        hits.push({ rule: `push to protected branch: deletes ${remote}/${t.dst}`, summary: `delete ${t.dst} on ${remote}`, lines: [] })
        continue
      }
      const commits = await gitLines(io, where, ['log', '--oneline', '--no-decorate', `${remote}/${t.dst}..${t.src}`])
      hits.push({
        rule: `push to protected branch: ${remote}/${t.dst}`,
        summary: commits === null ? `push ${t.src} to ${remote}/${t.dst}` : `push ${commits.length} ${commits.length === 1 ? 'commit' : 'commits'} to ${remote}/${t.dst}`,
        lines: (commits ?? []).slice(0, LIST_MAX),
        note: commits === null ? `No local copy of ${remote}/${t.dst}, so the commits can't be listed (no fetch is made).` : `Commits ${t.src} has that ${remote}/${t.dst} doesn't, as of the last fetch.`,
      })
    }
    return hits
  }

  if (sub === 'merge' || sub === 'pull') {
    if (rest.some(a => ['--abort', '--continue', '--quit', '--skip'].includes(a))) return hits
    const b = await branchNow()
    if (!isProtected(b, cfg)) return hits
    const pos = positional(rest, new Set(['-m', '-s', '-X', '--strategy', '--strategy-option', '-F', '--file']))
    const from = sub === 'merge' ? pos : pos.slice(1)
    if (sub === 'pull' && (from.length === 0 || from.every(f => isProtected(f.replace(/^.*:/, ''), cfg)))) return hits // updating main from its own upstream
    const source = from.join(' ') || '(upstream)'
    const commits = sub === 'merge' && from.length === 1 ? await gitLines(io, where, ['log', '--oneline', '--no-decorate', `HEAD..${from[0]}`]) : null
    hits.push({
      rule: `merge into protected branch: ${b}`,
      summary: commits === null ? `merge ${source} into ${b}` : `merge ${commits.length} ${commits.length === 1 ? 'commit' : 'commits'} from ${source} into ${b}`,
      lines: (commits ?? []).slice(0, LIST_MAX),
      note: '',
    })
  }
  return hits
}

// ---- Deploys ---------------------------------------------------------------

async function deployFindings(io: Io, seg: Segment, cwd: string): Promise<Hit[]> {
  const { cmd, args } = seg
  const where = absDir(cwd, seg.dir)
  const place = seg.dir ?? 'the session folder'
  const valueOf = (names: string[]): string | undefined => {
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i] ?? ''
      for (const n of names) {
        if (a === n) return args[i + 1]
        if (a.startsWith(`${n}=`)) return a.slice(n.length + 1)
      }
    }
    return undefined
  }

  if ((cmd === 'vercel' || cmd === 'vc') && (args.includes('--prod') || args.includes('--production') || valueOf(['--target']) === 'production')) {
    return [{ rule: 'deploy: vercel --prod', summary: `deploy ${place} to Vercel production`, lines: [], note: 'Production traffic is served from this build once it finishes.' }]
  }
  if ((cmd === 'terraform' || cmd === 'tofu') && args.includes('apply')) {
    const tf = where ? (await io.list(where)).filter(n => n.endsWith('.tf')) : []
    const plan = args.find(a => a.endsWith('.tfplan') || a.endsWith('.plan'))
    return [{
      rule: `deploy: ${cmd} apply`,
      summary: plan ? `apply the saved plan ${plan}` : `apply Terraform changes in ${place}`,
      lines: tf.slice(0, LIST_MAX),
      note: args.some(a => a.startsWith('-auto-approve') || a.startsWith('--auto-approve')) ? "-auto-approve skips Terraform's own confirmation." : '',
    }]
  }
  if (cmd === 'cdk' && args.includes('deploy')) {
    const stacks = positional(args.slice(args.indexOf('deploy') + 1), new Set(['--profile', '-c', '--context', '--app', '-a', '--role-arn', '-r', '--parameters', '--outputs-file', '-O']))
    return [{ rule: 'deploy: cdk deploy', summary: args.includes('--all') || stacks.length === 0 ? 'deploy every stack in the CDK app' : `deploy ${stacks.length} CDK ${stacks.length === 1 ? 'stack' : 'stacks'}`, lines: stacks.slice(0, LIST_MAX), note: args.includes('--require-approval') ? '' : '' }]
  }
  if (cmd === 'kubectl' && args.includes('apply')) {
    const files: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i] ?? ''
      if (a === '-f' || a === '--filename' || a === '-k' || a === '--kustomize') files.push(args[i + 1] ?? '')
      else if (a.startsWith('--filename=') || a.startsWith('-f=')) files.push(a.replace(/^[^=]*=/, ''))
    }
    let context = valueOf(['--context'])
    if (!context) {
      const run = await io.run(['kubectl', 'config', 'current-context'], where ?? cwd, 5000)
      if (run?.exitCode === 0) context = run.stdout.trim()
    }
    const ns = valueOf(['-n', '--namespace'])
    return [{ rule: 'deploy: kubectl apply', summary: `apply ${files.length ? files.join(', ') : 'manifests'} to ${context ? `context ${context}` : 'the current kubectl context'}${ns ? `, namespace ${ns}` : ''}`, lines: [], note: args.some(a => a.startsWith('--dry-run')) ? 'This has --dry-run, but is held anyway.' : '' }]
  }
  if ((cmd === 'docker' || cmd === 'podman') && args.includes('push')) {
    const image = positional(args.slice(args.indexOf('push') + 1), new Set())[0] ?? '(image)'
    return [{ rule: `deploy: ${cmd} push`, summary: `push image ${image} to its registry`, lines: [], note: '' }]
  }
  if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
    return [{ rule: 'merge into protected branch: gh pr merge', summary: `merge pull request ${args[2] && !args[2].startsWith('-') ? args[2] : '(current branch)'} into its base branch`, lines: [], note: "The base branch isn't checked (that needs the network); it is usually main." }]
  }
  return []
}

// ---- Tools -----------------------------------------------------------------

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const WEBBY = /fetch|http|request|curl|browser|chrome|playwright|puppeteer|navigate|preview_start|web/i

const strings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach(v => strings(v, out))
  else if (value && typeof value === 'object') Object.values(value).forEach(v => strings(v, out))
  return out
}

const finding = (rules: string[], command: string, summary: string, lines: string[], notes: string[]): Finding => ({
  rules: rules.map(mask),
  command: mask(command),
  affects: {
    summary: mask(summary),
    lines: lines.slice(0, LIST_MAX).map(mask),
    more: Math.max(0, lines.length - LIST_MAX),
    note: mask(notes.filter(Boolean).join(' ')),
  },
})

/** Whether the guard holds this call, and why. Null when it goes through. */
export async function inspectGuard(io: Io, e: Record<string, unknown>, cfg: GuardConfig): Promise<Finding | null> {
  const tool = String(e.tool)

  if (tool === 'Bash') {
    const command = String(e.command ?? '')
    const rules: string[] = []
    const lines: string[] = []
    const notes: string[] = []
    let summary = ''
    const domains = domainFindings(hostsIn(command), cfg, 'reaches')
    rules.push(...domains.rules)
    lines.push(...domains.lines)
    notes.push(...domains.notes)
    if (domains.rules.length) summary = `reach production: ${domains.rules.map(r => r.replace(/^production domain: /, '')).join(', ')}`
    const keys = liveStripeKeys(command)
    if (keys.length) {
      rules.push(`live Stripe key in the command: ${keys.join(', ')}`)
      summary ||= 'use a live Stripe key: real charges and real customer data'
    }
    const cwd = await io.cwd()
    const switched: { branch?: string } = {}
    for (const seg of segments(command)) {
      const hits = [...(seg.cmd === 'git' ? await gitFindings(io, seg, cwd, cfg, switched) : []), ...(await deployFindings(io, seg, cwd))]
      for (const h of hits) {
        rules.push(h.rule)
        summary = summary ? `${summary}; ${h.summary}` : h.summary
        lines.push(...h.lines)
        if (h.note) notes.push(h.note)
      }
    }
    return rules.length ? finding(rules, command, summary, lines, notes) : null
  }

  if (EDIT_TOOLS.has(tool)) {
    const file = String(e.file_path ?? e.notebook_path ?? '')
    const text = [e.content, e.new_string, e.new_source, ...(Array.isArray(e.edits) ? e.edits.map(x => (x as { new_string?: unknown }).new_string) : [])]
      .filter(v => typeof v === 'string')
      .join('\n')
    const keys = liveStripeKeys(text)
    if (!keys.length) return null
    return finding([`live Stripe key in file content: ${keys.join(', ')}`], `${tool} ${file}`, `write a live Stripe key into ${file}`, [], ['Anything that reads this file gets live access to Stripe. Use a test key (sk_test_) or an environment variable.'])
  }

  if (tool === 'WebFetch' || (tool.startsWith('mcp__') && WEBBY.test(tool))) {
    const values = strings(e)
    const hosts = [...new Set(values.flatMap(urlHostsIn))]
    const domains = domainFindings(hosts, cfg, tool === 'WebFetch' ? 'fetches' : 'opens')
    if (!domains.rules.length) return null
    const shown = typeof e.url === 'string' ? e.url : values.find(v => urlHostsIn(v).some(h => productionMatch(h, cfg))) ?? ''
    return finding(domains.rules, `${tool} ${shown}`, `send a request to production: ${domains.rules.map(r => r.replace(/^production domain: /, '')).join(', ')}`, domains.lines, domains.notes)
  }

  return null
}

/**
 * A synchronous judgment for when the guard itself failed: true when the call
 * looks risky enough to refuse without the full check.
 */
export function looksRisky(e: Record<string, unknown>, cfg: GuardConfig): boolean {
  const text = strings(e).join('\n')
  if (liveStripeKeys(text).length) return true
  if (String(e.tool) === 'Bash' || String(e.tool) === 'WebFetch' || WEBBY.test(String(e.tool))) {
    if ([...hostsIn(text), ...urlHostsIn(text)].some(h => productionMatch(h, cfg))) return true
  }
  if (String(e.tool) === 'Bash') {
    return /\bgit\b[^;&|\n]*\b(push|merge)\b|\b(vercel|vc)\b[^;&|\n]*--prod|\b(terraform|tofu)\b[^;&|\n]*\bapply\b|\bcdk\b[^;&|\n]*\bdeploy\b|\bkubectl\b[^;&|\n]*\bapply\b|\b(docker|podman)\b[^;&|\n]*\bpush\b/.test(text)
  }
  return false
}
