/** A labelled switch on a bordered row, the shape both settings panels use. */
import type { ReactNode } from 'react'
import { Switch } from '../../../../components/form'

export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint?: ReactNode
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-2">
      <div className="min-w-0">
        <p className="text-[length:var(--text-12-5)] text-[var(--text-primary)]">{label}</p>
        {hint && <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{hint}</p>}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  )
}
