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
 *
 * Rows are also the one place a reader reorders the tree, by dragging one. The order itself is not
 * stored as a list of ids: `todos_lists.position` is an INTEGER column that the worker truncates, so
 * folding a midpoint between two neighbours — what a task row does, in a REAL column — would put two
 * lists on the same number after a single drop. The page therefore re-derives the order as a strided
 * sequence and writes back only the rows the move passed over, which keeps every position whole,
 * distinct and bounded by `count * stride`.
 */
import { useRef, useState, type ReactNode } from 'react'
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Globe, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { useDropState } from '../../lib/drop-state'
import { useMediaQuery } from '../../lib/hooks'
import { IconButton } from '../../components/primitives'
import { Menu, type MenuItem } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { warmSettingsSection } from '../settings/sections'
import { useTodos, type TaskListEntry } from './store'
import { FINE_POINTER_QUERY } from './TaskCard'
import { TagEditor } from './OrganizerEditors'
import { TrashPanel } from './TrashPanel'
import { ArchivedPanel } from './ArchivedPanel'
import { ListIcon } from './list-icons'
import type { TaskTag } from '@shared/todos/model'

/** How far apart two renumbered list positions sit, so a later drop has a whole number to land on. */
const LIST_POSITION_STRIDE = 1000

/** The band edges of a row. A pointer nearer either edge means the gap beside that row. */
const BAND_BEFORE_MAX = 0.28
const BAND_AFTER_MIN = 0.72

/**
 * What a dragged list carries.
 *
 * Deliberately not `TODO_DRAG_TYPE`: that one holds a task id and ends up in `api.todos.move`, so a
 * row that answered it would send a list id down a task's route. The note tree, the folder tree and
 * the tag rail each name their own format for the same reason.
 */
export const TODO_LIST_DRAG_TYPE = 'application/x-inkstone-todo-list'

/** Whether a drag over this surface is one of ours rather than a task, a file or a note. */
export function isTodoListDrag(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(TODO_LIST_DRAG_TYPE)
}

/** Where a drop lands against the row the pointer is over. */
export type ListDropPlacement = 'before' | 'inside' | 'after'

/** One row's write: the slot it now holds, and its container when the drop crossed one. */
export interface ListPositionWrite {
  id: string
  position: number
  parentId?: string | null
}

/**
 * The band a pointer sits in over one row.
 *
 * A row that can hold another list gets the middle band, which is the only way to say "into it"
 * without a second control; a nested row has nothing to hold, so its middle belongs to whichever
 * half the pointer is nearer.
 */
export function listDropPlacement(ratio: number, canHold: boolean): ListDropPlacement {
  if (ratio < BAND_BEFORE_MAX) return 'before'
  if (ratio > BAND_AFTER_MIN) return 'after'
  if (canHold) return 'inside'
  return ratio < 0.5 ? 'before' : 'after'
}

/** The page split the way it is drawn: roots in their stored order, and under each its children. */
function splitLists(lists: readonly TaskListEntry[]) {
  const ids = new Set(lists.map((list) => list.id))
  const roots: TaskListEntry[] = []
  const children = new Map<string, TaskListEntry[]>()
  const parent = new Map<string, string | null>()
  for (const list of lists) {
    // A parent that is not on this page — archived, or gone — reads as top level, which is what the
    // tree draws.
    const held = list.parentId && ids.has(list.parentId) ? list.parentId : null
    parent.set(list.id, held)
    if (held === null) {
      roots.push(list)
      continue
    }
    const bucket = children.get(held)
    if (bucket) bucket.push(list)
    else children.set(held, [list])
  }
  return {
    roots,
    children,
    parentOf: (id: string): string | null => parent.get(id) ?? null,
    groupOf: (id: string | null): TaskListEntry[] => (id === null ? roots : children.get(id) ?? []),
  }
}

/** How the tree reads once each row holds the position the planner gave it. */
function flatten(roots: readonly TaskListEntry[], children: ReadonlyMap<string, TaskListEntry[]>): TaskListEntry[] {
  const ordered: TaskListEntry[] = []
  for (const root of roots) {
    ordered.push(root)
    for (const child of children.get(root.id) ?? []) ordered.push(child)
  }
  return ordered
}

/**
 * The gap one drop opens, as the writes the route needs.
 *
 * Answers `null` for a drop the one-level grouping refuses, and `[]` for a legal drop that lands
 * where the row already sits — the caller writes nothing for either, and the row paints no line for
 * the first. Positions are re-derived from the order rather than folded between neighbours, because
 * the column is an integer; only the rows whose slot actually changed are returned, so a short move
 * costs two writes rather than one per list.
 */
export function planListDrop(
  lists: readonly TaskListEntry[],
  draggedId: string,
  targetId: string,
  placement: ListDropPlacement,
): ListPositionWrite[] | null {
  // The shelf is not part of the order: a put-away list is drawn in its own section and takes no
  // slot, so it is neither end of a drop.
  const live = lists.filter((list) => list.archivedAt === null)
  const dragged = live.find((list) => list.id === draggedId)
  const target = live.find((list) => list.id === targetId)
  if (!dragged || !target || dragged.id === target.id) return null

  const tree = splitLists(live)
  const from = tree.parentOf(dragged.id)
  const heldByDragged = tree.groupOf(dragged.id).length

  let to: string | null
  let slot: 'end' | ListDropPlacement
  if (placement === 'inside') {
    // Only a top-level row has a middle band to aim at.
    if (tree.parentOf(target.id) !== null) return null
    to = target.id
    slot = 'end'
  } else {
    to = tree.parentOf(target.id)
    slot = placement
  }
  // The route's own two refusals, so a drag never offers a drop that would answer 400: a container
  // cannot move under another list, and no list can move under its own child.
  if (to === dragged.id) return null
  if (to !== null && heldByDragged > 0) return null

  // Take the row out before measuring the gap, or a move down within its own group would land one
  // slot further than the reader pointed at.
  const source = tree.groupOf(from)
  const leaving = source.findIndex((entry) => entry.id === dragged.id)
  if (leaving >= 0) source.splice(leaving, 1)

  const destination = to === null ? tree.roots : (tree.children.get(to) ?? [])
  if (to !== null) tree.children.set(to, destination)
  if (slot === 'end') destination.push(dragged)
  else {
    const landing = destination.findIndex((entry) => entry.id === target.id)
    if (landing < 0) return null
    destination.splice(slot === 'before' ? landing : landing + 1, 0, dragged)
  }

  const changedParent = to !== from
  const writes: ListPositionWrite[] = []
  flatten(tree.roots, tree.children).forEach((entry, index) => {
    const position = (index + 1) * LIST_POSITION_STRIDE
    const parentId = entry.id === dragged.id && changedParent ? to : undefined
    if (entry.position !== position || parentId !== undefined) {
      writes.push({ id: entry.id, position, ...(parentId === undefined ? {} : { parentId }) })
    }
  })
  return writes
}

/**
 * The same move without a pointer: one row past its own neighbour.
 *
 * `up` and `down` stay inside the group the row is drawn in, which is the group the reader sees: a
 * child's neighbour above it is its own container on screen, and swapping with that would be a
 * re-parent dressed up as a reorder. Moving out of a container is what its grouping submenu is for.
 */
export function planListMove(
  lists: readonly TaskListEntry[],
  id: string,
  direction: 'up' | 'down',
): ListPositionWrite[] | null {
  const live = lists.filter((list) => list.archivedAt === null)
  if (!live.some((list) => list.id === id)) return null
  const tree = splitLists(live)
  const group = tree.groupOf(tree.parentOf(id))
  const index = group.findIndex((entry) => entry.id === id)
  if (index < 0) return null
  const neighbour = direction === 'up' ? group[index - 1] : group[index + 1]
  if (!neighbour) return null
  return planListDrop(live, id, neighbour.id, direction === 'up' ? 'before' : 'after')
}

/**
 * The grouping submenu's move, in the drag's arithmetic.
 *
 * Picking a new parent has to land the list at the end of the group it joins: a bare `parentId`
 * write leaves the row's global position where the old group put it, and the flat re-sort then
 * reads as an arbitrary slot. `inside` is exactly "append to that container" and beside the last
 * root is "append to the top level", so this runs the planner a drop runs rather than a second one.
 * Answers null for a move that changes nothing — the row already sits under the picked list — and
 * for one the grouping refuses. The parent write is forced onto the row even when the display
 * order never shifted, because a pointer the page does not draw (an archived parent) still moves.
 */
export function planListReparent(
  lists: readonly TaskListEntry[],
  id: string,
  nextParentId: string | null,
): ListPositionWrite[] | null {
  const live = lists.filter((list) => list.archivedAt === null)
  const dragged = live.find((list) => list.id === id)
  if (!dragged) return null
  if ((dragged.parentId ?? null) === nextParentId) return null
  const tree = splitLists(live)
  let writes: ListPositionWrite[] | null
  if (nextParentId !== null) {
    writes = planListDrop(live, id, nextParentId, 'inside')
  } else {
    const lastRoot = tree.roots.filter((root) => root.id !== id).at(-1)
    writes = lastRoot ? planListDrop(live, id, lastRoot.id, 'after') : []
  }
  if (writes === null) return null
  const moved = writes.find((write) => write.id === id)
  if (!moved) return [...writes, { id, position: dragged.position, parentId: nextParentId }]
  if (moved.parentId === undefined) moved.parentId = nextParentId
  return writes
}

/** The pointer's place in the row, as the fraction the bands are cut from. */
function pointerRatio(event: React.DragEvent<HTMLElement>): number {
  const rect = event.currentTarget.getBoundingClientRect()
  return rect.height ? (event.clientY - rect.top) / rect.height : 0.5
}

/** What one row needs to take part in a drag; absent on a row that is not a list of the page. */
interface RowDrag {
  /** Whether this row's middle band means "into it" — true for a top-level row, false for a nested one. */
  canHold: boolean
  /** Whether this is the row in hand, which is painted through rather than hidden. */
  dragging: boolean
  onStart: (event: React.DragEvent<HTMLDivElement>) => void
  onEnd: () => void
  /** The writes a drop at that band would send, or null when the grouping refuses it. */
  plan: (band: ListDropPlacement) => ListPositionWrite[] | null
  onDrop: (band: ListDropPlacement) => void
}

/** The same two moves as the row menu, for a pointer that cannot drag. */
interface RowMove {
  canUp: boolean
  canDown: boolean
  onUp: () => void
  onDown: () => void
}

export function ListsView({ onOpen }: { onOpen: (target: { listId?: string; tagId?: string }) => void }) {
  const lists = useTodos((state) => state.lists)
  const archivedLists = useTodos((state) => state.archivedLists)
  const loadArchivedLists = useTodos((state) => state.loadArchivedLists)
  const updateList = useTodos((state) => state.updateList)
  const tags = useTodos((state) => state.tags)
  const counts = useTodos((state) => state.counts)
  const setView = useTodos((state) => state.setView)
  // The list editor lives in the store: the sidebar's "+" opens it from any screen, so it cannot be
  // state of the one page that also happens to render a button for it.
  const openListEditor = useTodos((state) => state.openListEditor)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [shelfOpen, setShelfOpen] = useState(false)
  const [tagEditor, setTagEditor] = useState<{ open: boolean; tag: TaskTag | null }>({ open: false, tag: null })
  // A drag that never reached a row still has to let go of the row it picked up, so the row in hand
  // is page state rather than the row's own.
  const [draggingId, setDraggingId] = useState<string | null>(null)
  // A phone cannot start an HTML5 drag at all, so its rows get no handle and the menu is the only
  // path — which is why the menu rows are built whether or not this pointer can drag. The question is
  // the card's own, asked once, so it reads the card's spelling of it.
  const finePointer = useMediaQuery(FINE_POINTER_QUERY)
  // The zone the account's day is measured in, read off the listing it just answered for.
  const timezone = useTodos((state) => state.timezone)

  /**
   * The one door from this app to its own settings.
   *
   * CSV import, the time zone and day end, the mail-to-task address and the published calendar all live
   * under Settings → To-do, and nothing inside the app said so: an account registered before its zone was
   * seeded reads "today" eight hours off with no way to notice it here. The row carries the zone on its
   * face, so the wrong answer is visible rather than merely wrong. `warmSettingsSection` is the panel's
   * own prefetch entry, asked the way the account sheet asks it; the panel opens on the section the
   * reader last left it on, which is why the row names where the setting lives instead of pretending to
   * be the setting.
   */
  const openTodoSettings = (): void => {
    warmSettingsSection('todo')
    useUi.getState().openPanel('settings')
  }

  const toggleArchive = (): void => {
    const next = !archivedOpen
    setArchivedOpen(next)
    if (next) void loadArchivedLists()
  }

  /** One write per row the move passed over; the store re-reads the order from each answer. */
  const applyWrites = async (writes: ListPositionWrite[]): Promise<void> => {
    if (writes.length === 0) return
    await Promise.all(writes.map((write) => updateList(
      write.id,
      write.parentId === undefined
        ? { position: write.position }
        : { position: write.position, parentId: write.parentId },
    )))
  }

  /**
   * The drag bundle one row gets.
   *
   * `plan` and `apply` are the same call on the same function, which is the whole point: the line a
   * row paints is painted exactly where a drop would be accepted, so a reader is never invited to aim
   * at a refusal the grouping would answer with a 400.
   */
  const dragFor = (list: TaskListEntry, nested: boolean): RowDrag => ({
    // A top-level row can hold another list; a nested one already holds nothing.
    canHold: !nested,
    dragging: draggingId === list.id,
    onStart: (event) => {
      event.dataTransfer.setData(TODO_LIST_DRAG_TYPE, list.id)
      event.dataTransfer.effectAllowed = 'move'
      setDraggingId(list.id)
    },
    onEnd: () => setDraggingId(null),
    plan: (band) => (draggingId === null ? null : planListDrop(lists, draggingId, list.id, band)),
    onDrop: (band) => {
      const writes = draggingId === null ? null : planListDrop(lists, draggingId, list.id, band)
      setDraggingId(null)
      if (writes) void applyWrites(writes)
    },
  })

  /** The menu's pair of rows for one list: the moves the drag would make at the same two gaps. */
  const moveFor = (list: TaskListEntry): RowMove => {
    const up = planListMove(lists, list.id, 'up')
    const down = planListMove(lists, list.id, 'down')
    return {
      canUp: up !== null,
      canDown: down !== null,
      onUp: () => { if (up) void applyWrites(up) },
      onDown: () => { if (down) void applyWrites(down) },
    }
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
              onClick={() => openListEditor(null)}
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
                      onEdit={() => openListEditor(list)}
                      onArchive={() => { void updateList(list.id, { archived: true }) }}
                      parents={parentOptions(list, children.length > 0)}
                      parentId={list.parentId}
                      onReparent={(next) => {
                        const writes = planListReparent(lists, list.id, next)
                        if (writes) void applyWrites(writes)
                      }}
                      drag={finePointer ? dragFor(list, false) : undefined}
                      move={moveFor(list)}
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
                              onEdit={() => openListEditor(child)}
                              onArchive={() => { void updateList(child.id, { archived: true }) }}
                              parents={parentOptions(child, false)}
                              parentId={child.parentId}
                              onReparent={(next) => {
                                const writes = planListReparent(lists, child.id, next)
                                if (writes) void applyWrites(writes)
                              }}
                              drag={finePointer ? dragFor(child, true) : undefined}
                              move={moveFor(child)}
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
            {/* The shelf beside the trash because they answer the same question two ways: this row is
                work the reader hid on purpose, and it has no other way back. */}
            <button
              type="button"
              onClick={() => setShelfOpen(true)}
              aria-label={t('todo.shelf.title')}
              className="flex min-h-11 w-full items-center gap-2 border-t border-[var(--border-subtle)] px-3 text-left hover:bg-[var(--bg-hover)]"
            >
              <Archive size={14} className="text-[var(--text-tertiary)]" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)]">{t('todo.shelf.title')}</span>
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

        <section>
          <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            <button
              type="button"
              onClick={openTodoSettings}
              className="flex min-h-11 w-full items-center gap-2 px-3 text-left hover:bg-[var(--bg-hover)]"
            >
              <Globe size={14} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)]">{t('todo.lists.timezone_title')}</span>
              <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{timezone}</span>
              <ChevronRight size={13} className="text-[var(--text-quaternary)]" aria-hidden="true" />
            </button>
          </div>
          <p className="mt-1.5 px-1 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('todo.lists.timezone_hint')}</p>
        </section>
      </div>

      <TagEditor open={tagEditor.open} tag={tagEditor.tag} onClose={() => setTagEditor({ open: false, tag: null })} />
      <TrashPanel open={trashOpen} onClose={() => setTrashOpen(false)} />
      <ArchivedPanel open={shelfOpen} onClose={() => setShelfOpen(false)} />
    </div>
  )
}

function Row({ label, count, color, icon, tag = false, nested = false, parents, parentId, drag, move, onOpen, onEdit, onArchive, onRestore, onReparent }: {
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
  /** The row's own drag, absent for a row that is not a list on the working page. */
  drag?: RowDrag
  /** The menu's equivalent of that drag, absent for a row that has no order to hold. */
  move?: RowMove
  onOpen: () => void
  onEdit?: () => void
  onArchive?: () => void
  onRestore?: () => void
  onReparent?: (parentId: string | null) => void
}) {
  const menuRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  /** The row highlight a drag paints: the same before/inside/after grammar the folder tree uses. */
  const [dropState, setDropState] = useDropState<'none' | ListDropPlacement>('none')
  const items: MenuItem[] = [
    ...(onEdit ? [{ id: 'edit', label: t('todo.action.edit'), icon: <Pencil size={13} />, onSelect: onEdit }] : []),
    ...(move ? [
      {
        id: 'move-up',
        label: t('todo.move.up'),
        icon: <ArrowUp size={13} />,
        disabled: !move.canUp,
        separatorBefore: true,
        onSelect: move.onUp,
      },
      {
        id: 'move-down',
        label: t('todo.move.down'),
        icon: <ArrowDown size={13} />,
        disabled: !move.canDown,
        onSelect: move.onDown,
      },
    ] : []),
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
    <div
      data-todo-draggable={drag ? '' : undefined}
      data-list-drop-band={dropState === 'none' ? undefined : dropState}
      draggable={drag ? true : undefined}
      onDragStart={(event) => {
        if (!drag) {
          event.preventDefault()
          return
        }
        drag.onStart(event)
      }}
      onDragEnd={() => drag?.onEnd()}
      onDragOver={(event) => {
        if (!drag || !isTodoListDrag(event)) return
        const band = listDropPlacement(pointerRatio(event), drag.canHold)
        // A drop the grouping would refuse is never offered: without `preventDefault` the pointer
        // itself says "no", and no line is painted to promise a slot that will not arrive.
        if (drag.plan(band) === null) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        setDropState(band)
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDropState('none')
      }}
      onDrop={(event) => {
        if (!drag || !isTodoListDrag(event)) return
        event.preventDefault()
        event.stopPropagation()
        if (dropState === 'none') return
        const band = dropState
        setDropState('none')
        drag.onDrop(band)
      }}
      className={cn(
        'relative flex min-h-11 items-center gap-2 pr-1',
        nested ? 'pl-9' : 'pl-3',
        drag?.dragging && 'opacity-50',
        dropState === 'inside' && 'ring-1 ring-[var(--accent)]',
      )}
    >
      {dropState === 'before' && (
        <span aria-hidden="true" className="pointer-events-none absolute top-0 right-1 left-1 h-0.5 rounded-full bg-[var(--accent)]" />
      )}
      {dropState === 'after' && (
        <span aria-hidden="true" className="pointer-events-none absolute right-1 bottom-0 left-1 h-0.5 rounded-full bg-[var(--accent)]" />
      )}
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
