// Code Buddy's look: the Ruah Tech logo's blues (sampled from the official logo
// at ruahtech.com.au), drawn as SVG on the desktop Code tab and as coloured
// text in a terminal. The coral alert comes from the website's highlight.
//
// One SVG per row on the desktop, with Buttons beside it, follows savvy-progress
// (claude-kit, MIT; see NOTICE): the desktop wraps sibling elements onto new
// lines, so a row's text and shapes live in one drawing.

export const BRAND = {
  deep: '#012D96', // the logo's darkest royal blue
  royal: '#0745A4',
  blue: '#037AC1', // the logo's median blue
  sky: '#1E99D5', // the logo's lightest blue
  ink: '#0B1B3F',
  tint: '#E5F2FB',
  muted: '#6B7A90',
  coral: '#F55C6D', // ruahtech.com.au highlight, for holds
  white: '#FFFFFF',
} as const

export const FONT = "'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
export const MONO = "'IBM Plex Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace"

/** About 8 CSS px per reported column on the desktop. */
export const pxOf = (columns: number, reserve = 0, min = 220): number =>
  Math.max(min, Math.min(1600, Math.round((columns || 100) * 8 - reserve)))

export const xml = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

// Rough advance of UI text, in em: enough to size a slot and cut with an ellipsis.
const charEm = (ch: string, mono: boolean): number =>
  mono ? 0.61 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZmwW@%]/.test(ch) ? 0.72 : 0.56

export const textWidth = (s: string, size: number, mono = false): number =>
  [...s].reduce((w, ch) => w + charEm(ch, mono) * size, 0)

export function fit(s: string, size: number, maxW: number, mono = false): string {
  if (textWidth(s, size, mono) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(`${out}${ch}…`, size, mono) > maxW) break
    out += ch
  }
  return `${out}…`
}

// Light and dark: the classes every drawing shares.
const CSS = `<style>
.t{fill:${BRAND.ink}}.m{fill:${BRAND.muted}}.chip{fill:${BRAND.tint}}.chipt{fill:${BRAND.royal}}.ln{stroke:#D9E8F4}.acc{fill:${BRAND.blue}}
@media (prefers-color-scheme: dark){.t{fill:#EAF2FB}.m{fill:#93A3B8}.chip{fill:#0D2A4F}.chipt{fill:#7CC4EC}.ln{stroke:#1E3352}.acc{fill:${BRAND.sky}}}
.pulse{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.35}}
@media (prefers-reduced-motion: reduce){.pulse{animation:none}}
</style>`

const DEFS = `<defs>
<linearGradient id="cb-brand" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${BRAND.deep}"/><stop offset=".55" stop-color="${BRAND.blue}"/><stop offset="1" stop-color="${BRAND.sky}"/></linearGradient>
<linearGradient id="cb-glow" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${BRAND.sky}"/><stop offset="1" stop-color="${BRAND.white}" stop-opacity=".6"/></linearGradient>
<linearGradient id="cb-alert" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${BRAND.coral}"/><stop offset="1" stop-color="#E2475A"/></linearGradient>
</defs>`

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${CSS}${DEFS}${body}</svg>`

// The Ruah wave: a dot over four widening swooshes, 14 × 13, top-left at (x, y).
const wave = (x: number, y: number, stroke: string): string =>
  `<g transform="translate(${x},${y})" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round">` +
  `<circle cx="8.2" cy="1" r=".9" fill="${stroke}" stroke="none"/>` +
  '<path d="M5.6 3.4Q7.6 4.1 9.6 3.2"/><path d="M4 6Q7.2 7 10.8 5.7"/>' +
  '<path d="M2.4 8.6Q6.9 10 12.2 8.3"/><path d="M.8 11.2Q6.7 13 13.6 10.9"/></g>'

// Two pause bars, 10 × 12.
const pauseMark = (x: number, y: number, fill: string): string =>
  `<rect x="${x}" y="${y}" width="3.4" height="12" rx="1.2" fill="${fill}"/><rect x="${x + 6.2}" y="${y}" width="3.4" height="12" rx="1.2" fill="${fill}"/>`

/** The "Code Buddy" badge; returns its markup and width. */
function badge(x: number, y: number, h: number, label: string, alert: boolean): { body: string; w: number } {
  const w = Math.round(30 + textWidth(label, 11.5) + 12)
  const icon = alert ? pauseMark(x + 11, y + (h - 12) / 2, BRAND.white) : wave(x + 9, y + (h - 13) / 2, BRAND.white)
  return {
    w,
    body: `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="url(#${alert ? 'cb-alert' : 'cb-brand'})"/>${icon}
<text x="${x + 29}" y="${y + h / 2 + 4}" font-family="${FONT}" font-size="11.5" font-weight="600" letter-spacing=".2" fill="${BRAND.white}">${xml(label)}</text>`,
  }
}

const BAND_H = 24

/** Idle band: badge, guard state, how many calls were held. */
export function idleBandSvg(W: number, isOn: boolean, held: number, overBudget = ''): string {
  const b = badge(0, 2, 20, 'Code Buddy', false)
  let x = b.w + 12
  const dot = isOn
    ? `<circle class="pulse" cx="${x + 4}" cy="${BAND_H / 2}" r="3.6" fill="${BRAND.sky}"/>`
    : `<circle cx="${x + 4}" cy="${BAND_H / 2}" r="3.6" fill="none" stroke="${BRAND.muted}" stroke-width="1.4"/>`
  x += 13
  const guard = `<text class="${isOn ? 't' : 'm'}" x="${x}" y="${BAND_H / 2 + 4.5}" font-family="${FONT}" font-size="12.5" font-weight="500">Guard ${isOn ? 'on' : 'off'}</text>`
  x += textWidth(`Guard ${isOn ? 'on' : 'off'}`, 12.5) + 14
  const label = `${held} held`
  const cw = Math.round(textWidth(label, 11.5) + 18)
  const chip = `<rect class="chip" x="${x}" y="4" width="${cw}" height="16" rx="8"/><text class="chipt" x="${x + cw / 2}" y="${BAND_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11.5" font-weight="600">${xml(label)}</text>`
  x += cw + 8
  const ow = Math.round(textWidth(overBudget, 11.5) + 18)
  const over = overBudget
    ? `<rect x="${x}" y="4" width="${ow}" height="16" rx="8" fill="${BRAND.coral}" fill-opacity=".16"/><text x="${x + ow / 2}" y="${BAND_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11.5" font-weight="700" fill="${BRAND.coral}">${xml(overBudget)}</text>`
    : ''
  return svg(W, BAND_H, `${b.body}${dot}${guard}${chip}${over}`)
}

/** Band while a call waits: coral badge, the rule, the command. */
export function holdBandSvg(W: number, rule: string, command: string, behind: number): string {
  const b = badge(0, 2, 20, behind > 0 ? `Held +${behind}` : 'Held', true)
  const x = b.w + 12
  const ruleW = Math.min(W * 0.45, textWidth(rule, 12.5) + 4)
  const ruleText = fit(rule, 12.5, ruleW)
  const cx = x + textWidth(ruleText, 12.5) + 14
  const cmd = fit(command, 12, Math.max(0, W - cx - 4), true)
  return svg(
    W,
    BAND_H,
    `${b.body}<text class="t" x="${x}" y="${BAND_H / 2 + 4.5}" font-family="${FONT}" font-size="12.5" font-weight="600">${xml(ruleText)}</text>
<text class="m" x="${cx}" y="${BAND_H / 2 + 4.5}" font-family="${MONO}" font-size="12">${xml(cmd)}</text>`,
  )
}

export const HEADER_H = 62

/** The hold pane's header card. */
export function holdHeaderSvg(W: number, title: string, subtitle: string, behind: number): string {
  const pill = behind > 0 ? `+${behind} waiting` : ''
  const pw = pill ? Math.round(textWidth(pill, 11.5) + 20) : 0
  const textW = W - 64 - (pw ? pw + 16 : 12)
  return svg(
    W,
    HEADER_H,
    `<clipPath id="cb-card"><rect x="0" y="0" width="${W}" height="${HEADER_H}" rx="12"/></clipPath>
<g clip-path="url(#cb-card)"><rect x="0" y="0" width="${W}" height="${HEADER_H}" fill="url(#cb-brand)"/>
<rect x="0" y="${HEADER_H - 3}" width="${W}" height="3" fill="url(#cb-glow)" opacity=".9"/></g>
<circle cx="31" cy="${HEADER_H / 2}" r="17" fill="${BRAND.white}" fill-opacity=".14"/>
${pauseMark(26.2, HEADER_H / 2 - 6, BRAND.white)}
${pill ? '' : wave(0, 0, BRAND.white).replace('<g transform="translate(0,0)"', `<g opacity=".22" transform="translate(${W - 58},${HEADER_H / 2 - 16}) scale(2.4)"`)}
<text x="60" y="27" font-family="${FONT}" font-size="15" font-weight="600" fill="${BRAND.white}">${xml(fit(title, 15, textW))}</text>
<text x="60" y="45" font-family="${FONT}" font-size="11.5" fill="${BRAND.white}" fill-opacity=".78">${xml(fit(subtitle, 11.5, textW))}</text>
${pill ? `<rect x="${W - pw - 14}" y="${HEADER_H / 2 - 11}" width="${pw}" height="22" rx="11" fill="${BRAND.white}" fill-opacity=".16"/><text x="${W - 14 - pw / 2}" y="${HEADER_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11.5" font-weight="600" fill="${BRAND.white}">${xml(pill)}</text>` : ''}`,
  )
}

/** Rule chips, wrapped onto as many rows as they need; returns markup and height. */
export function chipsSvg(W: number, chips: string[]): { source: string; height: number } {
  const ROW = 26
  let x = 0
  let row = 0
  const parts: string[] = []
  for (const chip of chips) {
    const label = fit(chip, 12, W - 34)
    const w = Math.round(textWidth(label, 12) + 30)
    if (x > 0 && x + w > W) {
      x = 0
      row += 1
    }
    const y = row * ROW + 2
    parts.push(`<rect class="chip" x="${x}" y="${y}" width="${w}" height="21" rx="10.5"/>
<circle cx="${x + 11}" cy="${y + 10.5}" r="3" fill="${BRAND.coral}"/>
<text class="chipt" x="${x + 20}" y="${y + 14.5}" font-family="${FONT}" font-size="12" font-weight="600">${xml(label)}</text>`)
    x += w + 6
  }
  const height = (row + 1) * ROW
  return { source: svg(W, height, parts.join('')), height }
}

/** A section label: small caps in the accent blue, with a hairline. */
export function labelSvg(W: number, label: string): string {
  const tw = textWidth(label.toUpperCase(), 10.5) + 8
  return svg(
    W,
    18,
    `<text class="acc" x="0" y="13" font-family="${FONT}" font-size="10.5" font-weight="700" letter-spacing=".9">${xml(label.toUpperCase())}</text>
<line class="ln" x1="${tw + 4}" y1="9.5" x2="${W}" y2="9.5"/>`,
  )
}

// ---- Replay ----------------------------------------------------------------

export const GREEN = '#1FA971'

/** Cuts the start of `s` (a path) to fit, with a leading ellipsis. */
export function fitStart(s: string, size: number, maxW: number, mono = false): string {
  if (textWidth(s, size, mono) <= maxW) return s
  let out = ''
  for (const ch of [...s].reverse()) {
    if (textWidth(`…${ch}${out}`, size, mono) > maxW) break
    out = ch + out
  }
  return `…${out}`
}

// A play triangle, about 10 × 12.
const playMark = (x: number, y: number, fill: string): string =>
  `<path transform="translate(${x},${y})" d="M1.2 0.6Q0 0 0 1.4V10.6Q0 12 1.2 11.4L9.6 6.8Q10.8 6 9.6 5.2Z" fill="${fill}"/>`

export const REPLAY_HEADER_H = 54

/** The replay pane's header card: step k of n, the edits, a dot per step. */
export function replayHeaderSvg(W: number, k: number, total: number, files: number): string {
  const H = REPLAY_HEADER_H
  const title = `Replay · step ${k + 1} of ${total}`
  const sub = `${total} ${total === 1 ? 'edit' : 'edits'} in ${files} ${files === 1 ? 'file' : 'files'} · last turn`
  const DOT = 14
  const dotsW = total * DOT
  const showDots = dotsW <= W * 0.4
  const right = showDots ? dotsW + 16 : 0
  const dots = showDots
    ? Array.from({ length: total }, (_, i) => {
        const cx = W - 16 - dotsW + i * DOT + DOT / 2
        return i === k
          ? `<rect x="${cx - 6}" y="${H / 2 - 3.5}" width="12" height="7" rx="3.5" fill="${BRAND.white}"/>`
          : `<circle cx="${cx}" cy="${H / 2}" r="3" fill="${BRAND.white}" fill-opacity="${i < k ? 0.6 : 0.3}"/>`
      }).join('')
    : ''
  const textW = W - 58 - right - 8
  return svg(
    W,
    H,
    `<clipPath id="cb-rcard"><rect x="0" y="0" width="${W}" height="${H}" rx="12"/></clipPath>
<g clip-path="url(#cb-rcard)"><rect x="0" y="0" width="${W}" height="${H}" fill="url(#cb-brand)"/>
<rect x="0" y="${H - 3}" width="${Math.round((W * (k + 1)) / Math.max(1, total))}" height="3" fill="url(#cb-glow)"/></g>
<circle cx="27" cy="${H / 2}" r="15" fill="${BRAND.white}" fill-opacity=".14"/>
${playMark(23.5, H / 2 - 6, BRAND.white)}
<text x="52" y="23" font-family="${FONT}" font-size="14.5" font-weight="600" fill="${BRAND.white}">${xml(fit(title, 14.5, textW))}</text>
<text x="52" y="40" font-family="${FONT}" font-size="11.5" fill="${BRAND.white}" fill-opacity=".78">${xml(fit(sub, 11.5, textW))}</text>
${dots}`,
  )
}

/** One step's file row: the path, the tool, and +adds −dels pills. */
export function fileRowSvg(W: number, file: string, meta: string, adds: number, dels: number): string {
  const H = 34
  const plus = `+${adds}`
  const minus = `−${dels}`
  const pw = Math.round(textWidth(plus, 11.5) + 16)
  const mw = Math.round(textWidth(minus, 11.5) + 16)
  const pills = `<rect x="${W - pw - mw - 6}" y="${H / 2 - 9}" width="${pw}" height="18" rx="9" fill="${GREEN}" fill-opacity=".14"/>
<text x="${W - mw - 6 - pw / 2}" y="${H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11.5" font-weight="700" fill="${GREEN}">${plus}</text>
<rect x="${W - mw}" y="${H / 2 - 9}" width="${mw}" height="18" rx="9" fill="${BRAND.coral}" fill-opacity=".14"/>
<text x="${W - mw / 2}" y="${H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11.5" font-weight="700" fill="${BRAND.coral}">${minus}</text>`
  const textW = W - 24 - pw - mw - 18
  const doc = `<path class="acc" d="M3 2.5Q3 1 4.5 1H10l4 4v10.5Q14 17 12.5 17h-8Q3 17 3 15.5Z" fill-opacity=".16"/><path d="M10 1v4h4" fill="none" stroke="${BRAND.blue}" stroke-width="1.2"/><path d="M3 2.5Q3 1 4.5 1H10l4 4v10.5Q14 17 12.5 17h-8Q3 17 3 15.5Z" fill="none" stroke="${BRAND.blue}" stroke-width="1.2"/>`
  return svg(
    W,
    H,
    `<g transform="translate(0,${H / 2 - 9})">${doc}</g>
<text class="t" x="24" y="15" font-family="${MONO}" font-size="12.5" font-weight="600">${xml(fitStart(file, 12.5, textW, true))}</text>
<text class="m" x="24" y="30" font-family="${FONT}" font-size="11">${xml(fit(meta, 11, textW))}</text>
${pills}`,
  )
}

/** The band's replay hint: badge, "Replay ready", how many edits. */
export function replayBandSvg(W: number, edits: number, files: number): string {
  const b = badge(0, 2, 20, 'Code Buddy', false)
  const x = b.w + 12
  const label = 'Replay ready'
  const lx = x + 16
  const count = `${edits} ${edits === 1 ? 'edit' : 'edits'} in ${files} ${files === 1 ? 'file' : 'files'}`
  return svg(
    W,
    BAND_H,
    `${b.body}${playMark(x, BAND_H / 2 - 6, BRAND.blue).replace('fill="#037AC1"', 'class="acc"')}
<text class="t" x="${lx}" y="${BAND_H / 2 + 4.5}" font-family="${FONT}" font-size="12.5" font-weight="600">${label}</text>
<text class="m" x="${lx + textWidth(label, 12.5) + 12}" y="${BAND_H / 2 + 4.5}" font-family="${FONT}" font-size="12.5">${xml(count)}</text>`,
  )
}
export const BAND_ROW_H = BAND_H

// ---- Agents ----------------------------------------------------------------

export type AgentRowView = {
  status: 'running' | 'done' | 'failed' | 'stopped'
  title: string
  type: string
  model: string
  elapsed: string
  tokens: string
  cost: string
  /** What a running subagent is doing now, e.g. "Read · src/api/routes.ts". */
  activity?: string
  /** "step 4 · 9 tools" */
  progress?: string
}

/** Spend against the budget, for the panel's header and the band. */
export type BudgetView = { limit: string; used: string; ratio: number; isOver: boolean }

const STATUS_COLOR = { running: BRAND.sky, done: GREEN, failed: BRAND.coral, stopped: BRAND.muted } as const

function statusMark(cx: number, cy: number, status: AgentRowView['status'], r = 9): string {
  const c = STATUS_COLOR[status]
  const s = r / 9
  if (status === 'running') {
    return `<circle class="pulse" cx="${cx}" cy="${cy}" r="${r}" fill="${c}" fill-opacity=".18"/><circle cx="${cx}" cy="${cy}" r="${4.5 * s}" fill="${c}"/>`
  }
  const ring = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}" fill-opacity=".14"/>`
  if (status === 'done') return `${ring}<path d="M${cx - 4 * s} ${cy}l${2.8 * s} ${2.8 * s} ${5.2 * s}-${5.6 * s}" fill="none" stroke="${c}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `${ring}<path d="M${cx - 3.4 * s} ${cy - 3.4 * s}l${6.8 * s} ${6.8 * s}M${cx + 3.4 * s} ${cy - 3.4 * s}l-${6.8 * s} ${6.8 * s}" stroke="${c}" stroke-width="1.9" stroke-linecap="round"/>`
  return `${ring}<rect x="${cx - 3.2 * s}" y="${cy - 3.2 * s}" width="${6.4 * s}" height="${6.4 * s}" rx="1.2" fill="${c}"/>`
}

/** A progress bar: finished in the brand gradient (coral when over budget), running as a lighter, moving stripe. */
function progressBar(x: number, y: number, w: number, h: number, done: number, running: number, total: number, onCard: boolean, isOver = false): string {
  const fw = total ? Math.round((w * done) / total) : 0
  const rw = total ? Math.round((w * Math.min(total - done, running)) / total) : 0
  const track = onCard ? `fill="${BRAND.white}" fill-opacity=".22"` : 'class="chip"'
  const fill = isOver ? 'fill="url(#cb-alert)"' : onCard ? `fill="${BRAND.white}"` : 'fill="url(#cb-brand)"'
  const id = `cb-bar-${x}-${y}`
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/></clipPath>
<g clip-path="url(#${id})"><rect x="${x}" y="${y}" width="${w}" height="${h}" ${track}/>
<rect x="${x}" y="${y}" width="${fw}" height="${h}" ${fill}/>
${rw > 0 ? `<rect class="pulse" x="${x + fw}" y="${y}" width="${rw}" height="${h}" fill="${isOver ? BRAND.coral : onCard ? BRAND.white : BRAND.sky}" fill-opacity=".45"/>` : ''}</g>`
}

/** Band: badge, "Agents", the bar, finished of total and the cost so far (coral past the budget). */
export function agentsBandSvg(W: number, done: number, running: number, total: number, cost: string, isOver = false): string {
  const b = badge(0, 2, 20, 'Code Buddy', false)
  let x = b.w + 12
  const label = 'Agents'
  const head = `<text class="t" x="${x}" y="${BAND_H / 2 + 4.5}" font-family="${FONT}" font-size="12.5" font-weight="600">${label}</text>`
  x += textWidth(label, 12.5) + 12
  const tail = `${done} / ${total} finished · ${cost}`
  const over = isOver ? ' · over budget' : ''
  const tw = textWidth(tail + over, 12.5) + 6
  const barW = Math.max(60, Math.min(320, W - x - tw - 12))
  const bar = progressBar(x, BAND_H / 2 - 4, barW, 8, done, running, total, false, isOver)
  const tx = x + barW + 12
  return svg(
    W,
    BAND_H,
    `${b.body}${head}${bar}<text class="m" x="${tx}" y="${BAND_H / 2 + 4.5}" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${xml(tail)}${isOver ? `<tspan fill="${BRAND.coral}" font-weight="700">${over}</tspan>` : ''}</text>`,
  )
}

export const AGENTS_HEADER_H = 96

/** The agents pane's summary card: finished of total, a bar, cost, tokens, time and the budget. */
export function agentsHeaderSvg(W: number, done: number, running: number, total: number, stats: [string, string][], budget?: BudgetView): string {
  const H = AGENTS_HEADER_H
  const right = `${done} of ${total} finished`
  const tiles: [string, string, boolean][] = stats.map(([k, v]) => [k, v, false])
  if (budget) tiles.push(['Budget', budget.isOver ? `Over ${budget.limit}` : `${Math.round(budget.ratio * 100)}% of ${budget.limit}`, budget.isOver])
  const tw = (W - 32) / tiles.length
  const tileSvg = tiles
    .map(([k, v, alert], i) => {
      const x = 16 + i * tw
      const vw = textWidth(v, 15) + 14
      return `<text x="${x}" y="${H - 30}" font-family="${FONT}" font-size="10.5" font-weight="600" letter-spacing=".8" fill="${BRAND.white}" fill-opacity=".7">${xml(k.toUpperCase())}</text>
${alert ? `<rect x="${x - 7}" y="${H - 28}" width="${vw}" height="22" rx="11" fill="${BRAND.coral}"/>` : ''}
<text x="${x}" y="${H - 12}" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums" fill="${BRAND.white}">${xml(fit(v, 15, tw - 12))}</text>`
    })
    .join('')
  return svg(
    W,
    H,
    `<clipPath id="cb-acard"><rect x="0" y="0" width="${W}" height="${H}" rx="12"/></clipPath>
<g clip-path="url(#cb-acard)"><rect x="0" y="0" width="${W}" height="${H}" fill="url(#cb-brand)"/></g>
${wave(0, 0, BRAND.white).replace('<g transform="translate(0,0)"', `<g transform="translate(16,10) scale(1.15)"`)}
<text x="40" y="23" font-family="${FONT}" font-size="14.5" font-weight="600" fill="${BRAND.white}">Subagents</text>
<text x="${W - 16}" y="23" text-anchor="end" font-family="${FONT}" font-size="12" font-weight="600" fill="${BRAND.white}" fill-opacity=".85">${xml(right)}</text>
${progressBar(16, 34, W - 32, 7, done, running, total, true, budget?.isOver ?? false)}
${tileSvg}`,
  )
}

/** Below this width a row stacks its stats under the model instead of beside it. */
const NARROW = 520

/** A row's height: 54 px (72 narrow), plus a line for a running subagent's activity. */
export const agentRowHeight = (a: AgentRowView, W = 640): number => {
  const live = a.status === 'running' && !!a.activity
  return W < NARROW ? (live ? 90 : 72) : live ? 72 : 54
}

/** One subagent: status, description, type and model, elapsed, tokens, cost, and what it is doing now. */
export function agentRowSvg(W: number, a: AgentRowView): string {
  const H = agentRowHeight(a, W)
  const narrow = W < NARROW
  const stats = `${a.tokens} · ${a.cost}`
  const statsW = textWidth(stats, 11.5, true) + 4
  const elapsedW = textWidth(a.elapsed, 11.5, true) + 12
  const chip = fit(a.type, 10.5, Math.min(140, W * 0.4))
  const cw = Math.round(textWidth(chip, 10.5) + 14)
  const modelW = Math.max(40, W - 40 - cw - 8 - (narrow ? 0 : statsW + 12))
  const live = a.status === 'running' && a.activity
  const activity = live
    ? `<path d="M40 ${H - 22}l5 3.5-5 3.5z" fill="${BRAND.sky}"/>
<text x="51" y="${H - 14.5}" font-family="${MONO}" font-size="11.5" fill="${BRAND.sky}">${xml(fit(a.activity ?? '', 11.5, W - 51 - (narrow ? 0 : textWidth(a.progress ?? '', 11) + 16), true))}</text>
${narrow ? '' : `<text class="m" x="${W}" y="${H - 14.5}" text-anchor="end" font-family="${FONT}" font-size="11">${xml(a.progress ?? '')}</text>`}`
    : ''
  const statsSvg = narrow
    ? `<text class="m" x="40" y="60" font-family="${MONO}" font-size="11.5">${xml(fit(`${stats}${live && a.progress ? ` · ${a.progress}` : ''}`, 11.5, W - 40, true))}</text>`
    : `<text class="m" x="${W}" y="41" text-anchor="end" font-family="${MONO}" font-size="11.5">${xml(stats)}</text>`
  const shimmer =
    a.status === 'running'
      ? `<rect class="pulse" x="40" y="${H - 4}" width="${W - 40}" height="2" rx="1" fill="${BRAND.sky}" fill-opacity=".6"/>`
      : `<line class="ln" x1="40" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}"/>`
  return svg(
    W,
    H,
    `${statusMark(16, 20, a.status)}
<text class="t" x="40" y="20" font-family="${FONT}" font-size="13" font-weight="600">${xml(fit(a.title, 13, W - 40 - elapsedW))}</text>
<rect class="chip" x="40" y="29" width="${cw}" height="16" rx="8"/>
<text class="chipt" x="${40 + cw / 2}" y="40.5" text-anchor="middle" font-family="${FONT}" font-size="10.5" font-weight="600">${xml(chip)}</text>
<text class="m" x="${40 + cw + 8}" y="41" font-family="${FONT}" font-size="11.5">${xml(fit(a.model, 11.5, modelW))}</text>
<text class="t" x="${W}" y="20" text-anchor="end" font-family="${MONO}" font-size="11.5">${xml(a.elapsed)}</text>
${statsSvg}
${activity}
${shimmer}`,
  )
}

export const COMPACT_ROW_H = 26

/** The compact row: one line per subagent. */
export function compactAgentRowSvg(W: number, a: AgentRowView): string {
  const H = COMPACT_ROW_H
  const right = `${a.model} · ${a.elapsed} · ${a.cost}`
  const rw = textWidth(right, 11.5, true) + 8
  const middle = a.status === 'running' && a.activity ? a.activity : ''
  const titleW = Math.max(60, (W - 24 - rw) * (middle ? 0.55 : 1))
  const title = fit(a.title, 12.5, titleW)
  const mx = 24 + textWidth(title, 12.5) + 12
  return svg(
    W,
    H,
    `${statusMark(9, H / 2, a.status, 7)}
<text class="t" x="24" y="${H / 2 + 4.5}" font-family="${FONT}" font-size="12.5" font-weight="600">${xml(title)}</text>
${middle ? `<text x="${mx}" y="${H / 2 + 4.5}" font-family="${MONO}" font-size="11" fill="${BRAND.sky}">${xml(fit(middle, 11, Math.max(0, W - rw - mx - 8), true))}</text>` : ''}
<text class="m" x="${W}" y="${H / 2 + 4.5}" text-anchor="end" font-family="${MONO}" font-size="11.5">${xml(right)}</text>
<line class="ln" x1="24" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}"/>`,
  )
}

// ---- Agent details -------------------------------------------------------------

/** Splits text into lines that fit `maxW`, at most `max` of them, the last cut with an ellipsis. */
export function wrapLines(text: string, size: number, maxW: number, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (textWidth(next, size) <= maxW) {
      line = next
      continue
    }
    if (line) lines.push(line)
    line = textWidth(word, size) <= maxW ? word : fit(word, size, maxW)
    if (lines.length === max) break
  }
  if (line && lines.length < max) lines.push(line)
  if (lines.length === max && words.join(' ').length > lines.join(' ').length) {
    lines[max - 1] = fit(`${lines[max - 1]} …`, size, maxW)
  }
  return lines
}

const STATUS_LABEL = { running: 'Running', done: 'Finished', failed: 'Failed', stopped: 'Stopped' } as const

/** The detail view's card: status, elapsed, the full name over up to three lines, type · model · effort. */
export function detailHeaderSvg(W: number, a: AgentRowView, meta: string): { source: string; height: number } {
  const lines = wrapLines(a.title, 15, W - 32, 3)
  const H = 70 + lines.length * 20
  const label = STATUS_LABEL[a.status]
  const pw = Math.round(textWidth(label, 11) + 26)
  const pill = `<rect x="16" y="14" width="${pw}" height="20" rx="10" fill="${BRAND.white}" fill-opacity=".18"/>
<circle ${a.status === 'running' ? 'class="pulse" ' : ''}cx="27" cy="24" r="3.5" fill="${a.status === 'running' ? BRAND.white : STATUS_COLOR[a.status]}"/>
<text x="35" y="28" font-family="${FONT}" font-size="11" font-weight="700" fill="${BRAND.white}">${label}</text>`
  const title = lines
    .map((l, i) => `<text x="16" y="${58 + i * 20}" font-family="${FONT}" font-size="15" font-weight="600" fill="${BRAND.white}">${xml(l)}</text>`)
    .join('')
  return {
    height: H,
    source: svg(
      W,
      H,
      `<clipPath id="cb-dcard"><rect x="0" y="0" width="${W}" height="${H}" rx="12"/></clipPath>
<g clip-path="url(#cb-dcard)"><rect x="0" y="0" width="${W}" height="${H}" fill="url(#cb-brand)"/>
${a.status === 'running' ? `<rect class="pulse" x="0" y="${H - 3}" width="${W}" height="3" fill="${BRAND.white}" fill-opacity=".5"/>` : ''}</g>
${pill}
<text x="${W - 16}" y="29" text-anchor="end" font-family="${MONO}" font-size="15" font-weight="600" fill="${BRAND.white}">${xml(a.elapsed)}</text>
${title}
<text x="16" y="${H - 14}" font-family="${FONT}" font-size="11.5" fill="${BRAND.white}" fill-opacity=".8">${xml(fit(meta, 11.5, W - 32))}</text>`,
    ),
  }
}

/** A grid of labelled numbers, two or three across. */
export function statsGridSvg(W: number, stats: [string, string, string?][]): { source: string; height: number } {
  const cols = W < 420 ? 2 : 3
  const gap = 8
  const tw = (W - gap * (cols - 1)) / cols
  const TH = 52
  const rows = Math.ceil(stats.length / cols)
  const H = rows * TH + (rows - 1) * gap
  const tiles = stats
    .map(([k, v, sub], i) => {
      const x = (i % cols) * (tw + gap)
      const y = Math.floor(i / cols) * (TH + gap)
      return `<rect class="chip" x="${x}" y="${y}" width="${tw}" height="${TH}" rx="10"/>
<text class="chipt" x="${x + 10}" y="${y + 17}" font-family="${FONT}" font-size="10" font-weight="700" letter-spacing=".7">${xml(k.toUpperCase())}</text>
<text class="t" x="${x + 10}" y="${y + 38}" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${xml(fit(v, 15, tw - 20 - (sub ? textWidth(sub, 10.5) + 6 : 0)))}</text>
${sub ? `<text class="m" x="${x + tw - 10}" y="${y + 38}" text-anchor="end" font-family="${FONT}" font-size="10.5">${xml(sub)}</text>` : ''}`
    })
    .join('')
  return { height: H, source: svg(W, H, tiles) }
}

const PART_COLORS = [BRAND.deep, BRAND.blue, BRAND.sky, BRAND.coral]

/** Tokens by kind as one stacked bar, with a legend: tokens and cost of each. */
export function tokenBreakdownSvg(W: number, parts: [string, string, string, number][]): { source: string; height: number } {
  const total = parts.reduce((s, p) => s + p[3], 0) || 1
  let x = 0
  const bar = parts
    .map(([, , , n], i) => {
      const w = Math.round((W * n) / total)
      const r = `<rect x="${x}" y="0" width="${Math.max(0, w)}" height="10" fill="${PART_COLORS[i % PART_COLORS.length]}"/>`
      x += w
      return r
    })
    .join('')
  const legend = parts
    .map(([label, tokens, cost], i) => {
      const y = 30 + i * 20
      return `<rect x="0" y="${y - 9}" width="10" height="10" rx="3" fill="${PART_COLORS[i % PART_COLORS.length]}"/>
<text class="t" x="18" y="${y}" font-family="${FONT}" font-size="12">${xml(label)}</text>
<text class="m" x="${W - 70}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="11.5">${xml(tokens)}</text>
<text class="t" x="${W}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="11.5">${xml(cost)}</text>`
    })
    .join('')
  const H = 30 + parts.length * 20 - 6
  return {
    height: H,
    source: svg(W, H, `<clipPath id="cb-tbar"><rect x="0" y="0" width="${W}" height="10" rx="5"/></clipPath><g clip-path="url(#cb-tbar)"><rect class="chip" x="0" y="0" width="${W}" height="10"/>${bar}</g>${legend}`),
  }
}
