import { useMemo } from 'react'
import type { NoteTemplate } from '@shared/types'
import { compareTemplates } from '../../store/note-templates'
import type { GalleryFilter } from './gallery-persist'

export interface TemplateSearchable {
  name: string
  description?: string
  content: string
  tags?: readonly string[]
}

/**
 * One query, one rule: the gallery grid and the community list are the same
 * search over the same four fields, because a search box that only works in one
 * of the two is a control that lies about what the view can do.
 */
export function templateMatchesQuery(item: TemplateSearchable, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true
  return item.name.toLocaleLowerCase().includes(normalized) ||
    (item.description ?? '').toLocaleLowerCase().includes(normalized) ||
    item.content.toLocaleLowerCase().includes(normalized) ||
    (item.tags ?? []).some((tag) => tag.toLocaleLowerCase().includes(normalized))
}

/**
 * Which empty state the grid should explain. `no_templates` was almost unreachable
 * because a fresh account always carries the built-in catalog, so what a reader
 * actually meets is an empty view of a library that is not empty.
 */
export type GalleryEmptyState = 'search' | 'favorites' | 'category' | 'uncategorized' | 'tag' | 'library'

export function galleryEmptyState(filter: GalleryFilter, query: string): GalleryEmptyState {
  if (query.trim()) return 'search'
  if (filter.kind === 'favorites') return 'favorites'
  if (filter.kind === 'uncategorized') return 'uncategorized'
  if (filter.kind === 'tag') return 'tag'
  if (filter.kind === 'category') return 'category'
  return 'library'
}

export type CommunitySort = 'newest' | 'name' | 'author'

/**
 * Ordering the directory cannot do for you: the server only ever answers "newest",
 * so a reader who wants to find a name in the list has to be given the sort here.
 * Ties fall back to the other fields so the order is stable across re-renders.
 */
export function sortCommunityItems<T extends { name: string; authorName: string; createdAt: number; id: string }>(
  items: readonly T[],
  sort: CommunitySort,
): T[] {
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
  return [...items].sort((a, b) => {
    if (sort === 'name') return collator.compare(a.name, b.name) || collator.compare(a.id, b.id)
    if (sort === 'author') return collator.compare(a.authorName, b.authorName) || collator.compare(a.name, b.name)
    return b.createdAt - a.createdAt || collator.compare(a.id, b.id)
  })
}

export function useGalleryDerived(
  templates: NoteTemplate[],
  filter: GalleryFilter,
  query: string,
  selectedIds: ReadonlySet<string>,
) {
  const counts = useMemo(() => {
    const byCategory = new Map<string, number>()
    const byTag = new Map<string, number>()
    let uncategorized = 0
    let starred = 0
    for (const template of templates) {
      if (template.categoryId === null) uncategorized++
      else byCategory.set(template.categoryId, (byCategory.get(template.categoryId) ?? 0) + 1)
      if (template.isStarred) starred++
      for (const tag of template.tags)
        byTag.set(tag, (byTag.get(tag) ?? 0) + 1)
    }
    return { byCategory, byTag, uncategorized, starred }
  }, [templates])
  const tagList = useMemo(() => [...counts.byTag.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  [counts.byTag])
  const visible = useMemo(() => {
    const matchesQuery = (template: NoteTemplate) => templateMatchesQuery(template, query)
    const list = templates.filter((template) => {
      if (filter.kind === 'favorites') return template.isStarred && matchesQuery(template)
      if (filter.kind === 'uncategorized') return template.categoryId === null && matchesQuery(template)
      if (filter.kind === 'community') return matchesQuery(template)
      if (filter.kind === 'category') return template.categoryId === filter.id && matchesQuery(template)
      if (filter.kind === 'tag') return template.tags.includes(filter.tag) && matchesQuery(template)
      return matchesQuery(template)
    })
    return [...list].sort(compareTemplates)
  }, [filter, query, templates])
  const selectedTemplates = useMemo(() => templates.filter((item) => selectedIds.has(item.id)), [selectedIds, templates])
  const visibleSelected = useMemo(() => visible.filter((item) => selectedIds.has(item.id)), [selectedIds, visible])
  const allVisibleSelected = visible.length > 0 && visibleSelected.length === visible.length
  const allSelectedStarred = selectedTemplates.length > 0 && selectedTemplates.every((item) => item.isStarred)
  const hasDeletableSelection = selectedTemplates.some((item) => !item.builtin)
  return {
    counts,
    tagList,
    visible,
    emptyState: galleryEmptyState(filter, query),
    selectedTemplates,
    visibleSelected,
    allVisibleSelected,
    allSelectedStarred,
    hasDeletableSelection,
  }
}
