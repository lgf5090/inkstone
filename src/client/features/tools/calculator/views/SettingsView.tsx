import { useRef } from 'react'
import { Download, Upload } from 'lucide-react'
import { Segmented, Input } from '../../../../components/form'
import { Button } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { confirm } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'
import { BackupSchema } from '@shared/tools/calculator/schemas'
import { calcT } from '../lib/calc-i18n'
import { useCalculatorStore, getCalculatorEngine } from '../store'
import { calculatorApi } from '../api'
import { GRAPH_DEFAULT_VIEWPORT } from '@shared/tools/calculator/contract'

const VIEW_OPTIONS = ['standard', 'scientific', 'programmer', 'date', 'unit', 'currency', 'graph', 'kinship'] as const

export function SettingsView() {
  const settings = useCalculatorStore((state) => state.settings)
  const graph = useCalculatorStore((state) => state.graph)
  const display = useCalculatorStore((state) => state.display)
  const unitPreferences = useCalculatorStore((state) => state.unitPreferences)
  const updateSettings = useCalculatorStore((state) => state.updateSettings)
  const updateGraph = useCalculatorStore((state) => state.updateGraph)
  const clearHistory = useCalculatorStore((state) => state.clearHistory)
  const clearMemory = useCalculatorStore((state) => state.clearMemory)
  const importFileRef = useRef<HTMLInputElement>(null)

  const exportBackup = () => {
    const engine = getCalculatorEngine()
    const backup = {
      version: 1 as const,
      exportedAt: Date.now(),
      settings,
      history: engine?.getHistory() ?? display.history,
      memory: engine?.snapshot().memory ?? [],
      graph,
      unitPreferences,
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'inkstone-calculator-backup.json'
    anchor.click()
    URL.revokeObjectURL(url)
    useUi.getState().toast({ title: calcT('tools.calculator.settings.backup_exported'), tone: 'success' })
  }

  const importBackup = async (file: File) => {
    try {
      const text = await file.text()
      if (text.length > 2 * 1024 * 1024) throw new Error('too large')
      const parsed = BackupSchema.safeParse(JSON.parse(text))
      if (!parsed.success) throw new Error('invalid')
      const backup = parsed.data
      await calculatorApi.updateSettings(backup.settings)
      await calculatorApi.replaceMemory(backup.memory)
      await calculatorApi.updateGraph(backup.graph)
      await calculatorApi.replaceUnitPreferences(backup.unitPreferences)
      await calculatorApi.clearHistory()
      for (const entry of backup.history.slice(0, 40)) await calculatorApi.appendHistory(entry)
      await useCalculatorStore.getState().boot()
      useUi.getState().toast({ title: calcT('tools.calculator.settings.backup_imported'), tone: 'success' })
    } catch (error) {
      console.warn('[inkstone] Calculator backup import failed:', error instanceof Error ? error.message : error)
      useUi.getState().toast({ title: calcT('tools.calculator.settings.backup_invalid'), tone: 'danger' })
    }
  }

  const boundField = (key: 'graphXMin' | 'graphXMax' | 'graphYMin' | 'graphYMax') => (
    <label className="space-y-1">
      <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{calcT(`tools.calculator.graph.${key === 'graphXMin' ? 'x_min' : key === 'graphXMax' ? 'x_max' : key === 'graphYMin' ? 'y_min' : 'y_max'}`)}</span>
      <Input
        type="number"
        value={String(settings[key])}
        aria-label={calcT(`tools.calculator.graph.${key === 'graphXMin' ? 'x_min' : key === 'graphXMax' ? 'x_max' : key === 'graphYMin' ? 'y_min' : 'y_max'}`)}
        onChange={(event) => {
          const value = Number(event.target.value)
          if (!Number.isFinite(value)) return
          void updateSettings({ [key]: value })
          updateGraph({ viewport: { ...graph.viewport, [key === 'graphXMin' ? 'xMin' : key === 'graphXMax' ? 'xMax' : key === 'graphYMin' ? 'yMin' : 'yMax']: value } })
        }}
        className="h-8 font-mono text-[length:var(--text-12)] md:h-8"
      />
    </label>
  )

  return (
    <div className="flex h-full min-h-0 w-full justify-center overflow-y-auto p-3 sm:p-6">
      <div className="w-full max-w-[680px] space-y-5">
        <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">{calcT('tools.calculator.settings.title')}</h1>

        <section className="space-y-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-3 sm:p-4">
          <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{calcT('tools.calculator.settings.general')}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{calcT('tools.calculator.settings.default_view')}</span>
              <SelectMenu
                label={calcT('tools.calculator.settings.default_view')}
                value={settings.defaultView === 'settings' ? 'standard' : settings.defaultView}
                onChange={(value) => { void updateSettings({ defaultView: value }) }}
                options={VIEW_OPTIONS.map((view) => ({ value: view, label: calcT(`tools.calculator.nav.${view}`) }))}
              />
            </div>
            <div className="space-y-1">
              <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{calcT('tools.calculator.settings.angle_mode')}</span>
              <Segmented
                value={settings.angleMode}
                onChange={(value) => { void updateSettings({ angleMode: value }) }}
                size="sm"
                label={calcT('tools.calculator.settings.angle_mode')}
                options={[
                  { value: 'deg', label: 'DEG' },
                  { value: 'rad', label: 'RAD' },
                  { value: 'grad', label: 'GRAD' },
                ]}
              />
            </div>
          </div>
        </section>

        <section className="space-y-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-3 sm:p-4">
          <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{calcT('tools.calculator.settings.graph')}</h2>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{calcT('tools.calculator.settings.theme')}</span>
            <Segmented
              value={settings.graphTheme}
              onChange={(value) => { void updateSettings({ graphTheme: value }) }}
              size="sm"
              label={calcT('tools.calculator.settings.theme')}
              options={[
                { value: 'match_app', label: calcT('tools.calculator.graph.theme_match') },
                { value: 'light', label: calcT('tools.calculator.graph.theme_light') },
              ]}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{calcT('tools.calculator.settings.line_width')}</span>
            <Segmented
              value={String(settings.graphLineWidth)}
              onChange={(value) => { void updateSettings({ graphLineWidth: Number(value) }) }}
              size="sm"
              label={calcT('tools.calculator.settings.line_width')}
              options={[1, 2, 3, 4].map((width) => ({ value: String(width), label: String(width) }))}
            />
          </div>
          <div>
            <div className="mb-1 text-[length:var(--text-12)] text-[var(--text-secondary)]">{calcT('tools.calculator.settings.bounds')}</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {boundField('graphXMin')}
              {boundField('graphXMax')}
              {boundField('graphYMin')}
              {boundField('graphYMax')}
            </div>
            <Button size="sm" variant="ghost" className="mt-2" onClick={() => {
              void updateSettings({ graphXMin: GRAPH_DEFAULT_VIEWPORT.xMin, graphXMax: GRAPH_DEFAULT_VIEWPORT.xMax, graphYMin: GRAPH_DEFAULT_VIEWPORT.yMin, graphYMax: GRAPH_DEFAULT_VIEWPORT.yMax })
              updateGraph({ viewport: { ...GRAPH_DEFAULT_VIEWPORT } })
            }}>{calcT('tools.calculator.graph.reset_view')}</Button>
          </div>
        </section>

        <section className="space-y-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-3 sm:p-4">
          <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{calcT('tools.calculator.settings.data')}</h2>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={async () => {
              if (await confirm({ title: calcT('tools.calculator.settings.clear_history'), confirmLabel: calcT('tools.calculator.common.clear'), cancelLabel: calcT('tools.calculator.common.cancel'), tone: 'danger' })) await clearHistory()
            }}>{calcT('tools.calculator.settings.clear_history')}</Button>
            <Button size="sm" variant="secondary" onClick={async () => {
              if (await confirm({ title: calcT('tools.calculator.settings.clear_memory'), confirmLabel: calcT('tools.calculator.common.clear'), cancelLabel: calcT('tools.calculator.common.cancel'), tone: 'danger' })) clearMemory()
            }}>{calcT('tools.calculator.settings.clear_memory')}</Button>
            <Button size="sm" variant="secondary" icon={<Download size={13} />} onClick={exportBackup}>{calcT('tools.calculator.settings.export_backup')}</Button>
            <Button size="sm" variant="secondary" icon={<Upload size={13} />} onClick={() => importFileRef.current?.click()}>{calcT('tools.calculator.settings.import_backup')}</Button>
            <input
              ref={importFileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void importBackup(file)
              }}
            />
          </div>
          <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{calcT('tools.calculator.settings.storage')}</p>
        </section>

        <section className="space-y-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-3 sm:p-4">
          <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{calcT('tools.calculator.settings.about')}</h2>
          <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">{calcT('tools.calculator.settings.attribution')}</p>
          <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{`${calcT('tools.calculator.settings.version')}: 0.1.0`}</p>
        </section>
      </div>
    </div>
  )
}
