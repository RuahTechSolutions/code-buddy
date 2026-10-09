// Feature 3, Replay: the pane that steps through the last turn's edits with
// Prev, Next and Close, and the band's hint. Drawing only: register.tsx owns
// the state and hands in what the buttons do.
//
// The stepper follows replay-theater (claude-code-playground, Copyright 2026
// Anthropic PBC, Apache-2.0): a strip of steps, one diff at a time, Prev /
// Next / Close with hotkeys p, n and c. See NOTICE.

import type { EngineInterface } from 'claude-code'

import type { Replay } from '../types'
import { BAND_ROW_H, BRAND, GREEN, REPLAY_HEADER_H, fileRowSvg, pxOf, replayBandSvg, replayHeaderSvg } from './theme'

export const REPLAY_PANE = 'code-buddy-replay'

type Ui = ReturnType<EngineInterface['ui']['resolve']>
type Surface = 'terminal' | 'desktop' | 'mobile' | 'vscode'

export type ReplayActions = { go: (index: number) => void; close: () => void }

export const filesOf = (r: Replay): number => new Set(r.steps.map(s => s.file)).size

export const replayRows = (r: Replay): number =>
  Math.min(32, 9 + Math.max(...r.steps.map(s => s.diff.split('\n').length), 1))

const countText = (r: Replay): string => {
  const n = r.steps.length
  const f = filesOf(r)
  return `${n} ${n === 1 ? 'edit' : 'edits'} in ${f} ${f === 1 ? 'file' : 'files'}`
}

/** The replay pane: one step at a time. */
export function drawReplay(ui: Ui, surface: Surface, r: Replay, columns: number, act: ReplayActions) {
  const { Box, Text, Button, Code } = ui
  const total = r.steps.length
  const k = Math.max(0, Math.min(r.index, total - 1))
  const step = r.steps[k]
  if (step === undefined) return <Text dimColor>No edits to replay.</Text>
  const meta = `${step.tool}${step.isNew ? ' · new file' : ''}${step.note ? ` · ${step.note}` : ''}`
  const diff =
    step.diff === '' ? (
      <Text key="diff" dimColor>
        (no line changes)
      </Text>
    ) : (
      <Code key="diff" source={step.diff} format="diff" path={step.file} wrap="truncate-end" />
    )
  const buttons = (
    <Box key="buttons" flexDirection="row" gap={2} marginTop={1}>
      <Button key="prev" label="◀ Prev" hotkey="p" onPress={() => act.go(k - 1)} />
      <Button key="next" label="Next ▶" hotkey="n" variant="primary" autoFocus onPress={() => act.go(k + 1)} />
      <Button key="close" label="Close" hotkey="c" onPress={() => act.close()} />
    </Box>
  )

  if (surface === 'desktop' && 'Svg' in ui) {
    const { Svg } = ui
    const W = pxOf(columns, 16, 260)
    return (
      <Box flexDirection="column" gap={1}>
        <Svg key="head" source={replayHeaderSvg(W, k, total, filesOf(r))} alt={`Replay, step ${k + 1} of ${total}. ${countText(r)}.`} width={W} height={REPLAY_HEADER_H} />
        <Svg key="file" source={fileRowSvg(W, step.file, meta, step.adds, step.dels)} alt={`${step.file}: ${meta}, ${step.adds} added, ${step.dels} removed`} width={W} height={34} />
        {diff}
        {buttons}
      </Box>
    )
  }

  const strip = r.steps.map((_, i) => (i === k ? '●' : i < k ? '•' : '·')).join(' ')
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text key="head" wrap="truncate-end">
        <Text backgroundColor={BRAND.royal} color={BRAND.white} bold>
          {' ▶ REPLAY '}
        </Text>
        <Text bold color={BRAND.sky}>{`  step ${k + 1} of ${total}`}</Text>
        <Text dimColor>{`  ·  ${countText(r)}`}</Text>
      </Text>
      <Text key="strip" color={BRAND.sky} wrap="truncate-end">
        {strip}
      </Text>
      <Text key="file" bold wrap="truncate-start">
        {`\n${step.file}`}
      </Text>
      <Text key="meta" wrap="truncate-end">
        <Text dimColor>{`${meta}   `}</Text>
        <Text color={GREEN} bold>{`+${step.adds}`}</Text>
        <Text>{' '}</Text>
        <Text color={BRAND.coral} bold>{`−${step.dels}`}</Text>
      </Text>
      {diff}
      {buttons}
    </Box>
  )
}

/** The band's hint after a turn with edits. */
export function drawReplayBand(ui: Ui, surface: Surface, r: Replay, columns: number, open: () => void) {
  const { Box, Text, Button } = ui
  const button = <Button key="open-replay" label="Replay" hotkey="r" variant="primary" onPress={open} />
  if (surface === 'desktop' && 'Svg' in ui) {
    const { Svg } = ui
    const W = Math.min(pxOf(columns, 110, 200), 460)
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Svg key="hint" source={replayBandSvg(W, r.steps.length, filesOf(r))} alt={`Replay ready: ${countText(r)}`} width={W} height={BAND_ROW_H} />
        {button}
      </Box>
    )
  }
  return (
    <Box flexDirection="row" gap={1}>
      <Text wrap="truncate-end">
        <Text backgroundColor={BRAND.royal} color={BRAND.white} bold>
          {' ≋ Code Buddy '}
        </Text>
        <Text bold color={BRAND.sky}>{'  ▶ Replay ready'}</Text>
        <Text dimColor>{`  ·  ${countText(r)}`}</Text>
      </Text>
      {button}
    </Box>
  )
}
