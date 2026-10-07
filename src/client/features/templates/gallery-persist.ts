import { TAG_LIST_SEPARATOR } from '@shared/markdown-utils'
export type GalleryFilter =
  | { kind: 'all' }
  | { kind: 'favorites' }
  | { kind: 'uncategorized' }
  | { kind: 'community' }
  | { kind: 'category'; id: string }
  | { kind: 'tag'; tag: string }

export const GALLERY_PERSIST_KEY = 'inkstone.template-gallery.v1'

const FILTER_KINDS = ['all', 'favorites', 'uncategorized', 'community', 'category', 'tag'] as const

/**
 * What the gallery remembers between visits. The search text is deliberately not
 * part of it: a shared browser would otherwise keep whatever the last person typed,
 * and a template search is a lookup, not a preference.
 */
export interface GalleryPersistedState {
  filter: GalleryFilter
  selectMode: boolean
}

export const DEFAULT_GALLERY_STATE: GalleryPersistedState = {
  filter: { kind: 'all' },
  selectMode: false,
}

/** localStorage is shared and hand-editable, so a malformed entry falls back rather than throws. */
export function loadGalleryPersist(): GalleryPersistedState {
  try {
    const raw = localStorage.getItem(GALLERY_PERSIST_KEY)
    if (!raw) return DEFAULT_GALLERY_STATE
    const value = JSON.parse(raw) as Partial<GalleryPersistedState>
    const filter = value.filter as GalleryFilter | undefined
    if (!filter || !FILTER_KINDS.includes(filter.kind)) return DEFAULT_GALLERY_STATE
    if (filter.kind === 'category' && typeof filter.id !== 'string') return DEFAULT_GALLERY_STATE
    if (filter.kind === 'tag' && typeof filter.tag !== 'string') return DEFAULT_GALLERY_STATE
    return {
      filter,
      selectMode: value.selectMode === true,
    }
  }
  catch {
    return DEFAULT_GALLERY_STATE
  }
}

export interface TemplateDraft {
  name: string
  description: string
  content: string
  categoryId: string | null
  tags: string[]
}

export const EMPTY_DRAFT: TemplateDraft = { name: '', description: '', content: '', categoryId: null, tags: [] }

/**
 * Tags are typed as one line, so every separator the app already accepts counts here:
 * both commas, the ideographic comma a Chinese keyboard produces, and a run of
 * whitespace — so `daily  reading` does not become one tag.
 */
export function splitTagInput(value: string): string[] {
  return value.split(TAG_LIST_SEPARATOR).filter(Boolean)
}
