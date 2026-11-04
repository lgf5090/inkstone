/**
 * The state one ScriptsHub screen keeps.
 *
 * The list and the detail are separate reads on purpose: the list carries summaries, and the detail
 * carries every file body. Opening a snippet replaces `detail` rather than merging it, so a failed
 * read cannot leave the previous snippet's code under the new title. The account's folder and tag
 * rows are shared by the sidebar, the pickers and the editor, so they live here once.
 */
import { create } from 'zustand'
import type {
  ScriptFolder,
  ScriptFolderInput,
  ScriptListQuery,
  ScriptPublication,
  ScriptPublicationCreated,
  ScriptPublicationInput,
  ScriptPublicationPatch,
  ScriptSnippetDetail,
  ScriptSnippetInput,
  ScriptSnippetSaveInput,
  ScriptSnippetSummary,
  ScriptTag,
  ScriptTagInput,
  ScriptsHubOverview,
} from '@shared/scriptshub/types'
import { scriptshubApi } from './api'
import { t } from '../../lib/i18n'

export interface ScriptsHubState {
  overview: ScriptsHubOverview | null
  overviewLoading: boolean
  snippets: ScriptSnippetSummary[]
  total: number
  listLoading: boolean
  listError: string | null
  query: ScriptListQuery
  selectedId: string | null
  detail: ScriptSnippetDetail | null
  detailLoading: boolean
  detailError: string | null
  bootstrap: () => Promise<void>
  refreshOverview: () => Promise<void>
  loadList: (query?: Partial<ScriptListQuery>) => Promise<void>
  select: (id: string | null) => Promise<void>
  create: (input: ScriptSnippetInput) => Promise<ScriptSnippetDetail>
  duplicate: (id: string) => Promise<ScriptSnippetDetail>
  save: (id: string, input: ScriptSnippetSaveInput) => Promise<ScriptSnippetDetail>
  remove: (id: string) => Promise<void>
  batch: (input: Parameters<typeof scriptshubApi.batch>[0]) => Promise<void>
  patchSnippet: (id: string, input: Parameters<typeof scriptshubApi.updateSnippet>[1]) => Promise<void>
  createFolder: (input: ScriptFolderInput) => Promise<ScriptFolder>
  updateFolder: (id: string, input: Partial<ScriptFolderInput>) => Promise<void>
  deleteFolder: (id: string) => Promise<void>
  createTag: (input: ScriptTagInput) => Promise<ScriptTag>
  updateTag: (id: string, input: Partial<ScriptTagInput>) => Promise<void>
  deleteTag: (id: string) => Promise<void>
  publish: (snippetId: string, input: ScriptPublicationInput) => Promise<ScriptPublicationCreated>
  updatePublication: (id: string, input: ScriptPublicationPatch) => Promise<ScriptPublication>
  deletePublication: (id: string) => Promise<void>
}

const DEFAULT_QUERY: ScriptListQuery = {
  search: '',
  folderId: null,
  tagId: null,
  quick: 'all',
  sort: 'updated',
  limit: 50,
  offset: 0,
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useScriptsHub = create<ScriptsHubState>()((set, get) => ({
  overview: null,
  overviewLoading: false,
  snippets: [],
  total: 0,
  listLoading: false,
  listError: null,
  query: DEFAULT_QUERY,
  selectedId: null,
  detail: null,
  detailLoading: false,
  detailError: null,

  async bootstrap() {
    await Promise.all([get().refreshOverview(), get().loadList()])
  },

  async refreshOverview() {
    set({ overviewLoading: true })
    try {
      const overview = await scriptshubApi.overview()
      set({ overview, overviewLoading: false })
    } catch (error) {
      set({ overviewLoading: false })
      throw error
    }
  },

  async loadList(patch) {
    const query = { ...get().query, ...patch, ...(patch?.offset === undefined ? { offset: 0 } : {}) }
    set({ query, listLoading: true, listError: null })
    try {
      const response = await scriptshubApi.listSnippets(query)
      const previous = get().snippets
      const merged = (query.offset ?? 0) > 0
        ? [...previous, ...response.items.filter((item) => !previous.some((entry) => entry.id === item.id))]
        : response.items
      set({ snippets: merged, total: response.total, listLoading: false })
    } catch (error) {
      set({ listLoading: false, listError: messageOf(error) })
    }
  },

  async select(id) {
    if (!id) {
      set({ selectedId: null, detail: null, detailError: null })
      return
    }
    set({ selectedId: id, detailLoading: true, detailError: null })
    try {
      const detail = await scriptshubApi.getSnippet(id)
      if (get().selectedId !== id) return
      set({ detail, detailLoading: false })
    } catch (error) {
      if (get().selectedId !== id) return
      set({ detailLoading: false, detailError: messageOf(error), detail: null })
    }
  },

  async create(input) {
    const detail = await scriptshubApi.createSnippet(input)
    await Promise.all([get().loadList(), get().refreshOverview()])
    await get().select(detail.id)
    return detail
  },

  /**
   * A duplicate is a new snippet, not a second pointer at the same files: the copy gets its own id
   * and its own history, and the original keeps its publications. Its publication paths are not
   * copied — two rows cannot own the same path.
   */
  async duplicate(id) {
    const detail = await scriptshubApi.getSnippet(id)
    const created = await scriptshubApi.createSnippet({
      title: `${detail.title}${t('scriptshub.defaults.copy_suffix')}`,
      description: detail.description,
      folderId: detail.folderId,
      language: detail.files[0]?.language ?? detail.language,
      sourceUrl: detail.sourceUrl,
      notes: detail.notes,
      tags: detail.tags.map((tag) => tag.id),
    })
    const copied = await scriptshubApi.saveSnippet(created.id, {
      title: created.title,
      description: detail.description,
      folderId: detail.folderId,
      language: detail.files[0]?.language ?? detail.language,
      sourceUrl: detail.sourceUrl,
      notes: detail.notes,
      tags: detail.tags.map((tag) => tag.id),
      files: detail.files.map((file) => ({ name: file.name, language: file.language, content: file.content })),
    })
    await Promise.all([get().refreshOverview(), get().loadList()])
    await get().select(copied.id)
    return copied
  },

  async save(id, input) {
    const detail = await scriptshubApi.saveSnippet(id, input)
    set({ detail })
    await Promise.all([get().loadList(), get().refreshOverview()])
    return detail
  },

  async remove(id) {
    await scriptshubApi.deleteSnippet(id)
    const remaining = get().snippets.filter((item) => item.id !== id)
    set({
      snippets: remaining,
      total: Math.max(0, get().total - 1),
      selectedId: get().selectedId === id ? null : get().selectedId,
      detail: get().selectedId === id ? null : get().detail,
    })
    await get().refreshOverview()
  },

  async batch(input) {
    await scriptshubApi.batch(input)
    const selected = get().selectedId
    if (selected && input.ids.includes(selected) && input.action === 'delete') {
      set({ selectedId: null, detail: null })
    }
    await Promise.all([get().loadList(), get().refreshOverview()])
  },

  async patchSnippet(id, input) {
    const detail = await scriptshubApi.updateSnippet(id, input)
    set({ detail: get().selectedId === id ? detail : get().detail })
    await get().loadList()
  },

  async createFolder(input) {
    const folder = await scriptshubApi.createFolder(input)
    await get().refreshOverview()
    return folder
  },

  async updateFolder(id, input) {
    await scriptshubApi.updateFolder(id, input)
    await Promise.all([get().refreshOverview(), get().loadList()])
  },

  async deleteFolder(id) {
    await scriptshubApi.deleteFolder(id)
    if (get().query.folderId === id) set({ query: { ...get().query, folderId: null } })
    await Promise.all([get().refreshOverview(), get().loadList()])
  },

  async createTag(input) {
    const tag = await scriptshubApi.createTag(input)
    await get().refreshOverview()
    return tag
  },

  async updateTag(id, input) {
    await scriptshubApi.updateTag(id, input)
    await Promise.all([get().refreshOverview(), get().loadList()])
  },

  async deleteTag(id) {
    await scriptshubApi.deleteTag(id)
    if (get().query.tagId === id) set({ query: { ...get().query, tagId: null } })
    await Promise.all([get().refreshOverview(), get().loadList()])
  },

  async publish(snippetId, input) {
    const publication = await scriptshubApi.createPublication(snippetId, input)
    await Promise.all([get().refreshOverview(), get().loadList()])
    if (get().selectedId === snippetId) await get().select(snippetId)
    return publication
  },

  async updatePublication(id, input) {
    const publication = await scriptshubApi.updatePublication(id, input)
    if (get().selectedId) await get().select(get().selectedId)
    await get().loadList()
    return publication
  },

  async deletePublication(id) {
    await scriptshubApi.deletePublication(id)
    if (get().selectedId) await get().select(get().selectedId)
    await Promise.all([get().refreshOverview(), get().loadList()])
  },
}))

/** A folder's path, for a move menu or a breadcrumb. */
export function folderPathOf(folders: readonly ScriptFolder[], id: string | null): ScriptFolder[] {
  if (!id) return []
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const path: ScriptFolder[] = []
  const seen = new Set<string>()
  let cursor: string | null = id
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const folder = byId.get(cursor)
    if (!folder) break
    path.unshift(folder)
    cursor = folder.parentId
  }
  return path
}

/** A tag's path through its parent chain. */
export function tagPathOf(tags: readonly ScriptTag[], id: string | null): ScriptTag[] {
  if (!id) return []
  const byId = new Map(tags.map((tag) => [tag.id, tag]))
  const path: ScriptTag[] = []
  const seen = new Set<string>()
  let cursor: string | null = id
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const tag = byId.get(cursor)
    if (!tag) break
    path.unshift(tag)
    cursor = tag.parentId
  }
  return path
}
