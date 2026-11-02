/** The key map the calendar's keyboard plugin actually installs. */
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'

const SHORTCUTS = [
  ['Ctrl/⌘ + N', 'calendar.shortcuts.new_event'],
  ['Ctrl/⌘ + F', 'calendar.shortcuts.search'],
  ['Ctrl/⌘ + T', 'calendar.shortcuts.today'],
  ['Ctrl/⌘ + P', 'calendar.shortcuts.print'],
  ['← / →', 'calendar.shortcuts.period'],
  ['Ctrl/⌘ + Z', 'calendar.shortcuts.undo'],
  ['Ctrl/⌘ + Y', 'calendar.shortcuts.redo'],
  ['Ctrl/⌘ + C / X / V', 'calendar.shortcuts.clipboard'],
  ['Delete', 'calendar.shortcuts.delete'],
  ['Enter', 'calendar.shortcuts.edit'],
] as const

export function CalendarShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.shortcuts.title')}
      description={t('calendar.shortcuts.description')}
      width={440}
      footer={<Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>}
    >
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 pt-1">
        {SHORTCUTS.map(([keys, label]) => (
          <div key={keys} className="contents">
            <dt>
              <kbd className="inline-block rounded-[var(--r-xs)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-1.5 py-0.5 font-mono text-[length:var(--text-11)] text-[var(--text-secondary)]">
                {keys}
              </kbd>
            </dt>
            <dd className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t(label)}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
