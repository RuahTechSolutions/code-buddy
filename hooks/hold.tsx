// The one hold pane for the staging guard and blast radius. Holds are queued so
// only one shows at a time. Each waits for Proceed or Cancel, and is refused
// after 10 minutes, when the turn is interrupted, or when nobody can answer.
//
// The waiting approach follows blast-radius (claude-code-playground, Copyright
// 2026 Anthropic PBC, Apache-2.0): a hook has 10 s of its own time, but time
// inside a `$` call is free, so the loop waits on a short `sleep` process.

import type { EngineInterface } from 'claude-code'

import type { HoldOutcome, HoldView } from '../types'
import type { Finding } from './guard'
import { BRAND, HEADER_H, chipsSvg, holdBandSvg, holdHeaderSvg, idleBandSvg, labelSvg, pxOf } from './theme'

export const HOLD_PANE = 'code-buddy-hold'
export const HOLD_LIMIT_MS = 10 * 60 * 1000
export const POLL_SECONDS = '0.25'

export type Decision = 'proceed' | 'cancel'
export type Pending = { view: HoldView; decision: Decision | null }

// The calls being held, in order; the first is the one shown. Module state:
// a reload drops the module and with it every hook that waits here.
export const pending: Pending[] = []

/** A press on Proceed or Cancel, for the hold drawn with this id. */
export function decide(id: string, decision: Decision): void {
  const p = pending.find(x => x.view.id === id)
  if (p && p.decision === null) p.decision = decision
}

export const paneRows = (view: HoldView): number =>
  Math.min(28, 14 + view.rules.length + view.affects.lines.length + (view.affects.more ? 1 : 0) + Math.ceil(view.command.length / 70))

const WHY: Record<HoldOutcome, string> = {
  waiting: 'it is still waiting',
  proceeded: 'it was allowed',
  cancelled: 'the user pressed Cancel',
  timeout: 'nobody answered within 10 minutes',
  interrupted: 'the turn was interrupted',
  'no-one': 'this is a non-interactive run, so nobody could approve it',
  error: 'Code Buddy hit an error while holding it',
}

export function refusal(outcome: HoldOutcome, found: Finding): string {
  return `Code Buddy held this call and did not run it: ${WHY[outcome]}. Rule: ${found.rules.join('; ')}. It would: ${found.affects.summary}. Do not retry it unless the user asks you to.`
}

export const OUTCOME_LABEL: Record<HoldOutcome, string> = {
  waiting: 'waiting',
  proceeded: 'proceeded',
  cancelled: 'cancelled',
  timeout: 'refused: no answer in 10 min',
  interrupted: 'refused: turn interrupted',
  'no-one': 'refused: non-interactive',
  error: 'refused: error',
}

// ---- Drawing ---------------------------------------------------------------
// The desktop gets brand SVG rows (theme.ts) with real Buttons beside them; a
// terminal gets the same hierarchy in coloured text.

type Ui = ReturnType<EngineInterface['ui']['resolve']>
type Surface = 'terminal' | 'desktop' | 'mobile' | 'vscode'

const subtitleOf = (view: HoldView): string => {
  const blast = view.rules.some(r => r.startsWith('destructive'))
  const guard = view.rules.some(r => !r.startsWith('destructive'))
  return `Code Buddy · ${[guard ? 'staging guard' : '', blast ? 'blast radius' : ''].filter(Boolean).join(' + ')} · needs your OK`
}

const titleOf = (view: HoldView): string => `Holding a ${view.tool} call${view.isSubagent ? ' from a subagent' : ''}`

/** The hold pane: header, rules, command, what it would affect, Proceed and Cancel. */
export function drawHold(ui: Ui, surface: Surface, view: HoldView, behind: number, columns: number) {
  const { Box, Text, Button, Code } = ui
  const a = view.affects
  const buttons = (
    <Box key="buttons" flexDirection="row" gap={2} marginTop={1}>
      <Button key="proceed" label="Proceed" hotkey="1" onPress={() => decide(view.id, 'proceed')} />
      <Button key="cancel" label="Cancel" hotkey="2" variant="primary" autoFocus onPress={() => decide(view.id, 'cancel')} />
    </Box>
  )
  const footer = (
    <Text key="footer" dimColor>
      Refused automatically after 10 minutes without an answer.
    </Text>
  )
  const lines = a.lines.length > 0 ? `${a.lines.join('\n')}${a.more > 0 ? `\n+ ${a.more} more` : ''}` : ''

  if (surface === 'desktop' && 'Svg' in ui) {
    const { Svg } = ui
    const W = pxOf(columns, 16, 260)
    const chips = chipsSvg(W, view.rules)
    return (
      <Box flexDirection="column" gap={1}>
        <Svg key="head" source={holdHeaderSvg(W, titleOf(view), subtitleOf(view), behind)} alt={`${titleOf(view)}. ${subtitleOf(view)}`} width={W} height={HEADER_H} />
        <Svg key="rules" source={chips.source} alt={`Rule: ${view.rules.join('; ')}`} width={W} height={chips.height} />
        <Svg key="l-cmd" source={labelSvg(W, 'Command')} alt="Command" width={W} height={18} />
        <Code key="cmd" source={view.command} language={view.tool === 'Bash' ? 'bash' : 'text'} wrap="wrap" />
        <Svg key="l-would" source={labelSvg(W, 'Would')} alt="Would" width={W} height={18} />
        <Text key="sum" bold color={BRAND.coral} wrap="wrap">
          {a.summary}
        </Text>
        {lines !== '' && <Code key="lines" source={lines} language="text" wrap="truncate-end" />}
        {a.note !== '' && (
          <Text key="note" dimColor italic wrap="wrap">
            {a.note}
          </Text>
        )}
        {buttons}
        {footer}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text key="head" wrap="truncate-end">
        <Text backgroundColor={BRAND.royal} color={BRAND.white} bold>
          {' ⏸ CODE BUDDY '}
        </Text>
        <Text bold color={BRAND.sky}>
          {`  ${titleOf(view)}`}
        </Text>
        <Text dimColor>{behind > 0 ? `  · ${behind} more waiting` : ''}</Text>
      </Text>
      <Text key="sub" dimColor wrap="truncate-end">
        {subtitleOf(view).replace('Code Buddy · ', '')}
      </Text>
      <Box key="rules" flexDirection="column" marginTop={1}>
        {view.rules.map((r, i) => (
          <Text key={`rule${i}`} wrap="wrap">
            <Text color={BRAND.coral}>{'● '}</Text>
            <Text bold>{r}</Text>
          </Text>
        ))}
      </Box>
      <Text key="l-cmd" bold color={BRAND.sky}>
        {'\nCOMMAND'}
      </Text>
      <Code key="cmd" source={view.command} language={view.tool === 'Bash' ? 'bash' : 'text'} wrap="wrap" />
      <Text key="l-would" bold color={BRAND.sky}>
        {'\nWOULD'}
      </Text>
      <Text key="sum" bold color={BRAND.coral} wrap="wrap">
        {a.summary}
      </Text>
      {a.lines.map((l, i) => (
        <Text key={`l${i}`} wrap="truncate-end">
          <Text color={BRAND.blue}>{'  │ '}</Text>
          {l}
        </Text>
      ))}
      {a.more > 0 && <Text key="more" dimColor>{`  │ + ${a.more} more`}</Text>}
      {a.note !== '' && (
        <Text key="note" dimColor italic wrap="wrap">
          {a.note}
        </Text>
      )}
      {buttons}
      {footer}
    </Box>
  )
}

/** The band while a call waits: alert badge, the rule, the command, the buttons. */
export function drawHoldBand(ui: Ui, surface: Surface, view: HoldView, behind: number, columns: number) {
  const { Box, Text, Button } = ui
  const rule = view.rules[0] ?? 'held'
  const proceed = <Button key="band-proceed" label="Proceed" hotkey="1" onPress={() => decide(view.id, 'proceed')} />
  const cancel = <Button key="band-cancel" label="Cancel" hotkey="2" variant="primary" autoFocus onPress={() => decide(view.id, 'cancel')} />
  if (surface === 'desktop' && 'Svg' in ui) {
    const { Svg } = ui
    const W = pxOf(columns, 210, 200)
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Svg key="held" source={holdBandSvg(W, rule, view.command, behind)} alt={`Held${behind > 0 ? ` +${behind}` : ''}: ${rule}. ${view.command}`} width={W} height={24} />
        {proceed}
        {cancel}
      </Box>
    )
  }
  const room = Math.max(10, columns - rule.length - 40)
  return (
    <Box flexDirection="row" gap={1}>
      <Text backgroundColor={BRAND.coral} color={BRAND.white} bold>
        {` ⏸ HELD${behind > 0 ? ` +${behind}` : ''} `}
      </Text>
      <Text bold wrap="truncate-end">
        {rule}
      </Text>
      <Text dimColor wrap="truncate-end">
        {view.command.length > room ? `${view.command.slice(0, room - 1)}…` : view.command}
      </Text>
      {proceed}
      {cancel}
    </Box>
  )
}

/** The idle band: the brand badge, guard state, how many calls were held. */
export function drawIdleBand(ui: Ui, surface: Surface, isOn: boolean, held: number, columns: number, overBudget = '') {
  const { Text } = ui
  const words = `Code Buddy · guard ${isOn ? 'on' : 'off'} · ${held} held`
  if (surface === 'desktop' && 'Svg' in ui) {
    const { Svg } = ui
    const W = Math.min(pxOf(columns, 0, 200), overBudget ? 520 : 360)
    return <Svg key="idle" source={idleBandSvg(W, isOn, held, overBudget)} alt={overBudget ? `${words} · ${overBudget}` : words} width={W} height={24} />
  }
  return (
    <Text wrap="truncate-end">
      <Text backgroundColor={BRAND.royal} color={BRAND.white} bold>
        {' ≋ Code Buddy '}
      </Text>
      <Text color={isOn ? BRAND.sky : undefined} dimColor={!isOn}>
        {isOn ? '  ● guard on' : '  ○ guard off'}
      </Text>
      <Text dimColor>{`  ·  ${held} held`}</Text>
      {overBudget ? <Text color={BRAND.coral} bold>{`  ·  ${overBudget}`}</Text> : null}
    </Text>
  )
}
