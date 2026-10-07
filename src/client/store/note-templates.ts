/** Coordinates the client-side template library: built-in seeding, categories and CRUD. */
import { create, type StoreApi } from 'zustand'
import type { NoteTemplate, NoteTemplateCategory } from '@shared/types'
import {
  BUILTIN_TEMPLATE_CATEGORIES,
  BUILTIN_TEMPLATE_DEFS,
  BUILTIN_TEMPLATE_TAG_LABELS,
  TEMPLATE_IMPORT_LIMITS,
  TEMPLATE_SEED_VERSION,
  buildTemplateLibraryExport,
  parseTemplateLibraryExport,
  type BuiltinTemplateDef,
  type TemplateLibraryExport,
} from '@shared/note-templates'
import { api, CLIENT_ID } from '../lib/api'
import { normalizeOrganizerIcon, organizerColorOrNull } from '@shared/organizer-colors'
import { createBroadcast, localDb, publishBroadcast, type TemplateLibraryData } from '../lib/db'
import { randomLocalId } from '../lib/random-id'
import { ensureNoteTemplateContentLoaded, t } from '../lib/i18n'

interface TemplateInput {
  name: string
  description?: string
  content: string
  categoryId?: string | null
  tags?: string[]
}

/** Everything a destructive action can take away, kept so one toast button can give it back. */
interface TemplateLibrarySnapshot {
  categories: NoteTemplateCategory[]
  templates: NoteTemplate[]
}

interface TemplateLibraryState {
  categories: NoteTemplateCategory[]
  templates: NoteTemplate[]
  hydrated: boolean
  /**
   * The library as it was before the last destructive action, kept in memory only.
   * One step deep, because that is all a toast's undo button promises.
   */
  undoable: TemplateLibrarySnapshot | null
  /** Account the hydrated library belongs to; a change forces a re-read. */
  owner: string
  hydrate: (owner: string) => Promise<void>
  /** Take the account's copy as it stands: what a backup restore just wrote. */
  reloadFromAccount: (owner: string) => Promise<void>
  createCategory: (name: string, icon?: string | null, color?: string | null) => string | null
  renameCategory: (id: string, name: string, icon?: string | null, color?: string | null) => boolean
  deleteCategory: (id: string) => boolean
  createTemplate: (input: TemplateInput) => string | null
  updateTemplate: (id: string, patch: Partial<TemplateInput>) => boolean
  deleteTemplate: (id: string) => boolean
  duplicateTemplate: (id: string) => string | null
  placeTemplate: (id: string, categoryId: string | null, index: number) => boolean
  importTemplates: (data: TemplateLibraryExport) => { imported: number; skipped: number }
  toggleTemplatePin: (id: string) => void
  toggleTemplateStar: (id: string) => void
  /** One write for a whole selection; the patch returns null to leave a template alone. */
  applyBatch: (ids: readonly string[], patchFor: (template: NoteTemplate) => Partial<NoteTemplate> | null) => number
  /** One write for a whole selection of removals; built-ins are refused. */
  removeTemplates: (ids: readonly string[]) => number
  /** Give back what the last destructive action took. False when there is nothing to give back. */
  restoreUndoable: () => boolean
}

const NAME_MAX = TEMPLATE_IMPORT_LIMITS.maxNameLength
const DESCRIPTION_MAX = TEMPLATE_IMPORT_LIMITS.maxDescriptionLength

function normalizeTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tags ?? []) {
    const tag = raw.trim()
    if (!tag || seen.has(tag) || result.length >= TEMPLATE_IMPORT_LIMITS.maxTagsPerTemplate) continue
    seen.add(tag)
    result.push(tag.slice(0, TEMPLATE_IMPORT_LIMITS.maxTagLength))
  }
  return result
}

const BUILTIN_DEF_BY_ID = new Map(BUILTIN_TEMPLATE_DEFS.map((def) => [def.id, def]))
const BUILTIN_CATEGORY_POSITION = new Map(
  BUILTIN_TEMPLATE_CATEGORIES.map((def, index) => [def.id, index] as const),
)

export function templateOrderValue(template: NoteTemplate): number {
  return template.position ?? Number.MAX_SAFE_INTEGER - template.updatedAt
}

export function compareTemplates(a: NoteTemplate, b: NoteTemplate): number {
  return Number(b.isPinned) - Number(a.isPinned) ||
    Number(b.isStarred) - Number(a.isStarred) ||
    templateOrderValue(a) - templateOrderValue(b)
}

function builtinTags(def: BuiltinTemplateDef): string[] {
  return def.tags.map((key) => t(BUILTIN_TEMPLATE_TAG_LABELS[key]))
}

function builtinTemplate(def: BuiltinTemplateDef, position: number, now: number): NoteTemplate {
  return {
    id: def.id,
    categoryId: def.categoryId,
    name: t(def.nameKey),
    description: t(def.descriptionKey),
    content: t(def.contentKey),
    tags: builtinTags(def),
    builtin: true,
    isPinned: false,
    isStarred: false,
    position,
    createdAt: now,
    updatedAt: now,
  }
}

function buildBuiltinLibrary(): TemplateLibraryData {
  const now = Date.now()
  return {
    categories: BUILTIN_TEMPLATE_CATEGORIES.map((def, index) => ({
      id: def.id,
      name: t(def.nameKey),
      builtin: true,
      position: index,
      createdAt: now,
      icon: def.icon,
      color: def.color,
    })),
    templates: BUILTIN_TEMPLATE_DEFS.map((def, index) => builtinTemplate(def, index, now)),
    seedVersion: TEMPLATE_SEED_VERSION,
    syncedAt: 0,
    pendingPush: false,
  }
}

function orderedCategories(categories: NoteTemplateCategory[]): NoteTemplateCategory[] {
  return [...categories].sort((a, b) => {
    const aPos = BUILTIN_CATEGORY_POSITION.get(a.id)
    const bPos = BUILTIN_CATEGORY_POSITION.get(b.id)
    if (aPos !== undefined && bPos !== undefined) return aPos - bPos
    if (aPos !== undefined) return -1
    if (bPos !== undefined) return 1
    return a.createdAt - b.createdAt
  })
}

function sameTemplateText(a: NoteTemplate, b: NoteTemplate): boolean {
  return a.name === b.name &&
    a.description === b.description &&
    a.content === b.content &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, index) => tag === b.tags[index])
}

/**
 * Re-read the catalog for the entries the user never touched. Editing a built-in
 * flips `builtin` to false, so a customized copy keeps its text and only the
 * pristine ones follow the interface language and catalog changes.
 */
function refreshBuiltinTemplates(templates: NoteTemplate[]): { templates: NoteTemplate[]; changed: boolean } {
  let changed = false
  const next = templates.map((item) => {
    const def = BUILTIN_DEF_BY_ID.get(item.id)
    if (!def || !item.builtin) return item
    const refreshed = {
      ...item,
      name: t(def.nameKey),
      description: t(def.descriptionKey),
      content: t(def.contentKey),
      tags: builtinTags(def),
    }
    if (sameTemplateText(item, refreshed)) return item
    changed = true
    return refreshed
  })
  return { templates: next, changed }
}

function missingBuiltinTemplates(existingIds: Set<string>, now: number): NoteTemplate[] {
  const added: NoteTemplate[] = []
  BUILTIN_TEMPLATE_DEFS.forEach((def, index) => {
    if (existingIds.has(def.id)) return
    added.push(builtinTemplate(def, index, now))
  })
  return added
}

function missingBuiltinCategories(existingIds: Set<string>, now: number): NoteTemplateCategory[] {
  const added: NoteTemplateCategory[] = []
  for (const def of BUILTIN_TEMPLATE_CATEGORIES) {
    if (existingIds.has(def.id)) continue
    added.push({
      id: def.id,
      name: t(def.nameKey),
      builtin: true,
      position: def.position,
      createdAt: now,
      icon: def.icon,
      color: def.color,
    })
  }
  return added
}

/**
 * Bring an existing library up to the current catalog without touching anything
 * the user made or edited. Returns the same object when there is nothing to
 * write, so hydration can skip a pointless save.
 */
function mergeBuiltinSeed(current: TemplateLibraryData): TemplateLibraryData {
  const existingTemplateIds = new Set(current.templates.map((item) => item.id))
  const existingCategoryIds = new Set(current.categories.map((item) => item.id))
  const refreshed = refreshBuiltinTemplates(current.templates)
  const addedTemplates = current.seedVersion >= TEMPLATE_SEED_VERSION
    ? []
    : missingBuiltinTemplates(existingTemplateIds, Date.now())
  const addedCategories = current.seedVersion >= TEMPLATE_SEED_VERSION
    ? []
    : missingBuiltinCategories(existingCategoryIds, Date.now())
  if (!refreshed.changed && !addedTemplates.length && !addedCategories.length)
    return current.seedVersion >= TEMPLATE_SEED_VERSION ? current : { ...current, seedVersion: TEMPLATE_SEED_VERSION }
  return {
    categories: orderedCategories([...current.categories, ...addedCategories]),
    templates: [...refreshed.templates, ...addedTemplates],
    seedVersion: TEMPLATE_SEED_VERSION,
    syncedAt: current.syncedAt,
    pendingPush: current.pendingPush,
  }
}

type SetTemplateState = StoreApi<TemplateLibraryState>['setState']

let hydrateChain: Promise<void> = Promise.resolve()
let hydrateRequested: string | null = null
let tabWatcher: { close: () => void } | null = null

/**
 * Re-read the library when another tab says it wrote one.
 *
 * The read replaces the in-memory copy instead of merging into it: the other tab
 * wrote the whole record, so anything this tab still holds that is not in that
 * record was never written anywhere.
 */
function watchOtherTabs(): void {
  if (tabWatcher) return
  tabWatcher = createBroadcast((payload) => {
    if (payload.type !== 'template-library-changed' || payload.clientId === CLIENT_ID) return
    const { owner } = useNoteTemplates.getState()
    if (!owner) return
    useNoteTemplates.setState({ hydrated: false })
    void useNoteTemplates.getState().hydrate(owner)
  })
}

/**
 * The account server keeps one copy of the library, so it survives a cleared
 * browser and follows the user to another device — the same durability class as
 * `settings`. Local writes are debounced because a batch click is one intent, and
 * a failed push leaves `pendingPush` set, which is what makes the next change (or
 * the next hydrate) retry instead of dropping the edit.
 */
const PUSH_DELAY_MS = 1200
let lastSyncedAt = 0
let mutations = 0
let pushTimer: ReturnType<typeof setTimeout> | null = null

function schedulePush(): void {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    void pushLibrary()
  }, PUSH_DELAY_MS)
}

async function pushLibrary(): Promise<void> {
  const { owner, categories, templates } = useNoteTemplates.getState()
  if (!owner || !templates.length) return
  const at = mutations
  try {
    const saved = await api.templateLibrary.save(JSON.stringify(buildTemplateLibraryExport(categories, templates)))
    lastSyncedAt = saved.savedAt
    const current = useNoteTemplates.getState()
    await localDb.saveTemplateLibrary({
      categories: current.categories,
      templates: current.templates,
      seedVersion: TEMPLATE_SEED_VERSION,
      syncedAt: saved.savedAt,
      pendingPush: mutations !== at,
    })
  } catch {
  }
}

async function readRemoteLibrary(): Promise<TemplateLibraryData | null> {
  try {
    const remote = await api.templateLibrary.load()
    if (!remote.library || !(remote.savedAt > 0)) return null
    const parsed = parseTemplateLibraryExport(JSON.stringify(remote.library), { keepFlags: true })
    if (!parsed.data) return null
    return {
      categories: parsed.data.categories,
      templates: parsed.data.templates,
      // The snapshot only ever carries what the user made, so it has not been
      // seeded: claiming the current version here would drop the built-in catalog.
      seedVersion: 0,
      syncedAt: remote.savedAt,
      pendingPush: false,
    }
  } catch {
    return null
  }
}

export const useNoteTemplates = create<TemplateLibraryState>((set, get) => ({
  categories: [],
  templates: [],
  hydrated: false,
  undoable: null,
  owner: '',
  hydrate: (owner) => hydrateImpl(set, get, owner),
  reloadFromAccount: async (owner) => {
    if (!owner) return
    const stored = await localDb.loadTemplateLibrary()
    if (stored?.pendingPush) {
      await localDb.saveTemplateLibrary({ ...stored, pendingPush: false })
    }
    useNoteTemplates.setState({ hydrated: false })
    await get().hydrate(owner)
  },
  createCategory: (name, icon, color) => createCategoryImpl(set, name, icon, color),
  renameCategory: (id, name, icon, color) => renameCategoryImpl(set, get, id, name, icon, color),
  deleteCategory: (id) => deleteCategoryImpl(set, get, id),
  createTemplate: (input) => createTemplateImpl(set, input),
  updateTemplate: (id, patch) => updateTemplateImpl(set, get, id, patch),
  deleteTemplate: (id) => deleteTemplateImpl(set, get, id),
  duplicateTemplate: (id) => duplicateTemplateImpl(set, get, id),
  placeTemplate: (id, categoryId, index) => placeTemplateImpl(set, get, id, categoryId, index),
  importTemplates: (data) => importTemplatesImpl(set, data),
  toggleTemplatePin: (id) => toggleTemplateFlag(set, id, 'isPinned'),
  toggleTemplateStar: (id) => toggleTemplateFlag(set, id, 'isStarred'),
  applyBatch: (ids, patchFor) => applyBatchImpl(set, ids, patchFor),
  removeTemplates: (ids) => removeTemplatesImpl(set, ids),
  restoreUndoable: () => restoreUndoableImpl(set, get),
}))

/**
 * Read the library for `owner`. Hydration is keyed to the account because the
 * record is stored per user: keyed on nothing, a second sign-in in one browser
 * would keep showing the first account's templates. Runs are chained so a slow
 * read for the previous account can never land after the new one has.
 */
function hydrateImpl(
  set: SetTemplateState,
  get: () => TemplateLibraryState,
  owner: string,
): Promise<void> {
  if (!owner) return Promise.resolve()
  watchOtherTabs()
  if (get().hydrated && get().owner === owner) return Promise.resolve()
  const run = async (): Promise<void> => {
    if (get().hydrated && get().owner === owner) return
    await ensureNoteTemplateContentLoaded()
    const stored = await localDb.loadTemplateLibrary()
    const remote = await readRemoteLibrary()
    const takeRemote = remote !== null && !(stored?.pendingPush) && remote.syncedAt > (stored?.syncedAt ?? 0)
    const base = takeRemote ? remote : stored
    const next = base ? mergeBuiltinSeed(base) : buildBuiltinLibrary()
    if (next !== stored) await localDb.saveTemplateLibrary(next)
    lastSyncedAt = next.syncedAt
    if (next.pendingPush) schedulePush()
    // The account moved on while this read was in flight, so its result belongs
    // to nobody: publishing it would show one account's library under another.
    if (hydrateRequested !== owner) return
    set({
      categories: orderedCategories(next.categories),
      templates: next.templates,
      hydrated: true,
      owner,
    })
  }
  hydrateRequested = owner
  hydrateChain = hydrateChain.then(run, run)
  return hydrateChain
}

function persist(templates: NoteTemplate[], categories: NoteTemplateCategory[]): void {
  void localDb.saveTemplateLibrary({
    categories,
    templates,
    seedVersion: TEMPLATE_SEED_VERSION,
    syncedAt: lastSyncedAt,
    pendingPush: true,
  })
  // A whole-library write from this tab makes every other tab's copy stale, and
  // each of them writes its own copy back on its next mutation. Saying so is what
  // keeps two tabs open in one browser from erasing each other. Seeding on read
  // writes through `localDb` directly and stays quiet, so this cannot echo back.
  publishBroadcast({ type: 'template-library-changed', clientId: CLIENT_ID })
  mutations += 1
  schedulePush()
}

function nextPositionIn(templates: NoteTemplate[], categoryId: string | null): number {
  const siblings = templates.filter((item) => item.categoryId === categoryId)
  return siblings.length
    ? siblings.reduce((max, item) => Math.max(max, templateOrderValue(item)), -1) + 1
    : 0
}

function createCategoryImpl(
  set: SetTemplateState,
  name: string,
  icon: string | null = null,
  color: string | null = null,
): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const id = randomLocalId('cat')
  const now = Date.now()
  set((state) => {
    const categories = [...state.categories, {
      id,
      name: trimmed.slice(0, NAME_MAX),
      builtin: false,
      position: state.categories.length,
      createdAt: now,
      icon: normalizeOrganizerIcon(icon),
      color: organizerColorOrNull(color),
    }]
    persist(state.templates, categories)
    return { categories: orderedCategories(categories) }
  })
  return id
}

function renameCategoryImpl(
  set: SetTemplateState,
  get: () => TemplateLibraryState,
  id: string,
  name: string,
  icon?: string | null,
  color?: string | null,
): boolean {
  const trimmed = name.trim()
  const current = get().categories.find((item) => item.id === id)
  if (!current || current.builtin || !trimmed) return false
  const nextIcon = icon === undefined ? (current.icon ?? null) : normalizeOrganizerIcon(icon)
  const nextColor = color === undefined ? (current.color ?? null) : organizerColorOrNull(color)
  set((state) => {
    const categories = state.categories.map((item) => item.id === id
      ? { ...item, name: trimmed.slice(0, NAME_MAX), icon: nextIcon, color: nextColor }
      : item)
    persist(state.templates, categories)
    return { categories }
  })
  return true
}

function deleteCategoryImpl(
  set: SetTemplateState,
  get: () => TemplateLibraryState,
  id: string,
): boolean {
  const current = get().categories.find((item) => item.id === id)
  if (!current || current.builtin) return false
  set((state) => {
    const categories = state.categories.filter((item) => item.id !== id)
    const templates = state.templates.map((item) => item.categoryId === id
      ? { ...item, categoryId: null }
      : item)
    persist(templates, categories)
    return { categories, templates, undoable: snapshotOf(state) }
  })
  return true
}

function createTemplateImpl(set: SetTemplateState, input: TemplateInput): string | null {
  const name = input.name.trim()
  if (!name || !input.content) return null
  const id = randomLocalId('tpl')
  const now = Date.now()
  set((state) => {
    const categoryId = input.categoryId ?? null
    const templates = [...state.templates, {
      id,
      categoryId,
      name: name.slice(0, NAME_MAX),
      description: (input.description ?? '').slice(0, DESCRIPTION_MAX),
      content: input.content,
      tags: normalizeTags(input.tags),
      builtin: false,
      isPinned: false,
      isStarred: false,
      position: nextPositionIn(state.templates, categoryId),
      createdAt: now,
      updatedAt: now,
    }]
    persist(templates, state.categories)
    return { templates }
  })
  return id
}

function updateTemplateImpl(
  set: SetTemplateState,
  get: () => TemplateLibraryState,
  id: string,
  patch: Partial<TemplateInput>,
): boolean {
  const current = get().templates.find((item) => item.id === id)
  if (!current) return false
  const name = patch.name?.trim()
  if (name !== undefined && !name) return false
  if (patch.content !== undefined && !patch.content) return false
  set((state) => {
    const templates = state.templates.map((item) => item.id === id
      ? {
        ...item,
        // Customizing a built-in template hands ownership to the user, so it
        // becomes deletable and drops the built-in badge.
        builtin: false,
        name: name !== undefined ? name.slice(0, NAME_MAX) : item.name,
        description: patch.description !== undefined
          ? patch.description.slice(0, DESCRIPTION_MAX)
          : item.description,
        content: patch.content !== undefined ? patch.content : item.content,
        categoryId: patch.categoryId !== undefined ? (patch.categoryId ?? null) : item.categoryId,
        tags: patch.tags !== undefined ? normalizeTags(patch.tags) : item.tags,
        updatedAt: Date.now(),
      }
      : item)
    persist(templates, state.categories)
    return { templates }
  })
  return true
}

function deleteTemplateImpl(
  set: SetTemplateState,
  get: () => TemplateLibraryState,
  id: string,
): boolean {
  const current = get().templates.find((item) => item.id === id)
  if (!current || current.builtin) return false
  set((state) => {
    const templates = state.templates.filter((item) => item.id !== id)
    persist(templates, state.categories)
    return { templates, undoable: snapshotOf(state) }
  })
  return true
}

function duplicateTemplateImpl(
  set: SetTemplateState,
  get: () => TemplateLibraryState,
  id: string,
): string | null {
  const source = get().templates.find((item) => item.id === id)
  if (!source) return null
  const copyId = randomLocalId('tpl')
  const now = Date.now()
  set((state) => {
    const templates = [...state.templates, {
      ...source,
      id: copyId,
      name: `${source.name} (${t('common.copy')})`.slice(0, NAME_MAX),
      builtin: false,
      isPinned: false,
      isStarred: false,
      position: nextPositionIn(state.templates, source.categoryId),
      createdAt: now,
      updatedAt: now,
    }]
    persist(templates, state.categories)
    return { templates }
  })
  return copyId
}

function placeTemplateImpl(
  set: SetTemplateState,
  get: () => TemplateLibraryState,
  id: string,
  categoryId: string | null,
  index: number,
): boolean {
  const moving = get().templates.find((item) => item.id === id)
  if (!moving) return false
  const now = Date.now()
  set((state) => {
    const siblings = state.templates
      .filter((item) => item.categoryId === categoryId && item.id !== id)
      .sort((a, b) => templateOrderValue(a) - templateOrderValue(b))
    const clamped = Math.max(0, Math.min(siblings.length, Math.trunc(index) || 0))
    const ordered = [...siblings.slice(0, clamped), { ...moving, categoryId }, ...siblings.slice(clamped)]
    const positionById = new Map(ordered.map((item, position) => [item.id, position]))
    const templates = state.templates.map((item) => positionById.has(item.id)
      ? { ...item, categoryId, position: positionById.get(item.id), updatedAt: now }
      : item)
    persist(templates, state.categories)
    return { templates }
  })
  return true
}

function importTemplatesImpl(
  set: SetTemplateState,
  data: TemplateLibraryExport,
): { imported: number; skipped: number } {
  let imported = 0
  let skipped = 0
  set((state) => {
    const knownCategoryIds = new Set(state.categories.map((item) => item.id))
    const nextCategories = [...state.categories]
    let nextPosition = nextCategories.reduce((max, item) => Math.max(max, item.position), -1) + 1
    for (const category of data.categories) {
      if (knownCategoryIds.has(category.id)) continue
      knownCategoryIds.add(category.id)
      nextCategories.push({ ...category, name: category.name.slice(0, NAME_MAX), position: nextPosition++ })
    }
    const knownTemplateIds = new Set<string>(BUILTIN_DEF_BY_ID.keys())
    for (const item of state.templates) knownTemplateIds.add(item.id)
    const nextTemplates = [...state.templates]
    for (const template of data.templates) {
      if (knownTemplateIds.has(template.id)) {
        skipped++
        continue
      }
      knownTemplateIds.add(template.id)
      imported++
      const categoryId = knownCategoryIds.has(template.categoryId ?? '') ? template.categoryId ?? null : null
      nextTemplates.push({
        ...template,
        // Category ids survive when they exist locally (custom categories
        // imported in the same batch included); unknown ids fall back to
        // uncategorized instead of dangling.
        categoryId,
        name: template.name.slice(0, NAME_MAX),
        description: template.description.slice(0, DESCRIPTION_MAX),
        tags: normalizeTags(template.tags),
        isPinned: false,
        isStarred: false,
        position: nextPositionIn(nextTemplates, categoryId),
      })
    }
    persist(nextTemplates, nextCategories)
    return {
      categories: orderedCategories(nextCategories),
      templates: nextTemplates,
    }
  })
  return { imported, skipped }
}

function toggleTemplateFlag(
  set: SetTemplateState,
  id: string,
  flag: 'isPinned' | 'isStarred',
): void {
  set((state) => {
    const templates = state.templates.map((item) => item.id === id
      ? { ...item, [flag]: !item[flag], updatedAt: Date.now() }
      : item)
    persist(templates, state.categories)
    return { templates }
  })
}

/**
 * Apply a patch to a whole selection in one write.
 *
 * The per-template store methods each re-serialize the library, so a loop over
 * them costs N writes of the whole record: at the 2000-template import ceiling a
 * select-all star took sixteen seconds of blocked main thread. Selections are the
 * common case, so the batch is the primitive and the loop is not.
 */
function applyBatchImpl(
  set: SetTemplateState,
  ids: readonly string[],
  patchFor: (template: NoteTemplate) => Partial<NoteTemplate> | null,
): number {
  const targets = new Set(ids)
  let changed = 0
  set((state) => {
    const now = Date.now()
    const templates = state.templates.map((item) => {
      if (!targets.has(item.id)) return item
      const patch = patchFor(item)
      if (!patch) return item
      changed += 1
      return { ...item, ...patch, updatedAt: now }
    })
    if (changed === 0) return state
    persist(templates, state.categories)
    return { templates }
  })
  return changed
}

function removeTemplatesImpl(set: SetTemplateState, ids: readonly string[]): number {
  const targets = new Set(ids)
  let removed = 0
  set((state) => {
    const templates = state.templates.filter((item) => {
      if (!targets.has(item.id) || item.builtin) return true
      removed += 1
      return false
    })
    if (removed === 0) return state
    persist(templates, state.categories)
    return { templates, undoable: snapshotOf(state) }
  })
  return removed
}

function snapshotOf(state: TemplateLibraryState): TemplateLibrarySnapshot {
  return { categories: [...state.categories], templates: [...state.templates] }
}

/**
 * Give back what the last destructive action took away.
 *
 * The snapshot is merged, not dropped in place: anything the user touched since the
 * delete keeps their version, and an entry that is simply gone comes back with the
 * id, position and timestamps it had. So undoing a delete never quietly reverts an
 * unrelated edit made in the meantime.
 */
function restoreUndoableImpl(set: SetTemplateState, get: () => TemplateLibraryState): boolean {
  const snapshot = get().undoable
  if (!snapshot) return false
  set((state) => {
    const liveIds = new Set(state.templates.map((item) => item.id))
    const revived = snapshot.templates.filter((item) => !liveIds.has(item.id))
    const categoryIds = new Set(state.categories.map((item) => item.id))
    const backCategories = snapshot.categories.filter((item) => !categoryIds.has(item.id))
    const orphaned = new Map(backCategories.map((item) => [item.id, item.id]))
    const whereTheyWere = new Map(snapshot.templates.map((item) => [item.id, item.categoryId]))
    let relinked = 0
    const kept = state.templates.map((item) => {
      if (item.categoryId !== null) return item
      const previous = whereTheyWere.get(item.id)
      if (previous === null || previous === undefined || !orphaned.has(previous)) return item
      relinked += 1
      return { ...item, categoryId: previous }
    })
    if (!revived.length && !backCategories.length && !relinked) return { undoable: null }
    const templates = [...kept, ...revived]
    const categories = orderedCategories([...state.categories, ...backCategories])
    persist(templates, categories)
    return { categories, templates, undoable: null }
  })
  return true
}
