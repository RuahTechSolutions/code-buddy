// Portions derived from blast-radius (claude-code-playground), Copyright 2026
// Anthropic PBC, licensed under the Apache License 2.0. Modified for Code Buddy:
// ported to TypeScript, returns every segment instead of the first risky one,
// and strips package-runner prefixes (npx, pnpm dlx, bunx). See NOTICE.
//
// Splits a shell command line into simple commands ("segments"), each with the
// folder it runs in after any `cd`, `pushd`, `popd` or `( subshell )` earlier
// on the line. Good enough to read flags and paths, not a full shell parser.

export type Segment = {
  /** The command's name, without a leading backslash or path. */
  cmd: string
  /** Its arguments, quotes removed. */
  args: string[]
  /** Folder it runs in relative to the session folder; null = the session folder. */
  dir: string | null
  /** The segment as written. */
  raw: string
}

// sudo options that take a value, so the value isn't read as the command.
const SUDO_VALUE_OPTIONS = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U'])
// Words that can come before the real command without changing what it does.
const PREFIXES = new Set(['command', 'exec', 'env', 'nohup', 'time', 'then', 'do', 'else', '!', 'xargs'])

/** Splits one segment into words, honouring quotes. */
export function tokenize(text: string): string[] {
  const words: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    words.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return words
}

/** A folder a later `cd arg` moves to, given the folder so far (null = the session folder). */
export function joinDir(dir: string | null, arg: string | undefined): string {
  if (arg === undefined || arg === '~' || arg.startsWith('/') || arg.startsWith('~/')) {
    return arg ?? '~'
  }
  return dir ? `${dir}/${arg}` : arg
}

function stripPrefixes(words: string[]): string[] {
  const w = [...words]
  while (w.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0] ?? '')) w.shift()
  if (w[0] === 'sudo') {
    w.shift()
    while (w.length > 0 && (w[0] ?? '').startsWith('-')) {
      const option = w.shift() ?? ''
      if (SUDO_VALUE_OPTIONS.has(option)) w.shift()
    }
  }
  while (w.length > 0 && (PREFIXES.has(w[0] ?? '') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0] ?? ''))) w.shift()
  if (w[0] === 'nice') {
    w.shift()
    if (w.at(0) === '-n') w.splice(0, 2)
    else if (/^-\d+$/.test(w[0] ?? '')) w.shift()
  }
  // Package runners: npx vercel, pnpm dlx cdk, bunx, yarn dlx, npm exec --.
  if (w[0] === 'npx' || w[0] === 'bunx' || w[0] === 'pnpx') {
    w.shift()
    while ((w[0] ?? '').startsWith('-')) w.shift()
  } else if ((w[0] === 'pnpm' || w[0] === 'yarn') && w[1] === 'dlx') {
    w.splice(0, 2)
  } else if (w[0] === 'npm' && w[1] === 'exec') {
    w.splice(0, 2)
    if (w.at(0) === '--') w.shift()
  }
  return w
}

/** Every simple command on the line, in order, with the folder it runs in. */
export function segments(command: string): Segment[] {
  const out: Segment[] = []
  let dir: string | null = null
  const scopes: (string | null)[] = [] // dir to restore when a ( subshell ) closes
  const pushed: (string | null)[] = [] // pushd stack, for popd
  for (const raw of command.split(/&&|\|\||;|\||\n/)) {
    const opens = raw.match(/^\s*\(+/)?.[0].trim().length ?? 0
    // Trailing redirects and & don't hide a closing ) : `(cd sub && make) > log`.
    const tail = raw.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, '')
    const closes = tail.match(/\)+\s*$/)?.[0].trim().length ?? 0
    for (let k = 0; k < opens; k += 1) scopes.push(dir)
    const words = stripPrefixes(tokenize(raw.trim().replace(/^[({]+\s*/, '').replace(/\s*[)}]+$/, '')))
    const [first, ...args] = words
    if (first !== undefined) {
      const cmd = first.replace(/^\\/, '').replace(/^.*\//, '')
      if (cmd === 'cd') {
        dir = args[0] === '-' ? '-' : joinDir(dir, args[0])
      } else if (cmd === 'pushd') {
        pushed.push(dir)
        dir = joinDir(dir, args[0])
      } else if (cmd === 'popd') {
        dir = pushed.length > 0 ? (pushed.pop() ?? null) : '-'
      } else {
        out.push({ cmd, args, dir, raw: raw.trim() })
      }
    }
    for (let k = 0; k < closes && scopes.length > 0; k += 1) dir = scopes.pop() ?? null
  }
  return out
}

/** For `git`: the folder after `-C`, the subcommand and its arguments. */
export function gitParts(seg: Segment): { dir: string | null; sub: string | undefined; rest: string[] } {
  let dir = seg.dir
  let i = 0
  const a = seg.args
  while (i < a.length && (a[i] ?? '').startsWith('-')) {
    if (a[i] === '-C' && i + 1 < a.length) {
      dir = joinDir(dir, a[i + 1])
      i += 2
    } else if (a[i] === '-c' && i + 1 < a.length) {
      i += 2
    } else {
      i += 1
    }
  }
  return { dir, sub: a[i], rest: a.slice(i + 1) }
}
