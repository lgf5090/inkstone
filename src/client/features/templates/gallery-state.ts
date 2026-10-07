import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommunityTemplate, NoteTemplate, NoteTemplateCategory } from '@shared/types'
import { useSession } from '../../store/session'
import { useNoteTemplates } from '../../store/note-templates'
import { useDialogFocus, useEscape, useLockScroll } from '../../components/overlay'
import { api } from '../../lib/api'
import { GALLERY_PERSIST_KEY, loadGalleryPersist, type GalleryFilter, type GalleryPersistedState, type TemplateDraft } from './gallery-persist'

export function useGalleryLocalState({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const [persisted] = useState(loadGalleryPersist)
  const [filter, setFilter] = useState<GalleryFilter>(persisted.filter)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<NoteTemplate | 'new' | null>(null)
  const [renaming, setRenaming] = useState<NoteTemplate | null>(null)
  const [moving, setMoving] = useState<NoteTemplate | null>(null)
  const [categoryDialog, setCategoryDialog] = useState<
    { mode: 'create' } | { mode: 'rename'; category: NoteTemplateCategory } | null
  >(null)
  const [isMoreOpen, setIsMoreOpen] = useState(false)
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [isHelpOpen, setIsHelpOpen] = useState(false)
  const [selectMode, setSelectMode] = useState(persisted.selectMode)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [isBatchMoving, setIsBatchMoving] = useState(false)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [searchFocused, setSearchFocused] = useState(false)
  const [savingNote, setSavingNote] = useState<TemplateDraft | null>(null)
  const [previewing, setPreviewing] = useState<NoteTemplate | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null)
  const [dropCategory, setDropCategory] = useState<string | null>(null)
  const [publishing, setPublishing] = useState<NoteTemplate | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const currentUserId = useSession((state) => state.user?.id)
  useEscape(true, () => {
    if (selectMode) {
      setSelectedIds(new Set())
      setSelectMode(false)
    }
    else {
      onClose()
    }
  })
  useLockScroll(true)
  useDialogFocus(true, panelRef, searchRef)
  return {
    onClose,
    panelRef,
    searchRef,
    moreButtonRef,
    filter,
    setFilter,
    query,
    setQuery,
    editing,
    setEditing,
    renaming,
    setRenaming,
    moving,
    setMoving,
    categoryDialog,
    setCategoryDialog,
    isMoreOpen,
    setIsMoreOpen,
    isImportOpen,
    setIsImportOpen,
    isHelpOpen,
    setIsHelpOpen,
    selectMode,
    setSelectMode,
    selectedIds,
    setSelectedIds,
    isBatchMoving,
    setIsBatchMoving,
    focusedId,
    setFocusedId,
    searchFocused,
    setSearchFocused,
    savingNote,
    setSavingNote,
    previewing,
    setPreviewing,
    draggingId,
    setDraggingId,
    dropHint,
    setDropHint,
    dropCategory,
    setDropCategory,
    publishing,
    setPublishing,
    gridRef,
    currentUserId,
  }
}

export type GalleryLocalState = ReturnType<typeof useGalleryLocalState>

export function useGalleryStoreState(owner: string) {
  const categories = useNoteTemplates((state) => state.categories)
  const templates = useNoteTemplates((state) => state.templates)
  const hydrated = useNoteTemplates((state) => state.hydrated)
  const hydrate = useNoteTemplates((state) => state.hydrate)
  const togglePin = useNoteTemplates((state) => state.toggleTemplatePin)
  const toggleStar = useNoteTemplates((state) => state.toggleTemplateStar)
  useEffect(() => {
    if (!owner) return
    void hydrate(owner).catch((error) => {
      console.warn('[templates] failed to hydrate the template library', error)
    })
  }, [owner, hydrate])
  return { categories, templates, hydrated, togglePin, toggleStar }
}

const PERSIST_DEBOUNCE_MS = 300

/**
 * The filter and selection are remembered between visits, but the search box is
 * typed one character at a time, so the write is deferred: persisting per
 * keystroke put a synchronous localStorage flush in front of every repaint.
 */
export function useGalleryEffects(state: GalleryLocalState, store: ReturnType<typeof useGalleryStoreState>) {
  const { filter, selectMode, setFilter } = state
  // Preferences, not data: a filter change dropped in the last debounce window costs
  // the next visit its remembered view, and nothing the user authored with it.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      localStorage.setItem(GALLERY_PERSIST_KEY, JSON.stringify({ filter, selectMode } satisfies GalleryPersistedState))
    }, PERSIST_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [filter, selectMode])
  useEffect(() => {
    if (!store.hydrated) return
    setFilter((current) => {
      if (current.kind === 'category' && !store.categories.some((item) => item.id === current.id))
        return { kind: 'all' }
      if (current.kind === 'tag' && !store.templates.some((item) => item.tags.includes(current.tag)))
        return { kind: 'all' }
      return current
    })
  }, [store.categories, store.hydrated, store.templates, setFilter])
}

const COMMUNITY_PAGE_SIZE = 50

export function useGalleryCommunity(filter: GalleryFilter) {
  const [community, setCommunity] = useState<CommunityTemplate[]>([])
  const [isCommunityLoading, setIsCommunityLoading] = useState(false)
  const [isCommunityError, setIsCommunityError] = useState(false)
  const [hasMoreCommunity, setHasMoreCommunity] = useState(false)
  const communityLoadedRef = useRef(false)
  const requestRef = useRef(0)
  const cursorRef = useRef<string | null>(null)
  const fetchPage = useCallback(async (cursor: string | undefined, append: boolean) => {
    const request = ++requestRef.current
    setIsCommunityLoading(true)
    setIsCommunityError(false)
    try {
      const res = await api.communityTemplates.list(cursor, COMMUNITY_PAGE_SIZE)
      if (request !== requestRef.current) return
      if (append) setCommunity((current) => [...current, ...res.templates])
      else setCommunity(res.templates)
      cursorRef.current = res.nextCursor
      setHasMoreCommunity(Boolean(res.hasMore && res.nextCursor))
    }
    catch {
      if (request !== requestRef.current) return
      setIsCommunityError(true)
    }
    finally {
      if (request === requestRef.current) setIsCommunityLoading(false)
    }
  }, [])
  const refreshCommunity = useCallback(() => fetchPage(undefined, false), [fetchPage])
  const loadMoreCommunity = useCallback(() => {
    if (!cursorRef.current) return Promise.resolve()
    return fetchPage(cursorRef.current, true)
  }, [fetchPage])
  useEffect(() => {
    if (filter.kind !== 'community' || communityLoadedRef.current) return
    communityLoadedRef.current = true
    void refreshCommunity()
  }, [filter.kind, refreshCommunity])
  return {
    community,
    setCommunity,
    isCommunityLoading,
    isCommunityError,
    hasMoreCommunity,
    refreshCommunity,
    loadMoreCommunity,
  }
}
