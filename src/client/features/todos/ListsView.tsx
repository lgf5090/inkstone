/**
 * The management page: every list and every tag, with the counts that make them worth managing.
 *
 * It is a page rather than a drawer because it is where a reader goes when they are rearranging,
 * not while they are working, and because on a phone a drawer over the board would leave the thing
 * being edited half visible.
 *
 * A row is a name and a count; everything a row can do — rename, re-parent, archive — lives in one
 * menu at its end. The parent picker used to be a `<select>` on every row, which on a 360px screen took
 * a third of the width and pushed the row's own actions off the edge.
 */
import { useRef, useState, type ReactNode } from 'react'
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { IconButton } from '../../components/primitives'
import { Menu, type MenuItem } from '../../components/overlay'
import { useTodos, type TaskListEntry } from './store'
import { ListEditor, TagEditor } from './OrganizerEditors'
import { TrashPanel } from './TrashPanel'
import { ListIcon } from './list-icons'
import type { TaskList, TaskTag } from '@shared/todos/model'

export function ListsView({ onOpen }: { onOpen: (target: { listId?: string; tagId?: string }) => void }) {
  const lists = useTodos((state) => state.lists)
  const archivedLists = useTodos((state) => state.archivedLists)
  const loadArchivedLists = useTodos((state) => state.loadArchivedLists)
  const updateList = useTodos((state) => state.updateList)
  const tags = useTodos((state) => state.tags)
  const counts = useTodos((state) => state.counts)
  const setView = useTodos((state) => state.setView)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [listEditor, setListEditor] = useState<{ open: boolean; list: TaskList | null }>({ open: false, list: null })
  const [tagEditor, setTagEditor] = useState<{ open: boolean; tag: TaskTag | null }>({ open: false, tag: null })

  const toggleArchive = (): void => {
    const next = !archivedOpen
    setArchivedOpen(next)
    if (next) void loadArchivedLists()
  }

  // One level, drawn from the flat answer: a list whose parent is not on the working page (archived
  // or gone) is drawn at the top rather than disappearing with it.
  const visibleIds = new Set(lists.map((list) => list.id))
  const childrenOf = new Map<string, TaskListEntry[]>()
  for (const list of lists) {
    if (!list.parentId || !visibleIds.has(list.parentId)) continue
    const bucket = childrenOf.get(list.parentId) ?? []
    bucket.push(list)
    childrenOf.set(list.parentId, bucket)
  }
  const roots = lists.filter((list) => !list.parentId || !visibleIds.has(list.parentId))

  /** The roots a list may move under: itself and any container are excluded. */
  const parentOptions = (list: TaskListEntry, hasChildren: boolean) => {
    const eligible = hasChildren ? [] : roots.filter((root) => root.id !== list.id)
    return eligible
  }

  return (
    <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-28 pt-2 md:px-5 md:pb-6">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-5">
        <section>
          <h2 className="mb-1.5 px-1 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('todo.lists.views')}</h2>
          <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            <button type="button" onClick={() => setView('plan')} className="flex min-h-11 w-full items-center gap-2 px-3 text-left hover:bg-[var(--bg-hover)]">
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)]">{t('todo.view.plan')}</span>
              <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{counts?.all ?? 0}</span>
              <ChevronRight size={13} className="text-[var(--text-quaternary)]" aria-hidden="true" />
            </button>
            <div className="h-px bg-[var(--border-subtle)]" />
            <button type="button" onClick={() => setView('completed')} className="flex min-h-11 w-full items-center gap-2 px-3 text-left hover:bg-[var(--bg-hover)]">
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)]">{t('todo.smart.completed')}</span>
              <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{counts?.completed ?? 0}</span>
              <ChevronRight size={13} className="text-[var(--text-quaternary)]" aria-hidden="true" />
            </button>
          </div>
        </section>

        <section>
          <div className="mb-1.5 flex items-center justify-between px-1">
            <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('todo.a11y.lists')}</h2>
            <button
              type="button"
              onClick={() => setListEditor({ open: true, list: null })}
              className="inline-flex min-h-9 items-center gap-0.5 text-[length:var(--text-11-5)] text-[var(--accent)]"
            >
              <Plus size={12} />{t('todo.action.new_list')}
            </button>
          </div>
          <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            <Row
              label={t('todo.smart.inbox')}
              count={counts?.inbox ?? 0}
              color="var(--text-tertiary)"
              onOpen={() => onOpen({ listId: 'inbox' })}
            />
            <ul className="m-0 list-none p-0">
              {roots.map((list) => {
                const children = childrenOf.get(list.id) ?? []
                return (
                  <li key={list.id}>
                    <div className="h-px bg-[var(--border-subtle)]" />
                    <Row
                      label={list.name}
                      count={list.openCount}
                      color={list.color ?? 'var(--accent)'}
                      icon={list.icon}
                      onOpen={() => onOpen({ listId: list.id })}
                      onEdit={() => setListEditor({ open: true, list })}
                      onArchive={() => { void updateList(list.id, { archived: true }) }}
                      parents={parentOptions(list, children.length > 0)}
                      parentId={list.parentId}
                      onReparent={(next) => { void updateList(list.id, { parentId: next }) }}
                    />
                    {children.length > 0 && (
                      <ul className="m-0 list-none p-0">
                        {children.map((child) => (
                          <li key={child.id}>
                            <div className="h-px bg-[var(--border-subtle)]" />
                            <Row
                              nested
                              label={child.name}
                              count={child.openCount}
                              color={child.color ?? 'var(--accent)'}
                              icon={child.icon}
                              onOpen={() => onOpen({ listId: child.id })}
                              onEdit={() => setListEditor({ open: true, list: child })}
                              onArchive={() => { void updateList(child.id, { archived: true }) }}
                              parents={parentOptions(child, false)}
                              parentId={child.parentId}
                              onReparent={(next) => { void updateList(child.id, { parentId: next }) }}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
          <div className="mt-2 overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            <button
              type="button"
              onClick={toggleArchive}
              aria-expanded={archivedOpen}
              aria-label={t('todo.list.archived')}
              className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            >
              {archivedOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate">{t('todo.list.archived')}</span>
              <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{archivedLists.length}</span>
            </button>
            {archivedOpen && archivedLists.map((list) => (
              <div key={list.id}>
                <div className="h-px bg-[var(--border-subtle)]" />
                <Row
                  label={list.name}
                  count={list.openCount}
                  color={list.color ?? 'var(--text-quaternary)'}
                  icon={list.icon}
                  onOpen={() => onOpen({ listId: list.id })}
                  onRestore={() => { void updateList(list.id, { archived: false }) }}
                />
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            <button
              type="button"
              onClick={() => setTrashOpen(true)}
              aria-label={t('todo.trash.title')}
              className="flex min-h-11 w-full items-center gap-2 px-3 text-left hover:bg-[var(--bg-hover)]"
            >
              <Trash2 size={14} className="text-[var(--text-tertiary)]" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)]">{t('todo.trash.title')}</span>
              <ChevronRight size={13} className="text-[var(--text-quaternary)]" aria-hidden="true" />
            </button>
          </div>
        </section>

        <section>
          <div className="mb-1.5 flex items-center justify-between px-1">
            <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('todo.task.tags_label')}</h2>
            <button
              type="button"
              onClick={() => setTagEditor({ open: true, tag: null })}
              className="inline-flex min-h-9 items-center gap-0.5 text-[length:var(--text-11-5)] text-[var(--accent)]"
            >
              <Plus size={12} />{t('todo.action.new_tag')}
            </button>
          </div>
          {tags.length === 0 ? (
            <p className="px-1 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('todo.tag.empty')}</p>
          ) : (
            <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
              {tags.map((tag, index) => (
                <div key={tag.id}>
                  {index > 0 && <div className="h-px bg-[var(--border-subtle)]" />}
                  <Row
                    label={tag.name}
                    count={tag.openCount}
                    color={tag.color ?? 'var(--accent)'}
                    tag
                    onOpen={() => onOpen({ tagId: tag.id })}
                    onEdit={() => setTagEditor({ open: true, tag })}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <ListEditor open={listEditor.open} list={listEditor.list} onClose={() => setListEditor({ open: false, list: null })} />
      <TagEditor open={tagEditor.open} tag={tagEditor.tag} onClose={() => setTagEditor({ open: false, tag: null })} />
      <TrashPanel open={trashOpen} onClose={() => setTrashOpen(false)} />
    </div>
  )
}

function Row({ label, count, color, icon, tag = false, nested = false, parents, parentId, onOpen, onEdit, onArchive, onRestore, onReparent }: {
  label: string
  count: number
  color: string
  icon?: string | null
  /** A tag's glyph is its `#`, not a list icon. */
  tag?: boolean
  /** A child list, indented inside its parent's item. */
  nested?: boolean
  /** The lists this row may move under; empty or absent means the row cannot be re-parented. */
  parents?: TaskListEntry[]
  parentId?: string | null
  onOpen: () => void
  onEdit?: () => void
  onArchive?: () => void
  onRestore?: () => void
  onReparent?: (parentId: string | null) => void
}) {
  const menuRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const items: MenuItem[] = [
    ...(onEdit ? [{ id: 'edit', label: t('todo.action.edit'), icon: <Pencil size={13} />, onSelect: onEdit }] : []),
    ...(onReparent && parents && parents.length > 0
      ? [{
          id: 'parent',
          label: t('todo.list.parent_label'),
          icon: <ChevronRight size={13} />,
          submenu: ({ closeMenu }: { closeMenu: () => void }): ReactNode => (
            <div role="menu" aria-label={t('todo.list.parent_label')} className="rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)]">
              {[{ id: '', name: t('todo.list.top_level') }, ...parents.map((parent) => ({ id: parent.id, name: parent.name }))].map((option) => (
                <button
                  key={option.id || 'root'}
                  type="button"
                  role="menuitemradio"
                  aria-checked={(parentId ?? '') === option.id}
                  onClick={() => { closeMenu(); onReparent(option.id || null) }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[length:var(--text-12-5)]',
                    (parentId ?? '') === option.id ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{option.name}</span>
                </button>
              ))}
            </div>
          ),
        }]
      : []),
    ...(onArchive ? [{ id: 'archive', label: t('todo.action.archive'), icon: <Archive size={13} />, separatorBefore: true, onSelect: onArchive }] : []),
    ...(onRestore ? [{ id: 'restore', label: t('todo.action.unarchive'), icon: <ArchiveRestore size={13} />, onSelect: onRestore }] : []),
  ]

  return (
    <div className={cn('flex min-h-11 items-center gap-2 pr-1', nested ? 'pl-9' : 'pl-3')}>
      <span className="flex size-6 shrink-0 items-center justify-center">
        {tag
          ? <span className="text-[length:var(--text-13)] font-medium" style={{ color }} aria-hidden="true">#</span>
          : icon
            ? <ListIcon icon={icon} size={15} />
            : <span className="size-2.5 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />}
      </span>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${t('todo.action.view_list')} ${label}`}
        className="min-w-0 flex-1 truncate text-left text-[length:var(--text-13)] text-[var(--text-primary)]"
      >
        {label}
      </button>
      <span className="shrink-0 text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{count}</span>
      {items.length > 0 && (
        <>
          <IconButton ref={menuRef} label={`${t('todo.task.actions')}: ${label}`} size="sm" className="size-9 md:size-7" onClick={() => setMenuOpen((open) => !open)}>
            <MoreHorizontal size={14} />
          </IconButton>
          <Menu anchor={menuRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} align="end" width={188} label={`${t('todo.task.actions')}: ${label}`} />
        </>
      )}
      <ChevronRight size={13} className="shrink-0 text-[var(--text-quaternary)] md:hidden" aria-hidden="true" />
    </div>
  )
}
