import { Plus, Trash2 } from 'lucide-react'
import { GRAPH_COLORS, GRAPH_LINE_STYLES, MAX_EQUATIONS } from '@shared/tools/calculator/contract'
import type { GraphEquation, GraphLineStyle } from '@shared/tools/calculator/types'
import { Input, Switch } from '../../../../components/form'
import { Button, IconButton } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { calcT } from '../lib/calc-i18n'
import { isImeComposing } from '../../../../lib/ime'

export function EquationList({
  equations,
  errors,
  onAdd,
  onUpdate,
  onRemove,
  onAnalyze,
}: {
  equations: GraphEquation[]
  errors: Record<string, string>
  onAdd: () => void
  onUpdate: (id: string, patch: Partial<GraphEquation>) => void
  onRemove: (id: string) => void
  onAnalyze: (equation: GraphEquation) => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{calcT('tools.calculator.graph.equations')}</h2>
        <Button size="sm" variant="ghost" icon={<Plus size={13} />} disabled={equations.length >= MAX_EQUATIONS} onClick={onAdd}>
          {calcT('tools.calculator.graph.add_equation')}
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {equations.map((equation, index) => {
          const error = errors[equation.id]
          return (
            <div key={equation.id} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2">
              <div className="flex items-center gap-1.5">
                <span className="w-5 shrink-0 text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)]">{`f${index + 1}`}</span>
                <Input
                  value={equation.expression}
                  placeholder={calcT('tools.calculator.graph.equation_placeholder')}
                  aria-label={`f${index + 1}`}
                  invalid={Boolean(error)}
                  onChange={(event) => onUpdate(equation.id, { expression: event.target.value })}
                  onKeyDown={(event) => {
                    if (isImeComposing(event)) return
                    if (event.key === 'Enter' && index === equations.length - 1) onAdd()
                  }}
                  className="h-8 min-w-0 flex-1 font-mono text-[length:var(--text-13)] md:h-8"
                />
                <IconButton label={calcT('tools.calculator.common.remove')} size="sm" onClick={() => onRemove(equation.id)}>
                  <Trash2 size={13} />
                </IconButton>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6">
                <SelectMenu
                  label={calcT('tools.calculator.graph.color')}
                  value={String(equation.colorIndex)}
                  size="sm"
                  width={170}
                  onChange={(value) => onUpdate(equation.id, { colorIndex: Number(value) })}
                  options={GRAPH_COLORS.map((color, colorIndex) => ({
                    value: String(colorIndex),
                    label: `${calcT('tools.calculator.graph.color')} ${colorIndex + 1}`,
                    icon: <span className="size-3 rounded-full border border-black/10" style={{ backgroundColor: color }} />,
                  }))}
                />
                <SelectMenu
                  label={calcT('tools.calculator.graph.line_style')}
                  value={equation.lineStyle}
                  size="sm"
                  width={160}
                  onChange={(value) => onUpdate(equation.id, { lineStyle: value as GraphLineStyle })}
                  options={GRAPH_LINE_STYLES.map((style) => ({ value: style, label: calcT(`tools.calculator.graph.${style}`) }))}
                />
                <span className="inline-flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  <Switch
                    checked={equation.isEnabled}
                    onChange={(checked) => onUpdate(equation.id, { isEnabled: checked })}
                    label={calcT(equation.isEnabled ? 'tools.calculator.graph.disable' : 'tools.calculator.graph.enable')}
                  />
                  {calcT('tools.calculator.graph.enable')}
                </span>
                <Button size="sm" variant="secondary" icon={<span aria-hidden="true">{'ƒ'}</span>} onClick={() => onAnalyze(equation)}>
                  {calcT('tools.calculator.graph.analyze')}
                </Button>
              </div>
              {error && <p className="mt-1 pl-6 text-[length:var(--text-11)] text-[var(--danger)]">{error}</p>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
