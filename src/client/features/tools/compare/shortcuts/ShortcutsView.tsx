/**
 * The keyboard map, kept as a screen rather than a tooltip: the shortcuts work on the whole text
 * comparison, and a reader who never opens it should still be able to find them.
 */
import { Keyboard } from 'lucide-react'
import { Kbd } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'

const ROWS: readonly { keys: string[], labelKey: string }[] = [
  { keys: ['F7'], labelKey: 'tools.compare.shortcuts.prev' },
  { keys: ['F8'], labelKey: 'tools.compare.shortcuts.next' },
  { keys: ['Ctrl', 'Shift', 'D'], labelKey: 'tools.compare.shortcuts.select_all' },
  { keys: ['Alt', 'N'], labelKey: 'tools.compare.shortcuts.fold' },
]

export function ShortcutsView() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-4 overflow-y-auto p-3 sm:p-4">
      <header>
        <h2 className="flex items-center gap-2 text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
          <Keyboard size={17} aria-hidden="true" />
          {t('tools.compare.shortcuts.title')}
        </h2>
        <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('tools.compare.shortcuts.desc')}</p>
      </header>

      <table className="w-full max-w-[560px] border-collapse text-[length:var(--text-12)]">
        <thead>
          <tr className="border-b border-[var(--border-subtle)] text-left text-[var(--text-tertiary)]">
            <th scope="col" className="py-1.5 pr-4 font-medium">{t('tools.compare.shortcuts.keys')}</th>
            <th scope="col" className="py-1.5 font-medium">{t('tools.compare.shortcuts.action')}</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.labelKey} className="border-b border-[var(--border-subtle)]/60">
              <td className="py-2 pr-4"><Kbd keys={row.keys} /></td>
              <td className="py-2 text-[var(--text-secondary)]">{t(row.labelKey as never)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="max-w-[640px] rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3 text-[length:var(--text-12)] text-[var(--text-secondary)]">
        <h3 className="mb-1 text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{t('tools.compare.shortcuts.about_title')}</h3>
        <p className="leading-relaxed">{t('tools.compare.shortcuts.about')}</p>
      </section>
    </div>
  )
}
