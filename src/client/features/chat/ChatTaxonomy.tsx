/**
 * Filing conversations: the notebook's own folders and tags.
 *
 * A conversation lives in a real `folders` row and carries real `tags` rows, so one folder can hold
 * notes and chats at once and a single tag colours both. Nothing here invents a second taxonomy —
 * these two components read the counts the assistant API computes over those shared tables.
 */
import { useEffect, useMemo, useRef } from 'react'
import { ChevronRight, FolderClosed, Inbox, Layers, Pin, Star, Tags } from 'lucide-react'
import type { AssistantConversation, ChatFolderNode, ConversationTag } from '@shared/assistant'
import { cn } from '../../lib/cn'
import { t, type MessageKey } from '../../lib/i18n'
import { relativeTime } from '../../lib/time'
import { treeIndent, treeItemProps, useTreeKeyboard, type MoveMenuFolder } from '../../lib/tree'
import { TagChip } from '../../components/TagChip'
import { FolderMotionIcon } from '../sidebar/FolderMotionIcon'
import { useUi } from '../../store/ui'
import { useAssistant, CONVERSATION_LIST_TABS, type ConversationListTab } from './assistant-store'

/** One folder, its children, and where it sits among its siblings — what a tree row and a picker both read. */
export interface ChatFolderBranch {
  node: ChatFolderNode
  depth: number
  /** 1-based position among the siblings that share its parent. */
  index: number
  /** How many siblings it has, `aria-setsize` included. */
  setSize: number
  children: ChatFolderBranch[]
}

/**
 * The folder rows built into a tree.
 *
 * The API hands back a flat list with a `parentId`, and a row cannot state its own level, size or
 * parent without knowing where it sits — so the nesting is worked out once here and read by both the
 * tree and the move picker, rather than re-derived by each. Siblings sort by name, and a parent that is
 * gone (deleted elsewhere) makes the node a root rather than losing it.
 */
export function folderBranches(nodes: ChatFolderNode[]): ChatFolderBranch[] {
  const byParent = new Map<string | null, ChatFolderNode[]>()
  const ids = new Set(nodes.map((node) => node.id))
  for (const node of nodes) {
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null
    const siblings = byParent.get(parent) ?? []
    siblings.push(node)
    byParent.set(parent, siblings)
  }
  const build = (parent: string | null, depth: number): ChatFolderBranch[] => {
    const siblings = (byParent.get(parent) ?? []).slice().sort((left, right) => left.name.localeCompare(right.name))
    return siblings.map((node, index) => ({
      node,
      depth,
      index,
      setSize: siblings.length,
      children: build(node.id, depth + 1),
    }))
  }
  return build(null, 0)
}

/**
 * The same tree the move picker reads.
 *
 * `MoveMenuFolder` asks for a name, its children and how many things sit directly inside — and a
 * conversation count is exactly that, read against the same `folders` rows a note count is. So the chat
 * hands the notes picker a projection rather than drawing a second picker with the hierarchy faked out
 * of leading spaces.
 */
export function moveMenuTree(nodes: ChatFolderNode[]): MoveMenuFolder[] {
  const project = (branch: ChatFolderBranch): MoveMenuFolder => ({
    id: branch.node.id,
    name: branch.node.name,
    children: branch.children.map(project),
    directNotes: branch.node.count,
    icon: branch.node.icon,
    color: branch.node.color,
  })
  return folderBranches(nodes).map(project)
}

/** Every folder id that contains this one, roots first — used to keep an open branch visible. */
export function ancestorIds(nodes: ChatFolderNode[], id: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const chain: string[] = []
  let cursor = byId.get(id)?.parentId ?? null
  for (let guard = 0; cursor && guard < 20; guard++) {
    chain.unshift(cursor)
    cursor = byId.get(cursor)?.parentId ?? null
  }
  return chain
}

/**
 * A pick that is not a folder. The notes rail draws its "all" and "unfiled" rows outside the folder
 * tree for the same reason: they name a way of looking at the list, not a row of the `folders` table,
 * so they get no `treeitem`, no fold control and no level — but they do get the rail's row geometry.
 */
function ViewRow({
  active,
  count,
  icon,
  label,
  onSelect,
}: {
  active: boolean
  count: number
  icon: React.ReactNode
  label: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onSelect}
      className={cn(
        'group relative flex h-10 w-full items-center gap-2.5 rounded-[var(--r-md)] px-2 text-left md:h-[30px]',
        'transition-colors duration-[var(--dur-fast)]',
        active
          ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <span className={cn('shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}>{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{label}</span>
      {count > 0 && <span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)]">{count}</span>}
    </button>
  )
}

/**
 * One folder of the notebook's own tree.
 *
 * The row is the notes rail's row: the fold control carries `data-tree-toggle`, the name button carries
 * `data-tree-row`, and `role="treeitem"` with its level, position and size come from `treeItemProps`, so
 * `useTreeKeyboard` reads this tree exactly as it reads the rail's. Folding is the rail's folding too —
 * a conversation lives in a real `folders` row, so the open set is the one keyed by those ids in the UI
 * store, and a folder the reader opened over there is open here.
 */
function FolderTreeRow({
  branch,
  expanded,
  filter,
  onPick,
  onToggle,
}: {
  branch: ChatFolderBranch
  expanded: ReadonlySet<string>
  filter: string
  onPick: (branch: ChatFolderBranch) => void
  onToggle: (id: string) => void
}) {
  const hasChildren = branch.children.length > 0
  const open = hasChildren && expanded.has(branch.node.id)
  const active = filter === branch.node.id
  const onKeyDown = useTreeKeyboard()
  return (
    <li {...treeItemProps({
      level: branch.depth + 1,
      expanded: hasChildren ? open : undefined,
      selected: active,
      setSize: branch.setSize,
      posInSet: branch.index + 1,
    })}>
      <div
        className={cn(
          'group relative flex h-11 items-center gap-1 rounded-[var(--r-md)] pr-1 md:h-[30px]',
          'transition-colors duration-[var(--dur-fast)]',
          active
            ? 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
        )}
        style={{ paddingLeft: treeIndent(branch.depth) }}
      >
        <button
          type="button"
          disabled={!hasChildren}
          aria-hidden={!hasChildren || undefined}
          tabIndex={hasChildren ? undefined : -1}
          data-tree-toggle
          aria-expanded={hasChildren ? open : undefined}
          aria-label={open ? t('sidebar.collapse') : t('sidebar.expand')}
          onClick={() => onToggle(branch.node.id)}
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] md:size-4',
            'transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]',
            open && 'rotate-90',
            !hasChildren && 'invisible',
          )}
        >
          <ChevronRight size={12} />
        </button>

        <span
          className={cn('shrink-0', active && !branch.node.color ? 'text-[var(--accent)]' : !branch.node.color && 'text-[var(--text-tertiary)]')}
          style={{ color: branch.node.color ?? undefined }}
        >
          {branch.node.icon
            ? <span className="text-[13px] leading-none">{branch.node.icon}</span>
            : <FolderMotionIcon open={open} drawing={false} />}
        </span>

        <button
          type="button"
          data-tree-row
          aria-label={branch.node.name}
          aria-current={active ? 'page' : undefined}
          onClick={() => onPick(branch)}
          onKeyDown={onKeyDown}
          className="flex min-w-0 flex-1 items-center gap-1.5 truncate py-1 pl-1 text-left text-[12.5px] font-medium"
        >
          <span className="min-w-0 truncate">{branch.node.name}</span>
        </button>

        <span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)]">
          {branch.node.count > 0 ? branch.node.count : ''}
        </span>
      </div>

      {hasChildren && open && (
        <ul role="group" className="space-y-px">
          {branch.children.map((child) => (
            <FolderTreeRow key={child.node.id} branch={child} expanded={expanded} filter={filter} onPick={onPick} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function ConversationFolders() {
  const nodes = useAssistant((state) => state.folderNodes)
  const filter = useAssistant((state) => state.folderFilter)
  const setFilter = useAssistant((state) => state.setFolderFilter)
  const unfiled = useAssistant((state) => state.unfiledCount)
  const expandedFolders = useUi((state) => state.expandedFolders)
  const toggleFolder = useUi((state) => state.toggleFolder)
  const branches = useMemo(() => folderBranches(nodes), [nodes])
  const open = useMemo(() => new Set(expandedFolders), [expandedFolders])
  const total = useMemo(() => nodes.reduce((sum, node) => sum + node.count, 0) + unfiled, [nodes, unfiled])

  // The picked folder has to be on screen: a filter restored from this device, or one the reader chose
  // and then folded away, would otherwise leave the highlighted row inside a closed branch. The notes
  // rail does the same for the note that is open.
  useEffect(() => {
    const ui = useUi.getState()
    for (const id of ancestorIds(nodes, filter)) ui.expandFolder(id)
  }, [nodes, filter])

  const pick = (branch: ChatFolderBranch) => {
    void setFilter(branch.node.id)
    // The rail's own habit: choosing a folder also opens it, so one click both filters and shows what
    // is in it.
    if (branch.children.length) toggleFolder(branch.node.id)
  }

  return (
    <nav aria-label={t('assistant.chat.folder_filter')} className="px-1.5 pb-1">
      <div className="space-y-px">
        <ViewRow
          active={filter === 'all'}
          count={total}
          icon={<Layers size={14} />}
          label={t('assistant.chat.all')}
          onSelect={() => void setFilter('all')}
        />
        <ViewRow
          active={filter === 'none'}
          count={unfiled}
          icon={<Inbox size={14} />}
          label={t('assistant.chat.unfiled')}
          onSelect={() => void setFilter('none')}
        />
      </div>
      {branches.length > 0 && (
        <ul role="tree" aria-label={t('assistant.chat.folder_filter')} className="mt-0.5 space-y-px">
          {branches.map((branch) => (
            <FolderTreeRow key={branch.node.id} branch={branch} expanded={open} filter={filter} onPick={pick} onToggle={toggleFolder} />
          ))}
        </ul>
      )}
    </nav>
  )
}

/**
 * The tag picks.
 *
 * The chip is the app's shared one, so a conversation's tag and a note's tag are the same box with the
 * same pressed state — and a tag that currently labels nothing is shown rather than hidden, as the
 * notes rail shows its own: the reader can still tell what exists, and hiding it makes the tag look
 * deleted when it is only unused.
 */
export function ConversationTags() {
  const tags = useAssistant((state) => state.tagNodes)
  const active = useAssistant((state) => state.tagFilter)
  const setFilter = useAssistant((state) => state.setTagFilter)
  if (!tags.length) {
    return (
      <p className="px-2 py-3 text-[12px] text-[var(--text-quaternary)]">{t('assistant.chat.tag_none')}</p>
    )
  }
  return (
    <div className="flex flex-wrap gap-1 px-1.5 pb-2 pt-1" role="group" aria-label={t('assistant.chat.tag_filter')}>
      {tags.map((tag: ConversationTag & { count: number }) => {
        const on = active === tag.id
        return (
          <TagChip
            key={tag.id}
            label={tag.name}
            pressed={on}
            color={tag.color}
            count={tag.count}
            onPress={() => void setFilter(on ? null : tag.id)}
          />
        )
      })}
    </div>
  )
}

const TAB_ICONS: Record<ConversationListTab, React.ReactNode> = {
  folders: <FolderClosed size={14} />,
  tags: <Tags size={14} />,
  starred: <Star size={14} />,
  pinned: <Pin size={14} />,
}

const TAB_LABELS: Record<ConversationListTab, MessageKey> = {
  folders: 'assistant.chat.tab.folders',
  tags: 'assistant.chat.tab.tags',
  starred: 'assistant.chat.tab.starred',
  pinned: 'assistant.chat.tab.pinned',
}

export const CHAT_TAXONOMY_PANEL_ID = 'chat-taxonomy-panel'

export function chatTaxonomyTabId(tab: ConversationListTab): string {
  return `chat-taxonomy-tab-${tab}`
}

/**
 * The four pickers in one strip, the same shape the notebook's sidebar uses: icon buttons in a
 * `role="tablist"`, arrow keys moving the selection, and one panel below that answers to it.
 */
export function ConversationTabStrip() {
  const active = useAssistant((state) => state.listTab)
  const select = useAssistant((state) => state.setListTab)
  const ref = useRef<HTMLDivElement>(null)

  const focusIndex = (index: number) => {
    const tabs = ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []
    const target = tabs[(index + tabs.length) % tabs.length]
    if (!target) return
    target.focus()
    const found = CONVERSATION_LIST_TABS.find((tab) => tab === target.dataset.tab)
    if (found) select(found)
  }

  const positionOf = () => {
    const tabs = [...ref.current?.querySelectorAll('[role="tab"]') ?? []]
    const focused = tabs.findIndex((tab) => tab === document.activeElement)
    return focused >= 0 ? focused : CONVERSATION_LIST_TABS.indexOf(active)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    const at = positionOf()
    if (event.key === 'ArrowRight') focusIndex(at + 1)
    else if (event.key === 'ArrowLeft') focusIndex(at - 1)
    else if (event.key === 'Home') focusIndex(0)
    else if (event.key === 'End') focusIndex(CONVERSATION_LIST_TABS.length - 1)
    else return
    event.preventDefault()
  }

  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={t('assistant.chat.tabs_aria')}
      onKeyDown={onKeyDown}
      className="flex shrink-0 items-center gap-0.5 border-t border-[var(--border-subtle)] px-1.5 py-1"
    >
      {CONVERSATION_LIST_TABS.map((tab) => {
        const label = t(TAB_LABELS[tab])
        const selected = tab === active
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            id={chatTaxonomyTabId(tab)}
            data-tab={tab}
            aria-selected={selected}
            aria-controls={CHAT_TAXONOMY_PANEL_ID}
            tabIndex={selected ? 0 : -1}
            title={label}
            onClick={() => select(tab)}
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-[var(--r-sm)] transition-colors',
              selected
                ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                : 'text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
            )}
          >
            <span className="sr-only">{label}</span>
            {TAB_ICONS[tab]}
          </button>
        )
      })}
    </div>
  )
}

/** The shortlists the two flag tabs jump to; opening a row goes straight to that conversation. */
function FlaggedList({ kind, onOpen }: { kind: 'starred' | 'pinned', onOpen?: () => void }) {
  const items = useAssistant((state) => state.flagged[kind])
  const activeId = useAssistant((state) => state.activeId)
  const open = useAssistant((state) => state.openConversation)
  if (!items.length) {
    return (
      <p className="px-2 py-3 text-[12px] text-[var(--text-quaternary)]">
        {t(kind === 'starred' ? 'assistant.chat.empty_starred' : 'assistant.chat.empty_pinned')}
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-px">
      {items.map((conversation: AssistantConversation) => (
        <li key={conversation.id}>
          <button
            type="button"
            aria-current={conversation.id === activeId ? 'page' : undefined}
            onClick={() => {
              void open(conversation.id)
              onOpen?.()
            }}
            className={cn(
              'flex w-full min-w-0 items-center gap-1.5 rounded-[var(--r-sm)] px-2 py-1 text-left text-[12px]',
              'transition-colors duration-[var(--dur-fast)]',
              conversation.id === activeId
                ? 'bg-[var(--bg-active)] font-medium text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
            )}
          >
            <span className="min-w-0 flex-1 truncate">{conversation.title || t('assistant.chat.untitled')}</span>
            <span className="shrink-0 text-[10.5px] text-[var(--text-quaternary)]">{relativeTime(conversation.updatedAt)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The panel the strip drives: one picker at a time, never two stacked lists. */
export function ConversationTaxonomyPanel({ onOpen }: { onOpen?: () => void }) {
  const tab = useAssistant((state) => state.listTab)
  return (
    <div
      id={CHAT_TAXONOMY_PANEL_ID}
      role="tabpanel"
      aria-labelledby={chatTaxonomyTabId(tab)}
      tabIndex={-1}
      className="no-scrollbar max-h-56 shrink-0 overflow-y-auto px-1.5 pb-1"
    >
      {tab === 'folders' && <ConversationFolders />}
      {tab === 'tags' && <ConversationTags />}
      {tab === 'starred' && <FlaggedList kind="starred" onOpen={onOpen} />}
      {tab === 'pinned' && <FlaggedList kind="pinned" onOpen={onOpen} />}
    </div>
  )
}
