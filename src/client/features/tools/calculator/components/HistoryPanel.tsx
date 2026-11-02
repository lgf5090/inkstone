import { Trash2, X } from 'lucide-react'
import type { HistoryEntry } from '@shared/tools/calculator/types'
import { IconButton } from '../../../../components/primitives'
import { Tooltip, confirm } from '../../../../components/overlay'
import { calcT } from '../lib/calc-i18n'

export function HistoryPanel({
  entries,
  onRecall,
  onDelete,
  onClear,
  onClose,
}: {
  entries: HistoryEntry[]
  onRecall: (index: number) => void
  onDelete: (id: string) => void
  onClear: () => void
  onClose?: () => void
}) {
  return (
    <section aria-label={calcT('tools.calculator.a11y.history_list')} className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3">
        <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {calcT('tools.calculator.common.history')}
        </h2>
        <div className="flex items-center gap-1">
          {entries.length > 0 && (
            <button
              type="button"
              className="rounded-[var(--r-sm)] px-2 py-1 text-[length:var(--text-12)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              onClick={async () => {
                if (await confirm({
                  title: calcT('tools.calculator.settings.clear_history'),
                  confirmLabel: calcT('tools.calculator.common.clear'),
                  cancelLabel: calcT('tools.calculator.common.cancel'),
                  tone: 'danger',
                })) onClear()
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
        {entries.length === 0 ? (
          <p className="px-2 py-8 text-center text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">
            {calcT('tools.calculator.common.empty')}
          </p>
        ) : (
          <ul className="space-y-1">
            {entries.map((entry, index) => (
              <li key={entry.id} className="group flex items-start gap-1 rounded-[var(--r-sm)] hover:bg-[var(--bg-hover)]">
                <button
                  type="button"
                  onClick={() => onRecall(index)}
                  className="min-w-0 flex-1 px-2 py-1.5 text-left"
                >
                  <span className="block truncate text-[length:var(--text-12)] text-[var(--text-tertiary)]">{entry.expression}</span>
                  <span className="block truncate text-[length:var(--text-16)] font-semibold tabular-nums text-[var(--text-primary)]">{entry.result}</span>
                </button>
                <IconButton
                  label={calcT('tools.calculator.common.delete')}
                  size="xs"
                  className="mt-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => onDelete(entry.id)}
                >
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
