/**
 * The management page: every list and every tag, with the counts that make them worth managing.
 *
 * It is a page rather than a drawer because it is where a reader goes when they are rearranging,
 * not while they are working, and because on a phone a drawer over the board would leave the thing
 * being edited half visible.
 */

import { useState, type ReactNode } from 'react'
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react'
import { t } from '../../lib/i18n'
import { KanbanIconBadge } from '../../lib/markdown/kanban/ui/kanban-icon-badge'
import { Select } from '../../components/form'
import { listIconFor } from './todo-ui'
import { useTodos, type TaskListEntry } from './store'
import { ListEditor, TagEditor } from './OrganizerEditors'
import { TrashPanel } from './TrashPanel'
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

  const parentPicker = (list: TaskListEntry, hasChildren: boolean) => {
    const current = list.parentId && visibleIds.has(list.parentId) ? list.parentId : ''
    // A container is already the top of a group; nesting it would make the tree two levels tall.
    const eligible = hasChildren ? [] : roots.filter((root) => root.id !== list.id)
    return (
      <Select
        aria-label={`${t('todo.list.parent_label')} ${list.name}`}
        value={current}
        disabled={hasChildren}
        onChange={(event) => {
          const next = event.target.value || null
          if (next !== list.parentId) void updateList(list.id, { parentId: next })
        }}
        className="h-9 w-28 px-2 text-[length:var(--text-11)] md:h-7"
      >
        <option value="">{t('todo.list.top_level')}</option>
        {eligible.map((root) => <option key={root.id} value={root.id}>{root.name}</option>)}
      </Select>
    )
  }

  return (
    <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-24 pt-2 md:px-5 md:pb-6">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-5">
        <section>
          <h2 className="mb-1.5 px-1 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('todo.smart.all')}</h2>
          <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            <button type="button" onClick={() => setView('plan')} className="flex min-h-11 w-full items-center gap-2 px-3 text-left hover:bg-[var(--bg-hover)]">
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)]">{t('todo.view.plan')}</span>
              <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{counts?.all ?? 0}</span>
              <ChevronRight size={13} className="text-[var(--text-quaternary)]" />
            </button>
            <div className="h-px bg-[var(--border-subtle)]" />
            <button type="button" onClick={() => setView('completed')} className="flex min-h-11 w-full items-center gap-2 px-3 text-left hover:bg-[var(--bg-hover)]">
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)]">{t('todo.smart.completed')}</span>
              <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{counts?.completed ?? 0}</span>
              <ChevronRight size={13} className="text-[var(--text-quaternary)]" />
            </button>
          </div>
        </section>

        <section>
          <div className="mb-1.5 flex items-center justify-between px-1">
            <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('todo.a11y.lists')}</h2>
            <button
              type="button"
              onClick={() => setListEditor({ open: true, list: null })}
              className="inline-flex items-center gap-0.5 text-[length:var(--text-11-5)] text-[var(--accent)]"
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
                      parentPicker={parentPicker(list, children.length > 0)}
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
                              parentPicker={parentPicker(child, false)}
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
              {archivedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
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
              <Trash2 size={14} className="text-[var(--text-tertiary)]" />
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)]">{t('todo.trash.title')}</span>
              <ChevronRight size={13} className="text-[var(--text-quaternary)]" />
            </button>
          </div>
        </section>

        <section>
          <div className="mb-1.5 flex items-center justify-between px-1">
            <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('todo.task.tags_label')}</h2>
            <button
              type="button"
              onClick={() => setTagEditor({ open: true, tag: null })}
              className="inline-flex items-center gap-0.5 text-[length:var(--text-11-5)] text-[var(--accent)]"
            >
              <Plus size={12} />{t('todo.action.new_tag')}
            </button>
          </div>
          {tags.length === 0 ? (
            <p className="px-1 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('todo.task.tags_label')}</p>
          ) : (
            <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
              {tags.map((tag, index) => (
                <div key={tag.id}>
                  {index > 0 && <div className="h-px bg-[var(--border-subtle)]" />}
                  <Row
                    label={tag.name}
                    count={tag.openCount}
                    color={tag.color ?? 'var(--accent)'}
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

function Row({ label, count, color, icon, nested = false, parentPicker, onOpen, onEdit, onArchive, onRestore }: {
  label: string
  count: number
  color: string
  icon?: string | null
  /** A child list, indented inside its parent's item. */
  nested?: boolean
  parentPicker?: ReactNode
  onOpen: () => void
  onEdit?: () => void
  onArchive?: () => void
  onRestore?: () => void
}) {
  return (
    <div className={`flex min-h-11 items-center gap-2 pr-1 ${nested ? 'pl-9' : 'pl-3'}`}>
      <span className="flex size-6 shrink-0 items-center justify-center">
        {listIconFor(icon) ? <KanbanIconBadge icon={listIconFor(icon)} size={15} /> : <span className="size-2.5 rounded-full" style={{ backgroundColor: color }} />}
      </span>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate text-left text-[length:var(--text-13)] text-[var(--text-primary)]">
        {label}
      </button>
      <span className="shrink-0 text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{count}</span>
      {parentPicker}
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={`${t('todo.action.edit')} ${label}`}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--text-quaternary)] hover:text-[var(--text-secondary)] md:size-7"
        >
          <Pencil size={13} />
        </button>
      )}
      {onArchive && (
        <button
          type="button"
          onClick={onArchive}
          aria-label={`${t('todo.action.archive')} ${label}`}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--text-quaternary)] hover:text-[var(--text-secondary)] md:size-7"
        >
          <Archive size={13} />
        </button>
      )}
      {onRestore && (
        <button
          type="button"
          onClick={onRestore}
          aria-label={`${t('todo.action.unarchive')} ${label}`}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--text-quaternary)] hover:text-[var(--text-secondary)] md:size-7"
        >
          <ArchiveRestore size={13} />
        </button>
      )}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${t('todo.action.view_list')} ${label}`}
        className="flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--text-quaternary)] md:size-7"
      >
        <ChevronRight size={13} />
      </button>
    </div>
  )
}
