import { LIMITS } from '@shared/constants'
import { isUsableTagName, normalizeLinkKey, replaceTagInContent, sortTagNames, tagKey, tagNamesEqual } from '@shared/markdown-utils'
import type { NoteSummary, Tag } from '@shared/types'
import { confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { setOptimisticTagCache, useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'

const TAG_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

interface TagColorWrite {
  committedColor: string | null
  sequence: number
  tail: Promise<void>
}

const tagColorWrites = new Map<string, TagColorWrite>()

export function normalizeTagName(value: string): string | null {
  const name = value.trim().replace(/^#+/, '')
  if (!isUsableTagName(name) || name.length > LIMITS.tagNameMaxLength) return null
  return name
}

export function createTag(value: string): string | null {
  const name = normalizeTagName(value)
  if (!name) {
    useUi.getState().toast({ title: t('tags.invalid_name'), tone: 'danger' })
    return null
  }
  const existing = useNotes.getState().tags.find((tag) => tagNamesEqual(tag.name, name))
  if (existing) return existing.id

  const id = newTagId()
  const optimistic: Tag = { id, name, color: null, count: 0, createdAt: Date.now() }
  setOptimisticTagCache((state) => ({ tags: [...state.tags, optimistic] }))
  void api.tags.create({ id, name }).then(
    () => {
      void useNotes.getState().refreshTags().catch(showRefreshWarning)
    },
    (error) => {
      setOptimisticTagCache((state) => ({
        tags: state.tags.filter((tag) => tag.id !== id),
      }))
      void useNotes.getState().refreshTags().catch(() => {})
      useUi.getState().toast({
        title: t('tags.create_failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    },
  )
  return id
}

export async function renameTag(tag: Tag, value: string): Promise<void> {
  const next = normalizeTagName(value)
  if (!next) {
    useUi.getState().toast({ title: t('tags.invalid_name'), tone: 'danger' })
    return
  }
  if (next === tag.name) return
  const tags = useNotes.getState().tags
  const target = tags.find((candidate) => candidate.id !== tag.id && tagNamesEqual(candidate.name, next))
  if (target) {
    const merge = await confirm({
      title: t('tags.merge_confirm_value0_value1', { value0: tag.name, value1: target.name }),
      description: t('tags.merge_description'),
      confirmLabel: t('tags.merge'),
    })
    if (!merge) return
  }

  const destination = target?.name ?? next
  const before = useNotes.getState()
  const beforeUi = useUi.getState()
  setOptimisticTagCache((state) => ({
    tags: optimisticRenameTags(state.tags, tag.id, destination),
    notes: rewriteNoteSummaryTags(state.notes, tag.name, destination),
  }))
  if (beforeUi.view === 'tag' && beforeUi.tags.includes(tag.name)) {
    beforeUi.openView('tag', { tags: beforeUi.tags.map((name) => name === tag.name ? destination : name) })
  }
  let result: Awaited<ReturnType<typeof api.tags.patch>>
  try {
    result = await api.tags.patch(tag.id, { name: next })
  } catch (error) {
    setOptimisticTagCache(() => ({ tags: before.tags, notes: before.notes }))
    const ui = useUi.getState()
    if (ui.view === 'tag' && ui.tags.includes(destination)) {
      ui.openView(beforeUi.view, { folderId: beforeUi.folderId, tags: beforeUi.tags })
    }
    ui.toast({
      title: t('tags.rename_failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
    return
  }

  let refreshed = true
  try {
    // The delta carries every note the server-side rewrite touched, and pull() falls back
    // to a full snapshot on its own when the server says the cursor is stale.
    await useNotes.getState().pull()
    rewriteLoadedNoteContents(tag.name, destination)
  } catch {
    refreshed = false
  }
  useUi.getState().toast({
    title: t('tags.renamed'),
    description: withRefreshWarning(t('tags.updated_note_bodies_value0', {
      value0: 'renamed' in result ? result.renamed : tag.count,
    }), refreshed),
    tone: refreshed ? 'success' : 'warning',
  })
}

export type TagSearchMode = 'new' | 'require' | 'exclude'

/**
 * The reference plugin hands tag expressions to Obsidian's global search. Here the note-list
 * search box is that surface: its text goes to /api/search verbatim, and that route understands
 * `tag:` (whole subtree) and `-tag:`, so the menu writes the same grammar a person can type.
 */
export function searchTag(tag: Tag, mode: TagSearchMode): void {
  const ui = useUi.getState()
  const expression = `${mode === 'exclude' ? '-' : ''}tag:#${tag.name}`
  if (mode === 'new') {
    ui.openSearchList(expression)
    return
  }
  const current = ui.searchQuery.trim()
  const absent = !current.toLowerCase().split(/\s+/).includes(expression.toLowerCase())
  ui.setSearchQuery(absent ? [current, expression].filter(Boolean).join(' ') : current)
  if (!ui.searchList) ui.openSearchList()
}

/**
 * A tag page is a note whose frontmatter alias spells the tag (`aliases: ["#a/b"]`), named after
 * it with the path separators turned into spaces. The alias is what makes the note carry the tag,
 * so a page shows up in the tag's own count without a second index to keep in sync.
 */
export function tagPageTitle(name: string): string {
  return name.split('/').filter(Boolean).join(' ')
}

export function findTagPage(tagName: string): NoteSummary | null {
  return findTagPageIn(useNotes.getState().notes, tagName)
}

export function findTagPageIn(notes: Record<string, NoteSummary>, tagName: string): NoteSummary | null {
  const wanted = normalizeLinkKey(tagPageTitle(tagName))
  for (const note of Object.values(notes)) {
    if (note.deletedAt) continue
    if (!note.tags.some((tag) => tagNamesEqual(tag, tagName))) continue
    if (normalizeLinkKey(note.title) === wanted) return note
  }
  return null
}

export async function createTagPage(tag: Tag): Promise<string | null> {
  const content = ['---', `aliases: ["#${tag.name}"]`, '---', ''].join('\n')
  return await useNotes.getState().createNote({ title: tagPageTitle(tag.name), content })
}

export async function openTagPage(tag: Tag): Promise<void> {
  const page = findTagPage(tag.name)
  if (page) {
    await useNotes.getState().openNote(page.id)
    return
  }
  const create = await confirm({
    title: t('tags.page_missing_value0', { value0: tag.name }),
    description: t('tags.page_missing_description'),
    confirmLabel: t('tags.create_page'),
  })
  if (!create) {
    useUi.getState().openView('tag', { tag: tag.name })
    return
  }
  await createTagPage(tag)
}

export async function deleteTag(tag: Tag): Promise<void> {
  const ok = await confirm({
    title: t('tags.delete_confirm_value0', { value0: tag.name }),
    description: t('tags.delete_description_value0', { value0: tag.count }),
    tone: 'danger',
    confirmLabel: t('tags.delete'),
  })
  if (!ok) return

  const before = useNotes.getState()
  const beforeUi = useUi.getState()
  setOptimisticTagCache((state) => ({
    tags: state.tags.filter((candidate) => candidate.id !== tag.id),
    notes: rewriteNoteSummaryTags(state.notes, tag.name, null),
  }))
  if (beforeUi.view === 'tag' && beforeUi.tags.includes(tag.name)) {
    const rest = beforeUi.tags.filter((name) => name !== tag.name)
    if (rest.length) beforeUi.openView('tag', { tags: rest })
    else beforeUi.openView('all')
  }
  let result: Awaited<ReturnType<typeof api.tags.remove>>
  try {
    result = await api.tags.remove(tag.id)
  } catch (error) {
    setOptimisticTagCache(() => ({ tags: before.tags, notes: before.notes }))
    const ui = useUi.getState()
    if (beforeUi.view === 'tag' && ui.view === 'all') ui.openView('tag', { tags: beforeUi.tags })
    ui.toast({
      title: t('tags.delete_failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
    return
  }

  let refreshed = true
  try {
    // The delta carries every note the server-side rewrite touched, and pull() falls back
    // to a full snapshot on its own when the server says the cursor is stale.
    await useNotes.getState().pull()
    rewriteLoadedNoteContents(tag.name, null)
  } catch {
    refreshed = false
  }
  useUi.getState().toast({
    title: t('tags.deleted'),
    description: withRefreshWarning(
      t('tags.updated_note_bodies_value0', { value0: result.affected }),
      refreshed,
    ),
    tone: refreshed ? 'success' : 'warning',
  })
}

export async function removeTagFromNote(noteId: string, name: string): Promise<void> {
  await useNotes.getState().openNote(noteId, { activate: false })
  const state = useNotes.getState()
  const content = state.contents[noteId]
  if (content === undefined) return
  const next = replaceTagInContent(content, name, null)
  if (next !== content) state.editContent(noteId, next)
}

export function tagMoveTarget(tag: Tag | null | undefined, parent: string | null): string | null {
  if (!tag) return null
  const leaf = tag.name.split('/').filter(Boolean).at(-1) ?? tag.name
  const destination = parent ? `${parent}/${leaf}` : leaf
  if (destination === tag.name) return null
  const lower = tagKey(destination)
  const source = tagKey(tag.name)
  if (lower === source || lower.startsWith(`${source}/`)) return null
  return destination
}

export async function moveTag(tag: Tag, parent: string | null): Promise<void> {
  const destination = tagMoveTarget(tag, parent)
  if (!destination) return
  const prefix = `${tag.name}/`
  const before = useNotes.getState()
  const beforeUi = useUi.getState()
  const remap = (name: string): string => name === tag.name
    ? destination
    : name.startsWith(prefix) ? destination + name.slice(prefix.length - 1) : name
  setOptimisticTagCache((state) => ({
    tags: state.tags.map((candidate) => ({ ...candidate, name: remap(candidate.name) })),
    notes: rewriteNoteTags(state.notes, remap),
  }))
  if (beforeUi.view === 'tag' && beforeUi.tags.length) {
    beforeUi.openView('tag', { tags: beforeUi.tags.map(remap) })
  }
  try {
    await api.tags.move(tag.id, parent)
  } catch (error) {
    // A failed move may still have renamed part of the family server-side, so restoring the
    // snapshot we took before our own optimistic edit would also undo any move that raced us.
    // Re-read instead of winding back.
    setOptimisticTagCache(() => ({ tags: before.tags, notes: before.notes }))
    await useNotes.getState().pull().catch(() => {})
    useUi.getState().toast({
      title: t('tags.move_failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
    return
  }
  let refreshed = true
  try {
    await useNotes.getState().pull()
    rewriteLoadedNoteContents(tag.name, destination)
  } catch {
    refreshed = false
  }
  useUi.getState().toast({
    title: t('tags.moved_value0', { value0: destination }),
    tone: refreshed ? 'success' : 'warning',
  })
}

function rewriteNoteTags(
  notes: Record<string, NoteSummary>,
  remap: (name: string) => string,
): Record<string, NoteSummary> {
  const next = { ...notes }
  for (const [id, note] of Object.entries(notes)) {
    if (!note.tags.some((name) => remap(name) !== name)) continue
    const unique = new Map(note.tags.map((name) => remap(name))
      .map((name) => [name.normalize('NFKC').toLocaleLowerCase(), name]))
    next[id] = { ...note, tags: sortTagNames(unique.values()) }
  }
  return next
}

export async function setTagColor(tag: Tag, color: string | null): Promise<void> {
  const cachedTag = useNotes.getState().tags.find((candidate) => candidate.id === tag.id)
  const currentColor = cachedTag ? cachedTag.color : tag.color
  if (currentColor === color) return

  const existingWrite = tagColorWrites.get(tag.id)
  const write = existingWrite ?? {
    committedColor: currentColor,
    sequence: 0,
    tail: Promise.resolve(),
  }
  if (!existingWrite) tagColorWrites.set(tag.id, write)
  const sequence = ++write.sequence

  setOptimisticTagCache((state) => ({
    tags: state.tags.map((candidate) => candidate.id === tag.id ? { ...candidate, color } : candidate),
  }))

  const operation = write.tail.then(async () => {
    try {
      await api.tags.patch(tag.id, { color })
      write.committedColor = color
    } catch (error) {
      if (sequence === write.sequence) {
        setOptimisticTagCache((state) => ({
          tags: state.tags.map((candidate) => candidate.id === tag.id && candidate.color === color
            ? { ...candidate, color: write.committedColor }
            : candidate),
        }))
        useUi.getState().toast({
          title: t('tags.color_failed'),
          description: error instanceof Error ? error.message : String(error),
          tone: 'danger',
        })
      }
      return
    }

    if (sequence === write.sequence) {
      await useNotes.getState().refreshTags().catch(showRefreshWarning)
    }
  })
  write.tail = operation.catch(() => {})
  await operation

  if (sequence === write.sequence && tagColorWrites.get(tag.id) === write) {
    tagColorWrites.delete(tag.id)
  }
}

export async function setTagPinned(tag: Tag, pinned: boolean): Promise<void> {
  const cached = useNotes.getState().tags.find((candidate) => candidate.id === tag.id)
  const current = Boolean(cached ? cached.isPinned : tag.isPinned)
  if (current === pinned) return

  setOptimisticTagCache((state) => ({
    tags: state.tags.map((candidate) => candidate.id === tag.id ? { ...candidate, isPinned: pinned } : candidate),
  }))
  try {
    await api.tags.patch(tag.id, { isPinned: pinned })
  } catch (error) {
    setOptimisticTagCache((state) => ({
      tags: state.tags.map((candidate) => candidate.id === tag.id && candidate.isPinned === pinned
        ? { ...candidate, isPinned: current }
        : candidate),
    }))
    useUi.getState().toast({
      title: t('tags.pin_failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
    return
  }
  await useNotes.getState().refreshTags().catch(showRefreshWarning)
}

function showRefreshWarning(): void {
  useUi.getState().toast({
    title: t('settings.operation_completed_but_refresh_failed'),
    tone: 'warning',
  })
}

function withRefreshWarning(description: string, refreshed: boolean): string {
  return refreshed
    ? description
    : `${description} ${t('settings.operation_completed_but_refresh_failed')}`
}

function optimisticRenameTags(tags: Tag[], sourceId: string, destination: string): Tag[] {
  const source = tags.find((tag) => tag.id === sourceId)
  if (!source) return tags
  const target = tags.find((tag) => tag.id !== sourceId && tagNamesEqual(tag.name, destination))
  if (!target) return tags.map((tag) => tag.id === sourceId ? { ...tag, name: destination } : tag)
  return tags
    .filter((tag) => tag.id !== sourceId)
    .map((tag) => tag.id === target.id ? { ...tag, count: Math.max(tag.count, source.count) } : tag)
}

function rewriteNoteSummaryTags(
  notes: Record<string, NoteSummary>,
  from: string,
  to: string | null,
): Record<string, NoteSummary> {
  const next = { ...notes }
  for (const [id, note] of Object.entries(notes)) {
    if (!note.tags.includes(from)) continue
    const names = note.tags.flatMap((name) => name === from ? (to ? [to] : []) : [name])
    const unique = new Map(names.map((name) => [name.normalize('NFKC').toLocaleLowerCase(), name]))
    next[id] = { ...note, tags: sortTagNames(unique.values()) }
  }
  return next
}

function rewriteLoadedNoteContents(from: string, to: string | null): void {
  const state = useNotes.getState()
  for (const [id, content] of Object.entries(state.contents)) {
    const rewritten = replaceTagInContent(content, from, to)
    if (rewritten !== content) state.editContent(id, rewritten)
  }
}

function newTagId(): string {
  let timestamp = ''
  let value = Date.now()
  for (let index = 0; index < 10; index++) {
    timestamp = TAG_ID_ALPHABET[value % 32] + timestamp
    value = Math.floor(value / 32)
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let random = ''
  for (const byte of bytes) random += TAG_ID_ALPHABET[byte & 31]
  return timestamp + random
}
