/**
 * Filing conversations: the notebook's own folders and tags.
 *
 * A conversation lives in a real `folders` row and carries real `tags` rows, so one folder can hold
 * notes and chats at once and a single tag colours both. Nothing here invents a second taxonomy —
 * these two components read the counts the assistant API computes over those shared tables.
 */
import { useMemo } from 'react'
import { Folder, Inbox, Layers } from 'lucide-react'
import type { ChatFolderNode, ConversationTag } from '@shared/assistant'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { useAssistant } from './assistant-store'

/** Depth-first order with the level each node sits at, so the list can indent it. */
export function orderedFolders(nodes: ChatFolderNode[]): { node: ChatFolderNode, depth: number }[] {
  const byParent = new Map<string | null, ChatFolderNode[]>()
  const ids = new Set(nodes.map((node) => node.id))
  for (const node of nodes) {
    // A parent that is gone (deleted elsewhere) makes the node a root rather than losing it.
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null
    const siblings = byParent.get(parent) ?? []
    siblings.push(node)
    byParent.set(parent, siblings)
  }
  const out: { node: ChatFolderNode, depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const node of (byParent.get(parent) ?? []).sort((left, right) => left.name.localeCompare(right.name))) {
      out.push({ node, depth })
      walk(node.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
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

function FilterRow({
  active,
  count,
  depth,
  icon,
  label,
  onSelect,
}: {
  active: boolean
  count: number
  depth: number
  icon: React.ReactNode
  label: string
  onSelect: () => void
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        onClick={onSelect}
        style={{ paddingLeft: `${6 + depth * 12}px` }}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 rounded-[var(--r-sm)] py-1 pr-2 text-left text-[12px]',
          'transition-colors duration-[var(--dur-fast)]',
          active
            ? 'bg-[var(--bg-active)] font-medium text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        )}
      >
        <span className="shrink-0 text-[var(--text-quaternary)]">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count > 0 && <span className="shrink-0 text-[10.5px] text-[var(--text-quaternary)]">{count}</span>}
      </button>
    </li>
  )
}

export function ConversationFolders() {
  const nodes = useAssistant((state) => state.folderNodes)
  const filter = useAssistant((state) => state.folderFilter)
  const setFilter = useAssistant((state) => state.setFolderFilter)
  const unfiled = useAssistant((state) => state.unfiledCount)
  const ordered = useMemo(() => orderedFolders(nodes), [nodes])
  const total = useMemo(() => nodes.reduce((sum, node) => sum + node.count, 0) + unfiled, [nodes, unfiled])
  return (
    <nav aria-label={t('assistant.chat.folder_filter')} className="px-1.5 pb-1">
      <ul className="flex flex-col gap-px">
        <FilterRow
          active={filter === 'all'}
          count={total}
          depth={0}
          icon={<Layers size={13} />}
          label={t('assistant.chat.all')}
          onSelect={() => void setFilter('all')}
        />
        <FilterRow
          active={filter === 'none'}
          count={unfiled}
          depth={0}
          icon={<Inbox size={13} />}
          label={t('assistant.chat.unfiled')}
          onSelect={() => void setFilter('none')}
        />
        {ordered.map(({ node, depth }) => (
          <FilterRow
            key={node.id}
            active={filter === node.id}
            count={node.count}
            depth={depth}
            icon={<Folder size={13} />}
            label={node.name}
            onSelect={() => void setFilter(node.id)}
          />
        ))}
      </ul>
    </nav>
  )
}

export function ConversationTags() {
  const tags = useAssistant((state) => state.tagNodes)
  const active = useAssistant((state) => state.tagFilter)
  const setFilter = useAssistant((state) => state.setTagFilter)
  const visible = tags.filter((tag) => tag.count > 0)
  if (!visible.length) return null
  return (
    <div className="flex flex-wrap gap-1 px-3 pb-2 pt-0" role="group" aria-label={t('assistant.chat.tag_filter')}>
      {visible.map((tag: ConversationTag & { count: number }) => {
        const on = active === tag.id
        return (
          <button
            key={tag.id}
            type="button"
            aria-pressed={on}
            onClick={() => void setFilter(on ? null : tag.id)}
            className={cn(
              'inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-[1px] text-[11px]',
              'transition-colors duration-[var(--dur-fast)]',
              on
                ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
            )}
          >
            {tag.color && <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: tag.color }} />}
            <span className="min-w-0 truncate">{tag.name}</span>
            <span className="shrink-0 text-[10px] text-[var(--text-quaternary)]">{tag.count}</span>
          </button>
        )
      })}
    </div>
  )
}
