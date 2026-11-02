import { Input, Slider } from '../../../../components/form'
import type { GraphVariable } from '@shared/tools/calculator/types'
import { calcT } from '../lib/calc-i18n'

export function VariablePanel({
  variables,
  onChange,
}: {
  variables: GraphVariable[]
  onChange: (name: string, patch: Partial<GraphVariable>) => void
}) {
  if (variables.length === 0) return null
  return (
    <section aria-label={calcT('tools.calculator.graph.variables')} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2">
      <h2 className="mb-1.5 text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{calcT('tools.calculator.graph.variables')}</h2>
      <div className="space-y-1.5">
        {variables.map((variable) => (
          <div key={variable.name} className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="w-5 shrink-0 font-mono text-[length:var(--text-13)] font-semibold text-[var(--accent-on-soft)]">{variable.name}</span>
              <Slider
                value={variable.value}
                min={variable.min}
                max={variable.max}
                step={variable.step}
                label={calcT('tools.calculator.graph.variable', { name: variable.name })}
                immediate
                onChange={(value) => onChange(variable.name, { value })}
                className="min-w-0 flex-1"
              />
              <Input
                type="number"
                value={String(variable.value)}
                aria-label={calcT('tools.calculator.graph.value')}
                className="h-7 w-20 text-right text-[length:var(--text-12)] md:h-7"
                onChange={(event) => {
                  const value = Number(event.target.value)
                  if (Number.isFinite(value)) onChange(variable.name, { value })
                }}
              />
            </div>
            <details className="pl-7">
              <summary className="cursor-pointer text-[length:var(--text-11)] text-[var(--text-tertiary)]">{calcT('tools.calculator.graph.settings')}</summary>
              <div className="mt-1 grid grid-cols-3 gap-1.5">
                {(['min', 'max', 'step'] as const).map((key) => (
                  <label key={key} className="space-y-0.5">
                    <span className="block text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{calcT(`tools.calculator.graph.${key}`)}</span>
                    <Input
                      type="number"
                      value={String(variable[key])}
                      aria-label={calcT(`tools.calculator.graph.${key}`)}
                      className="h-7 text-[length:var(--text-12)] md:h-7"
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        if (Number.isFinite(value)) onChange(variable.name, { [key]: value })
                      }}
                    />
                  </label>
                ))}
              </div>
            </details>
          </div>
        ))}
      </div>
    </section>
  )
}
