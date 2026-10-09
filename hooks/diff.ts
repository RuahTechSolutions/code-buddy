// Feature 3, Replay: turns one file edit into a step with a unified diff.
//
// The line diff is adapted from replay-theater (claude-code-playground),
// Copyright 2026 Anthropic PBC, licensed under the Apache License 2.0.
// Modified for Code Buddy: ported to TypeScript; the edit is applied to the
// file's text so the diff has real line numbers; common lines at the ends are
// trimmed before the LCS; the result is unified-diff hunks, masked. See NOTICE.

import type { ReplayStep } from '../types'
import { mask } from './mask'

type Op = { op: ' ' | '-' | '+'; t: string }

const MAX_LCS_LINES = 400
const CONTEXT = 3
/** Diff lines kept per step; whole hunks first, the last one cut to fit. */
export const MAX_DIFF_LINES = 160

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Line operations from a to b: common ends trimmed, then an LCS on the middle. */
export function lineOps(a: string[], b: string[]): { ops: Op[]; skipped: number } {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const ctxStart = Math.max(0, start - CONTEXT)
  const head: Op[] = a.slice(ctxStart, start).map(t => ({ op: ' ', t }))
  const tail: Op[] = a.slice(endA, Math.min(a.length, endA + CONTEXT)).map(t => ({ op: ' ', t }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  let mid: Op[]
  if (midA.length > MAX_LCS_LINES || midB.length > MAX_LCS_LINES) {
    mid = [...midA.map(t => ({ op: '-' as const, t })), ...midB.map(t => ({ op: '+' as const, t }))]
  } else {
    const n = midA.length
    const m = midB.length
    const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i]![j] = midA[i] === midB[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
      }
    }
    mid = []
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        mid.push({ op: ' ', t: midA[i]! })
        i += 1
        j += 1
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
        mid.push({ op: '-', t: midA[i]! })
        i += 1
      } else {
        mid.push({ op: '+', t: midB[j]! })
        j += 1
      }
    }
    while (i < n) mid.push({ op: '-', t: midA[i++]! })
    while (j < m) mid.push({ op: '+', t: midB[j++]! })
  }
  return { ops: [...head, ...mid, ...tail], skipped: ctxStart }
}

/** Unified-diff hunks over the ops; `skipped` lines precede the first op in both files. */
function hunks(ops: Op[], skipped: number): string[][] {
  const changed = ops.map((o, i) => (o.op === ' ' ? -1 : i)).filter(i => i >= 0)
  if (changed.length === 0) return []
  // Group changes whose gap is small enough to share context.
  const groups: [number, number][] = []
  for (const i of changed) {
    const last = groups[groups.length - 1]
    if (last && i - last[1] <= CONTEXT * 2 + 1) last[1] = i
    else groups.push([i, i])
  }
  const out: string[][] = []
  for (const [first, lastChange] of groups) {
    const from = Math.max(0, first - CONTEXT)
    const to = Math.min(ops.length, lastChange + CONTEXT + 1)
    const before = ops.slice(0, from)
    const oldBefore = skipped + before.filter(o => o.op !== '+').length
    const newBefore = skipped + before.filter(o => o.op !== '-').length
    out.push([`@@${oldBefore}@@${newBefore}`, ...ops.slice(from, to).map(o => `${o.op}${o.t}`)])
  }
  return out
}

/** The header of a hunk from its lines, counts recomputed so a cut hunk still parses. */
function header(oldBefore: number, newBefore: number, lines: string[]): string {
  const oldCount = lines.filter(l => !l.startsWith('+')).length
  const newCount = lines.filter(l => !l.startsWith('-')).length
  const oldStart = oldCount === 0 ? oldBefore : oldBefore + 1
  const newStart = newCount === 0 ? newBefore : newBefore + 1
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
}

/** One replay step: the file's text before and after the edit, as a masked unified diff. */
export function buildStep(file: string, tool: string, note: string, before: string, after: string, isNew: boolean): ReplayStep {
  const { ops, skipped } = lineOps(splitLines(before), splitLines(after))
  const adds = ops.filter(o => o.op === '+').length
  const dels = ops.filter(o => o.op === '-').length
  const body: string[] = []
  let cut = 0
  for (const h of hunks(ops, skipped)) {
    const [mark = '', ...lines] = h
    const [, ob = '0', nb = '0'] = mark.split('@@')
    const room = MAX_DIFF_LINES - body.length - 1
    if (room < 2) {
      cut += lines.length
      continue
    }
    const kept = lines.slice(0, room)
    cut += lines.length - kept.length
    body.push(header(Number(ob), Number(nb), kept), ...kept.map(mask))
  }
  const path = mask(file)
  const diff = body.length === 0 ? '' : [`--- ${isNew ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`, ...body].join('\n')
  return { file: path, tool, note: cut > 0 ? `${note}${note ? ' · ' : ''}${cut} more lines not shown` : note, diff, adds, dels, isNew }
}

/** The file's text after an Edit or MultiEdit, the edits applied as the tool would. */
export function applyEdits(before: string, edits: { old_string?: unknown; new_string?: unknown; replace_all?: unknown }[]): string | null {
  let text = before
  for (const ed of edits) {
    const from = String(ed.old_string ?? '')
    const to = String(ed.new_string ?? '')
    if (from === '') {
      text = to + text
      continue
    }
    const at = text.indexOf(from)
    if (at < 0) return null // the tool would fail; nothing to record
    text = ed.replace_all === true ? text.split(from).join(to) : text.slice(0, at) + to + text.slice(at + from.length)
  }
  return text
}

/** Relative to the session folder when inside it. */
export const relPath = (cwd: string, path: string): string =>
  !path ? '(unknown file)' : cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
