/**
 * The shortcut sheet.
 *
 * Everything the reader can do without looking for a button, in one place, listed from the same table
 * the key handler reads — so a shortcut cannot be added to one and forgotten in the other.
 */
import { t } from '../../../lib/i18n'
import { Kbd } from '../../../components/primitives'
import { READING_SHORTCUTS } from './shortcuts'

export function ShortcutsPanel() {
  return (
    <div className="px-3 py-2">
      <ul className="space-y-1.5">
        {READING_SHORTCUTS.map((entry) => (
          <li key={entry.key} className="flex items-center gap-3">
            <Kbd keys={entry.keys} />
            <span className="min-w-0 flex-1 text-[12px] leading-snug">{t(entry.labelKey)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] leading-relaxed opacity-60">{t('reading.shortcuts_hint')}</p>
    </div>
  )
}
