import { useCallback } from 'react'
import type { CommunityTemplate, NoteTemplate, NoteTemplateCategory } from '@shared/types'
import type { MessageKey } from '@shared/locales/en-US'
import { TEMPLATE_IMPORT_LIMITS } from '@shared/note-templates'
import { interpolateNewNoteTemplate } from '@shared/note-template-render'
import { createNoteFromTemplate } from '../../lib/template-notes'
import { peekNoteContent } from '../preview/card-content'
import { useNotes } from '../../store/notes'
import { templateOrderValue, useNoteTemplates } from '../../store/note-templates'
import { useUi } from '../../store/ui'
import { confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import type { GalleryLocalState } from './gallery-state'

const TEMPLATE_NAME_MAX = TEMPLATE_IMPORT_LIMITS.maxNameLength

/**
 * Deleting stays reversible for as long as the toast is on screen, which is the only
 * window an undo button printed on it can honestly promise.
 */
function toastUndoableDelete(count: number, key: MessageKey) {
  if (count <= 0) return
  useUi.getState().toast({
    title: t(key, { value0: count }),
    tone: 'success',
    action: { label: t('common.undo'), run: () => void useNoteTemplates.getState().restoreUndoable() },
  })
}

/**
 * The two directions a note and the library can move in: this note becomes a
 * template, or a template becomes text at the caret of this note. Both need the note
 * that is open behind the panel, so both say so when there is none.
 */
export function useGalleryNoteBridge(state: GalleryLocalState, onClose: () => void) {
  const { setSavingNote } = state
  const activeNoteId = useUi((ui) => ui.activeNoteId)
  const activeTitle = useNotes((notes) => (activeNoteId ? notes.notes[activeNoteId]?.title ?? null : null))
  const saveActiveNoteAsTemplate = useCallback(() => {
    void (async () => {
      if (!activeNoteId) return
      const content = await peekNoteContent(activeNoteId)
      const ui = useUi.getState()
      if (!content || !content.trim()) {
        ui.toast({ title: t('templates.note_has_nothing_to_save'), tone: 'danger' })
        return
      }
      setSavingNote({
        name: (activeTitle ?? t('templates.template_from_note')).slice(0, TEMPLATE_NAME_MAX),
        description: '',
        content,
        categoryId: null,
        tags: [],
      })
    })()
  }, [activeNoteId, activeTitle, setSavingNote])
  const insertActiveNote = useCallback((template: NoteTemplate) => {
    const notes = useNotes.getState()
    const id = useUi.getState().activeNoteId
    const summary = id ? notes.notes[id] : null
    if (!id || !summary) {
      useUi.getState().toast({ title: t('templates.no_note_to_insert_into'), tone: 'danger' })
      return
    }
    const folder = summary.folderId ? notes.folders.find((item) => item.id === summary.folderId) : null
    const rendered = interpolateNewNoteTemplate(template.content, {
      title: summary.title || t('common.new_note'),
      folder: folder?.name ?? '',
      tags: (summary.tags ?? []).join(', '),
    })
    if (!rendered.content) return
    useUi.getState().requestTemplateInsert({ noteId: id, content: rendered.content, cursor: rendered.cursor })
    useUi.getState().toast({ title: t('templates.inserted_into_note'), tone: 'success' })
    onClose()
  }, [onClose])
  return { saveActiveNoteAsTemplate, insertActiveNote, hasActiveNote: Boolean(activeNoteId && activeTitle) }
}

export function useGalleryFilterActions(state: GalleryLocalState, categories: NoteTemplateCategory[]) {
  const { setFilter } = state
  const toggleTagFilter = useCallback((tag: string) => {
    setFilter((current) => current.kind === 'tag' && current.tag === tag
      ? { kind: 'all' }
      : { kind: 'tag', tag })
  }, [setFilter])
  const deleteCategory = useCallback(async (category: NoteTemplateCategory) => {
    const ok = await confirm({
      title: t('templates.delete_category'),
      description: t('templates.delete_category_confirm', { value0: category.name }),
      confirmLabel: t('templates.delete_category'),
      tone: 'danger',
    })
    if (!ok) return
    const removed = useNoteTemplates.getState().deleteCategory(category.id)
    if (removed)
      toastUndoableDelete(1, 'templates.deleted_category_toast_value0')
    setFilter((current) => current.kind === 'category' && current.id === category.id
      ? { kind: 'all' }
      : current)
  }, [setFilter])
  const categoryName = useCallback((id: string | null) => {
    if (id === null) return t('templates.uncategorized')
    return categories.find((item) => item.id === id)?.name ?? t('templates.uncategorized')
  }, [categories])
  return { toggleTagFilter, deleteCategory, categoryName }
}

export function useGalleryTemplateActions(state: GalleryLocalState, categories: NoteTemplateCategory[]) {
  const { onClose } = state
  const useTemplate = useCallback((template: NoteTemplate) => {
    void (async () => {
      if (await createNoteFromTemplate(template))
        onClose()
    })()
  }, [onClose])
  const deleteTemplate = useCallback(async (template: NoteTemplate) => {
    const ok = await confirm({
      title: t('templates.delete_template'),
      description: t('templates.delete_template_confirm'),
      confirmLabel: t('templates.delete_template'),
      tone: 'danger',
    })
    if (ok && useNoteTemplates.getState().deleteTemplate(template.id))
      toastUndoableDelete(1, 'templates.deleted_templates_toast_value0')
  }, [])
  const importCommunityTemplate = useCallback((item: CommunityTemplate) => {
    const match = categories.find((category) => category.name.toLocaleLowerCase() === item.category.toLocaleLowerCase())
    const id = useNoteTemplates.getState().createTemplate({
      name: item.name,
      description: item.description,
      content: item.content,
      categoryId: match?.id ?? null,
      tags: item.tags,
    })
    useUi.getState().toast({
      title: id ? t('templates.community_imported') : t('common.action_failed'),
      tone: id ? 'success' : 'danger',
    })
  }, [categories])
  const useCommunityTemplate = useCallback((item: CommunityTemplate) => {
    void (async () => {
      const now = Date.now()
      const created = await createNoteFromTemplate({
        id: item.id,
        categoryId: null,
        name: item.name,
        description: item.description,
        content: item.content,
        tags: item.tags,
        builtin: false,
        isPinned: false,
        isStarred: false,
        createdAt: item.createdAt || now,
        updatedAt: item.createdAt || now,
      })
      if (created)
        onClose()
    })()
  }, [onClose])
  return { useTemplate, deleteTemplate, importCommunityTemplate, useCommunityTemplate }
}

export function useGalleryCommunityActions(setCommunity: (updater: (current: CommunityTemplate[]) => CommunityTemplate[]) => void) {
  const unpublishCommunityTemplate = useCallback(async (item: CommunityTemplate) => {
    const ok = await confirm({
      title: t('templates.community_unpublish'),
      description: t('templates.community_unpublish_confirm'),
      confirmLabel: t('templates.community_unpublish'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.communityTemplates.remove(item.id)
      setCommunity((current) => current.filter((entry) => entry.id !== item.id))
      useUi.getState().toast({ title: t('templates.community_unpublished'), tone: 'success' })
    }
    catch {
      useUi.getState().toast({ title: t('common.action_failed'), tone: 'danger' })
    }
  }, [setCommunity])
  return { unpublishCommunityTemplate }
}

export function useGallerySelectActions(state: GalleryLocalState, visible: NoteTemplate[]) {
  const { setSelectedIds, setSelectMode, setFocusedId } = state
  const exitSelectMode = useCallback(() => {
    setSelectedIds(new Set())
    setSelectMode(false)
    setFocusedId(null)
  }, [setSelectedIds, setSelectMode, setFocusedId])
  const toggleSelectMode = useCallback(() => {
    setSelectMode((current) => !current)
    setSelectedIds(new Set())
    setFocusedId(null)
  }, [setSelectedIds, setSelectMode, setFocusedId])
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [setSelectedIds])
  const toggleSelectAll = useCallback(() => {
    setSelectedIds((current) => {
      if (visible.length > 0 && visible.every((item) => current.has(item.id)))
        return new Set()
      return new Set(visible.map((item) => item.id))
    })
  }, [visible])
  return { exitSelectMode, toggleSelectMode, toggleSelect, toggleSelectAll }
}

/**
 * Batch actions apply one store write per template. Each write re-serializes the
 * whole library, so the count reported back is the number that actually changed
 * rather than the size of the selection.
 */
/**
 * Batch actions take the store's batch primitives, so a selection costs one
 * library write instead of one per card. The count reported back is the number
 * that actually changed, not the size of the selection.
 */
export function runBatchStar(templates: readonly NoteTemplate[], starred: boolean): number {
  return useNoteTemplates.getState().applyBatch(
    templates.map((item) => item.id),
    (item) => (item.isStarred === starred ? null : { isStarred: starred }),
  )
}

export function runBatchMove(templates: readonly NoteTemplate[], categoryId: string | null): number {
  return useNoteTemplates.getState().applyBatch(
    templates.map((item) => item.id),
    (item) => (item.categoryId === categoryId ? null : { categoryId }),
  )
}

export function runBatchDelete(templates: readonly NoteTemplate[]): number {
  return useNoteTemplates.getState().removeTemplates(
    templates.filter((item) => !item.builtin).map((item) => item.id),
  )
}

export function useGalleryBatchActions(
  state: GalleryLocalState,
  selectedTemplates: NoteTemplate[],
  allSelectedStarred: boolean,
) {
  const { setSelectedIds, setIsBatchMoving } = state
  const batchToggleStar = useCallback(() => {
    const star = !allSelectedStarred
    const changed = runBatchStar(selectedTemplates, star)
    useUi.getState().toast({
      title: t(star ? 'templates.batch_starred_value0' : 'templates.batch_unstarred_value0', { value0: changed }),
      tone: 'success',
    })
  }, [allSelectedStarred, selectedTemplates])
  const batchMove = useCallback((categoryId: string | null) => {
    const moved = runBatchMove(selectedTemplates, categoryId)
    setSelectedIds(new Set())
    setIsBatchMoving(false)
    useUi.getState().toast({ title: t('templates.batch_moved_value0', { value0: moved }), tone: 'success' })
  }, [selectedTemplates, setSelectedIds, setIsBatchMoving])
  const batchDelete = useCallback(async () => {
    const deletable = selectedTemplates.filter((item) => !item.builtin)
    const ok = await confirm({
      title: t('templates.delete_template'),
      description: t('templates.batch_delete_confirm_value0', { value0: deletable.length }),
      confirmLabel: t('templates.delete_template'),
      tone: 'danger',
    })
    if (!ok) return
    const deleted = runBatchDelete(selectedTemplates)
    setSelectedIds(new Set())
    toastUndoableDelete(deleted, 'templates.batch_deleted_value0')
  }, [selectedTemplates, setSelectedIds])
  return { batchToggleStar, batchMove, batchDelete }
}

export function useGalleryDragActions(state: GalleryLocalState, templates: NoteTemplate[]) {
  const { draggingId, setDraggingId, setDropHint, setDropCategory } = state
  const handleCardDrop = useCallback((target: NoteTemplate, after: boolean) => {
    const source = templates.find((item) => item.id === draggingId)
    if (!source || source.id === target.id) {
      setDraggingId(null)
      setDropHint(null)
      return
    }
    const siblings = templates
      .filter((item) => item.categoryId === target.categoryId && item.id !== source.id)
      .sort((a, b) => templateOrderValue(a) - templateOrderValue(b))
    let index = siblings.findIndex((item) => item.id === target.id)
    if (index < 0) index = siblings.length
    if (after) index += 1
    useNoteTemplates.getState().placeTemplate(source.id, target.categoryId, index)
    setDraggingId(null)
    setDropHint(null)
  }, [draggingId, templates, setDraggingId, setDropHint])
  const handleCategoryDrop = useCallback((categoryId: string | null) => {
    const source = templates.find((item) => item.id === draggingId)
    if (source) {
      const index = templates.filter((item) => item.categoryId === categoryId && item.id !== source.id).length
      useNoteTemplates.getState().placeTemplate(source.id, categoryId, index)
    }
    setDraggingId(null)
    setDropHint(null)
    setDropCategory(null)
  }, [draggingId, templates, setDraggingId, setDropHint, setDropCategory])
  return { handleCardDrop, handleCategoryDrop }
}
