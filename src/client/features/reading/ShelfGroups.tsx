/**
 * The shelf's own groupings, as a row of chips.
 *
 * A chip is both a filter and a handle: pressing one narrows the shelf to its books, and the menu on it
 * is where the group gets renamed or thrown away. The count is the number of books on this shelf that
 * are in it — not the number the group remembers — because a book a reader deleted should not keep
 * inflating a group they can still see.
 */
import { useState } from 'react'
import { Folder, FolderPlus } from 'lucide-react'
import { Button } from '../../components/primitives'
import { Menu, prompt, useContextMenu, type MenuItem } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { sortGroups, type BookGroup, type GroupRefusal } from './book-groups'
import { useLibrary } from './store/library'

const REFUSAL_KEYS: Record<GroupRefusal, 'reading.group_name_empty' | 'reading.group_name_taken' | 'reading.group_limit' | 'reading.group_missing'> = {
  empty: 'reading.group_name_empty',
  duplicate: 'reading.group_name_taken',
  limit: 'reading.group_limit',
  unknown: 'reading.group_missing',
}

export function ShelfGroups({ active, onSelect, shelfBookIds }: {
  active: string | null
  onSelect: (id: string | null) => void
  shelfBookIds: ReadonlySet<string>
}) {
  const groups = useLibrary((state) => state.groups)
  const addGroup = useLibrary((state) => state.addGroup)
  const renameGroup = useLibrary((state) => state.renameGroup)
  const dropGroup = useLibrary((state) => state.dropGroup)
  const [target, setTarget] = useState<BookGroup | null>(null)
  const menu = useContextMenu()
  const toast = useUi((state) => state.toast)
  const ordered = sortGroups(groups)

  function refuse(reason: GroupRefusal): void {
    toast({ title: t(REFUSAL_KEYS[reason]), tone: 'warning' })
  }

  async function create(): Promise<void> {
    const name = await prompt({ title: t('reading.new_group'), confirmLabel: t('reading.create_group') })
    if (name === null) return
    const answer = addGroup(name)
    if (!answer.ok) refuse(answer.reason)
  }

  async function edit(group: BookGroup): Promise<void> {
    const name = await prompt({
      title: t('reading.rename_group'), defaultValue: group.name, confirmLabel: t('common.save'),
    })
    if (name === null) return
    const answer = renameGroup(group.id, name)
    if (!answer.ok) refuse(answer.reason)
  }

  function menuFor(group: BookGroup): MenuItem[] {
    return [
      { id: 'show', label: t('reading.show_group_value0', { value0: group.name }), onSelect: () => onSelect(group.id) },
      { id: 'rename', label: t('reading.rename_group'), onSelect: () => void edit(group) },
      {
        id: 'delete',
        label: t('reading.delete_group'),
        tone: 'danger',
        separatorBefore: true,
        onSelect: () => {
          dropGroup(group.id)
          if (active === group.id) onSelect(null)
        },
      },
    ]
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ordered.map((group) => {
        const count = group.bookIds.filter((bookId) => shelfBookIds.has(bookId)).length
        const isActive = active === group.id
        return (
          <button
            key={group.id}
            type="button"
            aria-pressed={isActive}
            onClick={() => onSelect(isActive ? null : group.id)}
            onContextMenu={(event) => {
              setTarget(group)
              menu.onContextMenu(event)
            }}
            className={
              isActive
                ? 'inline-flex items-center gap-1 rounded-full border border-[var(--accent)] bg-[var(--accent-soft)] px-2 py-0.5 text-[11.5px] text-[var(--text-primary)]'
                : 'inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[11.5px] text-[var(--text-tertiary)] hover:border-[var(--border-default)] hover:text-[var(--text-secondary)]'
            }
          >
            <Folder size={11} aria-hidden="true" />
            <span className="max-w-[12rem] truncate">{group.name}</span>
            <span className="tabular text-[var(--text-quaternary)]">{count}</span>
          </button>
        )
      })}
      <Button
        size="sm"
        variant="ghost"
        icon={<FolderPlus size={13} />}
        onClick={() => void create()}
      >
        {t('reading.new_group')}
      </Button>
      {target ? (
        <Menu
          anchor={menu.point ?? { x: 0, y: 0 }}
          open={Boolean(menu.point) && Boolean(target)}
          onClose={menu.close}
          zIndex={240}
          items={target ? menuFor(target) : []}
        />
      ) : null}
    </div>
  )
}
