// Feature 2, Blast radius: holds destructive shell commands and works out what
// they would delete or change.
//
// Adapted from blast-radius (claude-code-playground), Copyright 2026 Anthropic
// PBC, licensed under the Apache License 2.0. Modified for Code Buddy: ported
// to TypeScript; reads through register.tsx's Io instead of `$`; `~` expands
// from the account record (HOME unset) so no environment variable is read;
// migrations are listed from files on disk instead of the migration tools'
// status commands, which would connect to the database. See NOTICE.

import type { Finding, Io } from './guard'
import { mask } from './mask'
import { gitParts, segments } from './shell'
import type { Segment } from './shell'

const LIST_MAX = 10

type GitRisk = { kind: 'git-reset' | 'git-clean' | 'git-push-force' | 'git-checkout'; label: string; args: string[]; dir: string | null }

type Risk =
  | { kind: 'rm'; label: string; targets: string[]; dir: string | null }
  | GitRisk
  | { kind: 'migrate'; tool: string; label: string; dir: string | null }

type Measured = { summary: string; lines: string[]; more: number; note: string }

// Commands that only read, so a bare word "migrate" in them isn't a migration.
const READ_ONLY = new Set(['ls', 'cat', 'echo', 'printf', 'grep', 'rg', 'find', 'less', 'head', 'tail', 'git', 'man', 'which', 'type'])

/** Every destructive command on the line, in order. */
export function classify(command: string): Risk[] {
  return segments(command)
    .map(classifySegment)
    .filter((r): r is Risk => r !== null)
}

function classifySegment(seg: Segment): Risk | null {
  const { cmd, args, dir } = seg
  if (cmd === 'rm') {
    const flags = args.filter(a => a.startsWith('-') && a !== '-' && a !== '--')
    const recursive = flags.some(f => f === '--recursive' || (/^-[^-]/.test(f) && /[rR]/.test(f)))
    const force = flags.some(f => f === '--force' || (/^-[^-]/.test(f) && f.includes('f')))
    if (recursive || force) {
      const dash = args.indexOf('--')
      const targets = dash >= 0 ? args.slice(dash + 1) : args.filter(a => !a.startsWith('-') || a === '-')
      return { kind: 'rm', label: `rm ${flags.join(' ')}`.trim(), targets, dir }
    }
  }
  if (cmd === 'git') {
    const { dir: gitDir, sub, rest } = gitParts(seg)
    if (sub === 'reset' && rest.includes('--hard')) return { kind: 'git-reset', label: 'git reset --hard', args: rest, dir: gitDir }
    if (sub === 'clean' && !rest.some(a => a === '-n' || a === '--dry-run' || (/^-[a-zA-Z]+$/.test(a) && a.includes('n')))) {
      return { kind: 'git-clean', label: 'git clean', args: rest, dir: gitDir }
    }
    if (sub === 'push' && rest.some(a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || a === '--force-if-includes' || /^\+/.test(a) || (/^-[a-zA-Z]+$/.test(a) && a.includes('f')))) {
      return { kind: 'git-push-force', label: 'git push --force', args: rest, dir: gitDir }
    }
    const stagedOnly = sub === 'restore' && rest.includes('--staged') && !rest.includes('--worktree') && !rest.includes('-W')
    if ((sub === 'checkout' || sub === 'restore') && (rest.includes('.') || rest.includes(':/')) && !stagedOnly) {
      return { kind: 'git-checkout', label: `git ${sub} -- .`, args: rest, dir: gitDir }
    }
  }
  const joined = [cmd, ...args].join(' ')
  const migration: [RegExp, string, string][] = [
    [/\balembic\s+(upgrade|downgrade)\b/, 'alembic', 'alembic upgrade'],
    [/\bdb:(migrate|rollback|reset|drop|schema:load)(?!:status\b)/, 'rails', 'rails db:migrate'],
    [/\bprisma\s+(migrate\s+(deploy|dev|reset)|db\s+push)\b/, 'prisma', 'prisma migrate'],
    [/\bmanage\.py\s+(migrate|flush)\b/, 'django', 'manage.py migrate'],
    [/\b(knex|sequelize)\b.*\b(migrate|db:migrate)/, 'knex', 'knex/sequelize migrate'],
    [/\bdrizzle-kit\s+(migrate|push)\b/, 'drizzle', 'drizzle-kit migrate'],
    [/\bflyway\b.*\bmigrate\b/, 'flyway', 'flyway migrate'],
  ]
  for (const [re, tool, label] of migration) if (re.test(joined)) return { kind: 'migrate', tool, label, dir }
  if (!READ_ONLY.has(cmd) && args.includes('migrate')) return { kind: 'migrate', tool: 'unknown', label: `${cmd} migrate`, dir }
  return null
}

// ---- Measuring -------------------------------------------------------------

// With HOME unset, bash expands ~ from the account record: no variable is read.
const NO_HOME = ['env', '-u', 'HOME', 'bash', '-c']

// Resolves a folder to an absolute one, or prints nothing when it doesn't exist.
// The folder is an argument, never source.
const CD_SCRIPT = [
  'unset CDPATH; h=~; d="$1"',
  'case "$d" in "~") d="$h";; "~/"*) d="$h/${d#\\~/}";; esac',
  'cd -- "$d" 2>/dev/null && pwd -P',
].join('\n')

// Counts what rm would remove. Paths are arguments, never source; compgen -G
// expands a glob without command substitution.
const RM_SCRIPT = [
  'shopt -s nullglob dotglob',
  'h=~',
  'paths=()',
  'for p in "$@"; do',
  '  case "$p" in "~") p="$h";; "~/"*) p="$h/${p#\\~/}";; esac',
  '  if [[ "$p" == *[*?[]* ]]; then',
  '    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")',
  '  elif [[ -e "$p" || -L "$p" ]]; then',
  '    paths+=("$p")',
  '  fi',
  'done',
  'if (( ${#paths[@]} == 0 )); then echo "0 0 0"; exit 0; fi',
  // A relative path gets ./ in front, so find never reads a name like -delete as an action.
  'for i in "${!paths[@]}"; do case "${paths[$i]}" in /*) ;; *) paths[$i]="./${paths[$i]}";; esac; done',
  'files=$(find "${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | wc -l | tr -d " ")',
  'kb=$(du -skc "${paths[@]}" 2>/dev/null | tail -n1 | cut -f1)',
  'echo "$files $(( ${kb:-0} * 1024 )) ${#paths[@]}"',
  `find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | head -n ${LIST_MAX}`,
].join('\n')

async function resolveDir(io: Io, cwd: string, dir: string | null): Promise<string | null> {
  if (dir === null) return cwd
  if (dir === '-') return null // `cd -` depends on the shell's history
  const run = await io.run([...NO_HOME, CD_SCRIPT, 'code-buddy', dir], cwd, 5000)
  const out = run?.stdout.trim() ?? ''
  return run?.exitCode === 0 && out !== '' ? out : null
}

function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = -1
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

async function measureRm(io: Io, risk: Extract<Risk, { kind: 'rm' }>, cwd: string): Promise<Measured> {
  if (risk.targets.length === 0) return { summary: 'rm with no paths', lines: [], more: 0, note: 'No paths to expand.' }
  const run = await io.run([...NO_HOME, RM_SCRIPT, 'code-buddy', ...risk.targets], cwd, 15000)
  const [head, ...rest] = (run?.stdout ?? '').split('\n').filter(l => l !== '')
  const [files = 0, bytes = 0, found = 0] = (head ?? '0 0 0').split(' ').map(Number)
  if (!found) return { summary: `delete nothing: no file matches ${risk.targets.join(' ')}`, lines: [], more: 0, note: "The paths don't exist, so rm has nothing to remove." }
  if (!files) return { summary: `delete ${plural(found, 'path')} with no files in ${found === 1 ? 'it' : 'them'}`, lines: [], more: 0, note: `Paths: ${risk.targets.join(' ')}` }
  return {
    summary: `delete ${plural(files, 'file')} (about ${size(bytes)})`,
    lines: rest.map(l => l.replace(/^\.\//, '')),
    more: Math.max(0, files - rest.length),
    note: `Paths: ${risk.targets.join(' ')}. Deleted files don't go to the Trash.`,
  }
}

async function measureClean(io: Io, args: string[], where: string): Promise<Measured> {
  const flags: string[] = []
  const paths: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? ''
    if (a === '--') {
      paths.push(...args.slice(i + 1))
      break
    }
    if (a === '-e' || a === '--exclude') {
      flags.push(a, args[i + 1] ?? '')
      i += 1
    } else if (a.startsWith('--exclude=') || /^-e./.test(a)) {
      flags.push(a)
    } else if (/^-[a-zA-Z]+$/.test(a)) {
      const kept = a.replace(/[finq]/g, '') // -n is added below; -f, -i and -q would change the dry run
      if (kept !== '-') flags.push(kept)
    } else if (!a.startsWith('-')) {
      paths.push(a)
    }
  }
  const run = await io.run(['git', 'clean', '-n', ...flags, '--', ...paths], where, 15000)
  if (run?.exitCode !== 0) return { summary: 'git clean (could not dry-run it)', lines: [], more: 0, note: '' }
  const gone = run.stdout.split('\n').filter(l => l.startsWith('Would remove ')).map(l => l.slice(13))
  return {
    summary: gone.length === 0 ? 'remove nothing: no untracked files match' : `remove ${plural(gone.length, 'untracked path')}`,
    lines: gone.slice(0, LIST_MAX),
    more: Math.max(0, gone.length - LIST_MAX),
    note: "From git clean -n. Untracked files aren't in git, so they can't be recovered.",
  }
}

async function measureDiscard(io: Io, risk: GitRisk, where: string): Promise<Measured> {
  const status = await io.run(['git', 'status', '--porcelain'], where, 15000)
  if (status?.exitCode !== 0) return { summary: `${risk.label} (not a git repo here?)`, lines: [], more: 0, note: '' }
  const rows = status.stdout.split('\n').filter(l => l.length > 3 && !l.startsWith('??'))
  // reset --hard drops staged and unstaged changes; checkout -- . drops unstaged ones.
  const lost = risk.kind === 'git-reset' ? rows : rows.filter(l => l[1] !== ' ')
  const stat = await io.run(['git', 'diff', '--shortstat', risk.kind === 'git-reset' ? 'HEAD' : '--'], where, 15000)
  const target = risk.kind === 'git-reset' ? risk.args.find(a => !a.startsWith('-')) : undefined
  const shortstat = stat?.stdout.trim() ?? ''
  return {
    summary: lost.length === 0 ? `discard nothing: no uncommitted changes${target ? ` (then move to ${target})` : ''}` : `discard uncommitted changes in ${plural(lost.length, 'file')}${target ? ` and move to ${target}` : ''}`,
    lines: lost.slice(0, LIST_MAX).map(l => `${l.slice(0, 2)} ${l.slice(3)}`),
    more: Math.max(0, lost.length - LIST_MAX),
    note: shortstat !== '' ? `${shortstat}. Uncommitted changes can't be recovered.` : 'From git status --porcelain.',
  }
}

async function measurePush(io: Io, args: string[], where: string): Promise<Measured> {
  const positional = args.filter(a => !a.startsWith('-'))
  const remote = positional[0] ?? 'origin'
  const spec = (positional[1] ?? '').replace(/^\+/, '')
  let [source = '', branch = ''] = spec.includes(':') ? spec.split(':') : [spec, spec]
  branch = branch.replace(/^refs\/heads\//, '')
  if (!branch || branch === 'HEAD') {
    const head = await io.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], where, 10000)
    branch = head?.stdout.trim() ?? ''
    source = 'HEAD'
  }
  source = source || 'HEAD'
  const ref = `${remote}/${branch}`
  const known = await io.run(['git', 'rev-parse', '--verify', '--quiet', ref], where, 10000)
  if (known?.exitCode !== 0) return { summary: `force-push to ${ref}`, lines: [], more: 0, note: `No local copy of ${ref}, so the commits it would drop can't be listed (no fetch is made).` }
  const log = await io.run(['git', 'log', '--oneline', '--no-decorate', `${source}..${ref}`], where, 15000)
  const dropped = (log?.stdout ?? '').split('\n').filter(l => l !== '')
  return {
    summary: dropped.length === 0 ? `force-push to ${ref}: drops no commits` : `force-push to ${ref}: drops ${plural(dropped.length, 'commit')}`,
    lines: dropped.slice(0, LIST_MAX),
    more: Math.max(0, dropped.length - LIST_MAX),
    note: `Commits on ${ref} that ${source} doesn't have, as of the last fetch.`,
  }
}

// Where each tool keeps its migration files. Listing files needs no database.
const MIGRATION_DIRS: Record<string, string[]> = {
  prisma: ['prisma/migrations'],
  django: ['migrations'],
  alembic: ['alembic/versions', 'migrations/versions'],
  rails: ['db/migrate'],
  knex: ['migrations', 'db/migrations'],
  drizzle: ['drizzle', 'migrations'],
  flyway: ['sql', 'db/migration', 'src/main/resources/db/migration'],
  unknown: ['migrations', 'db/migrations', 'db/migrate'],
}

async function measureMigrations(io: Io, risk: Extract<Risk, { kind: 'migrate' }>, where: string): Promise<Measured> {
  for (const rel of MIGRATION_DIRS[risk.tool] ?? []) {
    const names = (await io.list(`${where}/${rel}`)).filter(n => !n.startsWith('.') && !n.startsWith('__') && n !== 'migration_lock.toml').sort()
    if (names.length === 0) continue
    const newest = names.slice(-LIST_MAX).reverse()
    return {
      summary: `run ${risk.label} against the configured database (${plural(names.length, 'migration')} in ${rel})`,
      lines: newest,
      more: Math.max(0, names.length - newest.length),
      note: "Newest first. Which ones are pending can't be checked without connecting to the database, so none is assumed applied.",
    }
  }
  return { summary: `run ${risk.label} against the configured database`, lines: [], more: 0, note: "Couldn't find the migration files to list them." }
}

async function measure(io: Io, risk: Risk, cwd: string): Promise<Measured> {
  const where = await resolveDir(io, cwd, risk.dir)
  if (where === null) return { summary: `${risk.label} in ${risk.dir}`, lines: [], more: 0, note: `Couldn't find the folder ${risk.dir}, so I couldn't measure what this would change.` }
  switch (risk.kind) {
    case 'rm':
      return measureRm(io, risk, where)
    case 'git-clean':
      return measureClean(io, risk.args, where)
    case 'git-push-force':
      return measurePush(io, risk.args, where)
    case 'migrate':
      return measureMigrations(io, risk, where)
    default:
      return measureDiscard(io, risk, where)
  }
}

/** Whether blast radius holds this call, and what it would change. */
export async function inspectBlast(io: Io, e: Record<string, unknown>): Promise<Finding | null> {
  if (String(e.tool) !== 'Bash') return null
  const command = String(e.command ?? '')
  const risks = classify(command)
  if (risks.length === 0) return null
  const cwd = await io.cwd()
  const rules: string[] = []
  const summaries: string[] = []
  const lines: string[] = []
  const notes: string[] = []
  let more = 0
  for (const risk of risks) {
    let m: Measured
    try {
      m = await measure(io, risk, cwd)
    } catch {
      m = { summary: `${risk.label} (could not measure it)`, lines: [], more: 0, note: '' }
    }
    rules.push(`destructive: ${risk.label}`)
    summaries.push(m.summary)
    lines.push(...m.lines)
    more += m.more
    if (m.note) notes.push(m.note)
  }
  return {
    rules: rules.map(mask),
    command: mask(command),
    affects: {
      summary: mask(summaries.join('; ')),
      lines: lines.slice(0, LIST_MAX).map(mask),
      more: more + Math.max(0, lines.length - LIST_MAX),
      note: mask(notes.join(' ')),
    },
  }
}

/** Merges the guard's and blast radius's findings for one call into one hold. */
export function merge(a: Finding | null, b: Finding | null): Finding | null {
  if (a === null) return b
  if (b === null) return a
  const lines = [...a.affects.lines, ...b.affects.lines]
  return {
    rules: [...a.rules, ...b.rules],
    command: a.command,
    affects: {
      summary: `${a.affects.summary}; ${b.affects.summary}`,
      lines: lines.slice(0, LIST_MAX),
      more: a.affects.more + b.affects.more + Math.max(0, lines.length - LIST_MAX),
      note: [a.affects.note, b.affects.note].filter(Boolean).join(' '),
    },
  }
}

/** For when the check itself failed: does this look destructive? */
export const looksDestructive = (command: string): boolean => classify(command).length > 0
