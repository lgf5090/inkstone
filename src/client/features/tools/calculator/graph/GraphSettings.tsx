import { Input, Segmented } from '../../../../components/form'
import { Button } from '../../../../components/primitives'
import { Modal } from '../../../../components/overlay'
import { GRAPH_DEFAULT_VIEWPORT } from '@shared/tools/calculator/contract'
import type { GraphViewport, TrigMode } from '@shared/tools/calculator/types'
import { calcT } from '../lib/calc-i18n'

export function GraphSettings({
  open,
  viewport,
  trigMode,
  lineWidth,
  theme,
  onViewportChange,
  onTrigModeChange,
  onLineWidthChange,
  onThemeChange,
  onClose,
}: {
  open: boolean
  viewport: GraphViewport
  trigMode: TrigMode
  lineWidth: number
  theme: 'light' | 'match_app'
  onViewportChange: (viewport: GraphViewport) => void
  onTrigModeChange: (mode: TrigMode) => void
  onLineWidthChange: (width: number) => void
  onThemeChange: (theme: 'light' | 'match_app') => void
  onClose: () => void
}) {
  const bound = (key: keyof GraphViewport) => (
    <label className="space-y-1">
      <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{calcT(`tools.calculator.graph.${key === 'xMin' ? 'x_min' : key === 'xMax' ? 'x_max' : key === 'yMin' ? 'y_min' : 'y_max'}`)}</span>
      <Input
        type="number"
        value={String(viewport[key])}
        aria-label={calcT(`tools.calculator.graph.${key === 'xMin' ? 'x_min' : key === 'xMax' ? 'x_max' : key === 'yMin' ? 'y_min' : 'y_max'}`)}
        className="h-8 font-mono text-[length:var(--text-12)] md:h-8"
        onChange={(event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value)) onViewportChange({ ...viewport, [key]: value })
        }}
      />
    </label>
  )
  return (
    <Modal open={open} onClose={onClose} title={calcT('tools.calculator.graph.settings')} width={460}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {bound('xMin')}
          {bound('xMax')}
          {bound('yMin')}
          {bound('yMax')}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{calcT('tools.calculator.graph.trig_mode')}</span>
          <Segmented
            value={trigMode}
            onChange={onTrigModeChange}
            size="sm"
            label={calcT('tools.calculator.graph.trig_mode')}
            options={[
              { value: 'rad', label: calcT('tools.calculator.graph.radians') },
              { value: 'deg', label: calcT('tools.calculator.graph.degrees') },
              { value: 'grad', label: calcT('tools.calculator.graph.gradians') },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{calcT('tools.calculator.graph.line_width')}</span>
          <Segmented
            value={String(lineWidth)}
            onChange={(value) => onLineWidthChange(Number(value))}
            size="sm"
            label={calcT('tools.calculator.graph.line_width')}
            options={[1, 2, 3, 4].map((width) => ({ value: String(width), label: String(width) }))}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{calcT('tools.calculator.graph.theme')}</span>
          <Segmented
            value={theme}
            onChange={onThemeChange}
            size="sm"
            label={calcT('tools.calculator.graph.theme')}
            options={[
              { value: 'match_app', label: calcT('tools.calculator.graph.theme_match') },
              { value: 'light', label: calcT('tools.calculator.graph.theme_light') },
            ]}
          />
        </div>
        <Button size="sm" variant="secondary" onClick={() => onViewportChange({ ...GRAPH_DEFAULT_VIEWPORT })}>
          {calcT('tools.calculator.graph.reset_view')}
        </Button>
      </div>
    </Modal>
  )
}
