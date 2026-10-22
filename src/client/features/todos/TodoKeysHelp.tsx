/**
 * The `?` panel: every key the to-do app answers, in one table.
 *
 * It prints `TODO_SHORTCUT_ROWS` rather than its own list, because a shortcut reference written out a
 * second time is a reference that quietly stops being true — the row a binding moves is the row that
 * should disappear from here with it. The chrome is the app's own `Modal`, so the panel arrives with
 * the focus trap, the Escape route and the backdrop dismissal every other dialog in this product has,
 * and the caps are `Kbd`, so they read as keys rather than as text that happens to be short.
 *
 * The panel is grouped the way the bindings are, and the grouping is doing a second job: the copy in
 * `todo.keys.subtitle` names the three groups whose keys need a row under the caret. Those are the
 * groups `ROW_KEYS` answers to in `use-todo-shortcuts.ts`, so a fourth row-scoped group has to be
 * added to both sentences — a fact worth stating here because nothing enforces it.
 */

import { useId } from 'react'
import { t } from '../../lib/i18n'
import { Kbd } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { TODO_SHORTCUT_GROUPS, TODO_SHORTCUT_ROWS } from './use-todo-shortcuts'

/**
 * Why a definition list and not a table.
 *
 * Each line is one key and what it does, which is a term and its definition rather than a record in a
 * set of columns; a `table` would make a screen reader announce a grid with a header row nobody
 * wrote. The `div` with `display: contents` keeps each pair on one line of the grid while leaving `dt`
 * and `dd` as the elements a reader can be told "term" and "definition" about — and grouping a `dl`
 * this way is what the element itself allows a `div` for.
 */
export function TodoKeysHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const prefix = useId()
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('todo.keys.title')}
      description={t('todo.keys.subtitle')}
      width={440}
    >
      <div className="flex flex-col gap-4">
        {TODO_SHORTCUT_GROUPS.map((group) => {
          const rows = TODO_SHORTCUT_ROWS.filter((row) => row.group === group.id)
          if (!rows.length) return null
          // Named against this panel's own instance, so a second copy of the table on one page cannot
          // point both `aria-labelledby` values at the first heading.
          const id = `${prefix}-${group.id}`
          return (
            <section key={group.id} aria-labelledby={id}>
              <h3
                id={id}
                className="pb-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]"
              >
                {t(group.label)}
              </h3>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                {rows.map((row) => (
                  <div key={row.id} className="contents">
                    <dt className="flex pt-px">
                      <Kbd keys={[...row.keys]} />
                    </dt>
                    <dd className="text-[length:var(--text-12-5)] leading-snug text-[var(--text-secondary)]">
                      {t(row.label)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )
        })}
      </div>
    </Modal>
  )
}
