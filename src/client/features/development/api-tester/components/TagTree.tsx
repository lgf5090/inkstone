import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Hash } from 'lucide-react'
import type { TagNode } from '@shared/development/api-tester/types'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { treeIndent } from '../../../../lib/tree/indent'
import { tagColorValue } from '../lib/tag-colors'

interface TagTreeNode extends TagNode {
  children: TagTreeNode[]
}

function buildTree(tags: readonly TagNode[]): TagTreeNode[] {
  const byId = new Map<string, TagTreeNode>()
  for (const tag of tags) byId.set(tag.id, { ...tag, children: [] })
  const roots: TagTreeNode[] = []
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const sort = (list: TagTreeNode[]) => {
    list.sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt - right.createdAt)
    for (const node of list) sort(node.children)
  }
  sort(roots)
  return roots
}

/** Ids of matching tags plus every ancestor, so the filtered tree keeps its paths. */
function matchedTagIds(tags: readonly TagNode[], query: string): Set<string> {
  const needle = query.trim().toLowerCase()
  if (!needle) return new Set()
  const byId = new Map(tags.map((tag) => [tag.id, tag]))
  const matched = new Set<string>()
  for (const tag of tags) {
    if (!tag.name.toLowerCase().includes(needle)) continue
    matched.add(tag.id)
    let current = tag
    while (current.parentId) {
      matched.add(current.parentId)
      const parent = byId.get(current.parentId)
      if (!parent) break
      current = parent
    }
  }
  return matched
}

function TagTreeRow({
  node,
  depth,
  activeTagId,
  matchedIds,
  expanded,
  counts,
  onToggle,
  onSelect,
}: {
  node: TagTreeNode
  depth: number
  activeTagId: string | null
  matchedIds: Set<string>
  expanded: ReadonlySet<string>
  counts: Map<string, number>
  onToggle: (id: string) => void
  onSelect: (id: string) => void
}) {
  if (matchedIds.size > 0 && !matchedIds.has(node.id)) return null
  const open = expanded.has(node.id)
  const count = counts.get(node.id) ?? 0
  return (
    <div>
      <div
        className={cn(
          'group flex min-h-7 items-center gap-1 rounded-[var(--r-sm)] pr-1.5 text-[length:var(--text-12)]',
          activeTagId === node.id ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
        )}
        style={{ paddingLeft: treeIndent(depth) + 2 }}
        data-tag-id={node.id}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            aria-label={open ? t('development.apitester.collapse') : t('development.apitester.expand')}
            aria-expanded={open}
            data-action="toggle-tag"
            onClick={() => onToggle(node.id)}
            className="flex size-4 shrink-0 items-center justify-center rounded-[var(--r-xs)] text-[var(--text-quaternary)] hover:text-[var(--text-primary)]"
          >
            <ChevronRight size={12} className={cn('transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="size-4 shrink-0" aria-hidden="true" />
        )}
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: tagColorValue(node.color) ?? undefined }}
          aria-hidden="true"
        />
        <button
          type="button"
          aria-pressed={activeTagId === node.id}
          data-action="select-tag"
          onClick={() => onSelect(node.id)}
          title={node.name}
          className="min-w-0 flex-1 truncate text-left"
        >
          {node.name}
        </button>
        {count > 0 && (
          <span className="shrink-0 rounded-full bg-[var(--bg-raised)] px-1.5 text-[length:var(--text-10)] tabular-nums text-[var(--text-tertiary)]">
            {count}
          </span>
        )}
      </div>
      {open && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <TagTreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              activeTagId={activeTagId}
              matchedIds={matchedIds}
              expanded={expanded}
              counts={counts}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function TagTree({
  tags,
  counts,
  activeTagId,
  searchKeyword,
  onSelect,
}: {
  tags: TagNode[]
  counts: Map<string, number>
  activeTagId: string | null
  searchKeyword: string
  onSelect: (id: string) => void
}) {
  const tree = useMemo(() => buildTree(tags), [tags])
  const matchedIds = useMemo(() => matchedTagIds(tags, searchKeyword), [tags, searchKeyword])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (matchedIds.size === 0) return
    setExpanded((previous) => {
      let changed = false
      const next = new Set(previous)
      for (const id of matchedIds) {
        if (!next.has(id)) {
          next.add(id)
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [matchedIds])

  if (tags.length === 0) {
    return <p className="px-2 py-3 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.apitester.create_tag_hint')}</p>
  }

  if (matchedIds.size === 0 && searchKeyword.trim()) {
    return <p className="px-2 py-3 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.apitester.no_match_found')}</p>
  }

  const toggle = (id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-px">
      {tree.map((node) => (
        <TagTreeRow
          key={node.id}
          node={node}
          depth={0}
          activeTagId={activeTagId}
          matchedIds={matchedIds}
          expanded={expanded}
          counts={counts}
          onToggle={toggle}
          onSelect={onSelect}
        />
      ))}
      {tree.length === 0 && (
        <p className="flex items-center justify-center gap-1.5 px-2 py-3 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          <Hash size={12} /> {t('development.apitester.no_tags')}
        </p>
      )}
    </div>
  )
}
