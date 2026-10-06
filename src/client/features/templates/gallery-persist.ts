export type GalleryFilter =
  | { kind: 'all' }
  | { kind: 'favorites' }
  | { kind: 'uncategorized' }
  | { kind: 'community' }
  | { kind: 'category'; id: string }
  | { kind: 'tag'; tag: string }

export const GALLERY_PERSIST_KEY = 'inkstone.template-gallery.v1'

const FILTER_KINDS = ['all', 'favorites', 'uncategorized', 'community', 'category', 'tag'] as const

export interface GalleryPersistedState {
  filter: GalleryFilter
  query: string
  selectMode: boolean
}

export const DEFAULT_GALLERY_STATE: GalleryPersistedState = {
  filter: { kind: 'all' },
  query: '',
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
      query: typeof value.query === 'string' ? value.query.slice(0, 200) : '',
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
 * Tags are typed as one comma-separated line. The full-width comma is what a
 * Chinese keyboard produces, and a run of whitespace counts as a separator so
 * `daily  reading` does not become one tag.
 */
export function splitTagInput(value: string): string[] {
  return value.replaceAll('\uFF0C', ',').split(/[\s,]+/).filter(Boolean)
}
