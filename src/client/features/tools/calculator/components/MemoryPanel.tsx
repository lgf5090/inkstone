import { Trash2, X } from 'lucide-react'
import { IconButton } from '../../../../components/primitives'
import { Tooltip, confirm } from '../../../../components/overlay'
import { calcT } from '../lib/calc-i18n'

export function MemoryPanel({
  values,
  onRecall,
  onAdd,
  onSubtract,
  onClearItem,
  onClearAll,
  onClose,
}: {
  values: string[]
  onRecall: (index: number) => void
  onAdd: (index: number) => void
  onSubtract: (index: number) => void
  onClearItem: (index: number) => void
  onClearAll: () => void
  onClose?: () => void
}) {
  return (
    <section aria-label={calcT('tools.calculator.a11y.memory_list')} className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3">
        <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {calcT('tools.calculator.common.memory')}
        </h2>
        <div className="flex items-center gap-1">
          {values.length > 0 && (
            <button
              type="button"
              className="rounded-[var(--r-sm)] px-2 py-1 text-[length:var(--text-12)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              onClick={async () => {
                if (await confirm({
                  title: calcT('tools.calculator.settings.clear_memory'),
                  confirmLabel: calcT('tools.calculator.common.clear'),
                  cancelLabel: calcT('tools.calculator.common.cancel'),
                  tone: 'danger',
                })) onClearAll()
              }}
            >
              {calcT('tools.calculator.common.clear')}
            </button>
          )}
          {onClose && (
            <Tooltip label={calcT('tools.calculator.common.close')}>
              <IconButton label={calcT('tools.calculator.common.close')} size="sm" onClick={onClose}>
                <X size={14} />
              </IconButton>
            </Tooltip>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {values.length === 0 ? (
          <p className="px-2 py-8 text-center text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">
            {calcT('tools.calculator.common.empty')}
          </p>
        ) : (
          <ul className="space-y-1">
            {values.map((value, index) => (
              <li key={`${value}-${index}`} className="group flex items-center gap-1 rounded-[var(--r-sm)] hover:bg-[var(--bg-hover)]">
                <button
                  type="button"
                  onClick={() => onRecall(index)}
                  className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-[length:var(--text-15)] font-semibold tabular-nums text-[var(--text-primary)]"
                >
                  {value}
                </button>
                <button type="button" aria-label={calcT('tools.calculator.common.memory_add')} onClick={() => onAdd(index)} className="rounded-[var(--r-xs)] px-1 text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]">{'M+'}</button>
                <button type="button" aria-label={calcT('tools.calculator.common.memory_subtract')} onClick={() => onSubtract(index)} className="rounded-[var(--r-xs)] px-1 text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]">{'M−'}</button>
                <IconButton label={calcT('tools.calculator.common.delete')} size="xs" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => onClearItem(index)}>
                  <Trash2 size={12} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
