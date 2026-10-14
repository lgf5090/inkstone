/**
 * The shortcut sheet.
 *
 * A reader who has never used an RSS app does not know that `j` and `k` are the whole point of one,
 * and a reader who has used three of them does not want to learn a fourth set. So the keys are
 * listed where they are used, on the surface that answers to them, and every row is a key this app
 * actually handles — a sheet with a key that does nothing is worse than no sheet.
 */
import type { ReactElement } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import { t } from '../../lib/i18n'
import { Modal } from '../../components/overlay'

const KEYS: Array<[string, MessageKey]> = [
  ['j', 'rss.key_next'],
  ['k', 'rss.key_previous'],
  ['Enter', 'rss.key_open'],
  ['x', 'rss.key_pick'],
  ['s', 'rss.key_star'],
  ['m', 'rss.key_mark_read'],
  ['v', 'rss.key_open_original'],
  ['r', 'rss.key_refresh'],
  ['f', 'rss.key_focus'],
  ['[', 'rss.key_rail'],
  ['/', 'rss.key_search'],
  ['?', 'rss.key_help'],
  ['Escape', 'rss.key_escape'],
]

export function RssKeys({ open, onClose }: { open: boolean, onClose: () => void }): ReactElement {
  return (
    <Modal open={open} onClose={onClose} title={t('rss.keys_title')} width={460}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[length:var(--text-12-5)]">
        {KEYS.map(([key, label]) => (
          <div key={key} className="contents">
            <dt>
              <kbd className="rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-sunken)] px-1.5 py-0.5 font-mono text-[length:var(--text-11)] text-[var(--text-secondary)]">
                {key}
              </kbd>
            </dt>
            <dd className="text-[var(--text-secondary)]">{t(label)}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
