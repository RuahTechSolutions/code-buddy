// Feature 5, the control panel: pause, resume, or switch off each feature, and
// change the settings, from one pane. Drawing only: register.tsx owns the
// pauses and writes the settings.

import type { EngineInterface } from 'claude-code'

import { FEATURES } from './features'
import type { Feature } from './features'
import { BRAND, CONTROL_HEADER_H, GREEN, controlHeaderSvg, featureRowSvg, labelSvg, pxOf } from './theme'
import type { FeatureState } from './theme'

export const CONTROL_PANE = 'code-buddy-control'

type Ui = ReturnType<EngineInterface['ui']['resolve']>
type Surface = 'terminal' | 'desktop' | 'mobile' | 'vscode'

export const PAUSE_SHORT_MS = 30 * 60 * 1000

export type ControlView = {
  version: string
  held: number
  features: { id: Feature; state: FeatureState; left: string }[]
  settings: { production: string; staging: string; branch: string; budget: string; autoOpen: boolean }
}

export type SettingField = 'production' | 'staging' | 'branch' | 'budget'

export type ControlActions = {
  pause: (f: Feature | 'all', ms: number) => void
  resume: (f: Feature | 'all') => void
  setOn: (f: Feature, on: boolean) => void
  set: (field: SettingField, value: string) => void
  setAutoOpen: (on: boolean) => void
}

export const controlRows = (): number => 40

const SETTING_FIELDS: { field: SettingField; label: string; placeholder: string; hint: string }[] = [
  { field: 'production', label: 'Production domains', placeholder: 'example.com, *.example.com', hint: 'Calls that target one are held. *.example.com matches every subdomain.' },
  { field: 'staging', label: 'Staging domains', placeholder: 'staging.example.com', hint: 'Production wins on overlap: only an exact host listed here goes through.' },
  { field: 'branch', label: 'Protected branch', placeholder: 'main', hint: 'Pushes to it and merges into it are held. Comma-separated; * matches within a name.' },
  { field: 'budget', label: 'Subagent budget (USD)', placeholder: 'off', hint: 'Estimated subagent spend per session; past it the agents bar turns coral. 0 or off turns it off.' },
]

export function summaryOf(v: ControlView): string {
  const on = v.features.filter(f => f.state === 'on').length
  const paused = v.features.filter(f => f.state === 'paused').length
  return `${on} of ${v.features.length} features on${paused ? ` · ${paused} paused` : ''} · ${v.held} held this session`
}

/** The control panel: features with Pause / Resume / Turn off, then the settings. */
export function drawControl(ui: Ui, surface: Surface, v: ControlView, columns: number, act: ControlActions) {
  const { Box, Text, Button } = ui
  const isDesktop = surface === 'desktop' && 'Svg' in ui
  const W = pxOf(columns, 16, 260)
  const label = (key: string, text: string) =>
    isDesktop && 'Svg' in ui ? (
      <ui.Svg key={key} source={labelSvg(W, text)} alt={text} width={W} height={18} />
    ) : (
      <Text key={key} bold color={BRAND.sky}>{`\n${text.toUpperCase()}`}</Text>
    )
  const anyPaused = v.features.some(f => f.state === 'paused')

  const featureRows = v.features.map(f => {
    const meta = FEATURES.find(x => x.id === f.id)
    const name = meta?.name ?? f.id
    const what = meta?.what ?? ''
    const buttons =
      f.state === 'on' ? (
        <Box key={`b-${f.id}`} flexDirection="row" gap={1}>
          <Button key={`pause30-${f.id}`} label="Pause 30m" onPress={() => act.pause(f.id, PAUSE_SHORT_MS)} />
          <Button key={`pause-${f.id}`} label="Pause" onPress={() => act.pause(f.id, 0)} />
          <Button key={`off-${f.id}`} label="Turn off" plain onPress={() => act.setOn(f.id, false)} />
        </Box>
      ) : f.state === 'paused' ? (
        <Box key={`b-${f.id}`} flexDirection="row" gap={1}>
          <Button key={`resume-${f.id}`} label="Resume" variant="primary" onPress={() => act.resume(f.id)} />
        </Box>
      ) : (
        <Box key={`b-${f.id}`} flexDirection="row" gap={1}>
          <Button key={`on-${f.id}`} label="Turn on" variant="primary" onPress={() => act.setOn(f.id, true)} />
        </Box>
      )
    if (isDesktop && 'Svg' in ui) {
      const row = featureRowSvg(W, name, what, f.state, f.left)
      const alt = `${name}: ${f.state === 'paused' ? `paused, ${f.left}` : f.state}. ${what}`
      return (
        <Box key={`f-${f.id}`} flexDirection="column" gap={1}>
          <ui.Svg key={`s-${f.id}`} source={row.source} alt={alt} width={W} height={row.height} />
          {buttons}
        </Box>
      )
    }
    const color = f.state === 'on' ? GREEN : f.state === 'off' ? undefined : BRAND.coral
    const chip = f.state === 'on' ? 'on' : f.state === 'off' ? 'off' : `paused · ${f.left}`
    return (
      <Box key={`f-${f.id}`} flexDirection="column" marginBottom={1}>
        <Text wrap="truncate-end">
          <Text bold>{name}</Text>
          <Text color={color} dimColor={f.state === 'off'} bold>{`  ● ${chip}`}</Text>
        </Text>
        <Text dimColor wrap="wrap">{what}</Text>
        {buttons}
      </Box>
    )
  })

  const hasInput = 'Input' in ui
  const settingRows = SETTING_FIELDS.map(s => {
    const value = v.settings[s.field]
    if (hasInput && 'Input' in ui) {
      return (
        <Box key={`set-${s.field}`} flexDirection="column">
          <ui.Input key={`in-${s.field}`} label={s.label} placeholder={s.placeholder} value={value} submitLabel="save" onSubmit={text => act.set(s.field, text)} />
          <Text dimColor wrap="wrap">{s.hint}</Text>
        </Box>
      )
    }
    return (
      <Text key={`set-${s.field}`} wrap="wrap">
        <Text bold>{`${s.label}: `}</Text>
        <Text>{value || '(none)'}</Text>
      </Text>
    )
  })

  return (
    <Box flexDirection="column" gap={isDesktop ? 1 : 0} paddingX={isDesktop ? 0 : 1}>
      {isDesktop && 'Svg' in ui ? (
        <ui.Svg key="head" source={controlHeaderSvg(W, v.version, summaryOf(v))} alt={`Code Buddy ${v.version}: ${summaryOf(v)}`} width={W} height={CONTROL_HEADER_H} />
      ) : (
        <Text key="head" wrap="wrap">
          <Text backgroundColor={BRAND.royal} color={BRAND.white} bold>{' ≋ CODE BUDDY '}</Text>
          <Text dimColor>{`  ${v.version ? `v${v.version} · ` : ''}${summaryOf(v)}`}</Text>
        </Text>
      )}
      <Box key="all" flexDirection="row" gap={1}>
        <Button key="pause30-all" label="Pause all 30m" onPress={() => act.pause('all', PAUSE_SHORT_MS)} />
        {anyPaused && <Button key="resume-all" label="Resume all" variant="primary" onPress={() => act.resume('all')} />}
      </Box>

      {label('l-features', 'Features')}
      {featureRows}
      <Text key="pause-note" dimColor italic wrap="wrap">
        Pauses last for this session only. Turn off keeps a feature off in every session until you turn it on again.
      </Text>

      {label('l-settings', 'Settings')}
      {settingRows}
      <Box key="autoopen" flexDirection="row" gap={1}>
        <Text>{`Auto-open agents panel: ${v.settings.autoOpen ? 'on' : 'off'}`}</Text>
        <Button key="autoopen-toggle" label={v.settings.autoOpen ? 'Turn off' : 'Turn on'} plain onPress={() => act.setAutoOpen(!v.settings.autoOpen)} />
      </Box>
      <Text key="settings-note" dimColor italic wrap="wrap">
        {hasInput
          ? 'Edit a field and press Enter to save. Settings apply to every session; Code Buddy reloads with them.'
          : 'Change settings with /code-buddy config <setting> <value>.'}
      </Text>
    </Box>
  )
}
