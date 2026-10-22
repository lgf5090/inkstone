import { useMemo } from 'react'
import { createStore, useStore, type StoreApi } from 'zustand'
import type { AttachmentHubScope, HubFolder, HubTag } from '@shared/attachment-hub'
import type { MessageKey } from '@shared/locales/en-US'
import { attachmentHubApi } from './api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { buildFolderTree, type FolderNode } from '../../store/notes'
import { buildTagTree, flattenTagTree, type TagTreeNode } from '../../lib/tag-tree'
import { hubFolderToNoteFolder, hubTagToNoteTag } from './attachment-helpers'

export interface HubOrganizerState {
  folders: HubFolder[]
  tags: HubTag[]
  expandedFolders: string[]
  expandedTagPaths: Set<string>
  loading: boolean
  load: () => Promise<void>
  createFolder: (name?: string, parentId?: string | null) => Promise<HubFolder | null>
  patchFolder: (id: string, patch: Partial<HubFolder>) => Promise<void>
  deleteFolder: (id: string) => Promise<void>
  setExpandedFolders: (updater: string[] | ((prev: string[]) => string[])) => void
  toggleFolderExpanded: (id: string) => void
  createTag: (name: string, color?: string | null) => Promise<HubTag | null>
  patchTag: (id: string, patch: Partial<HubTag>) => Promise<void>
  deleteTag: (id: string) => Promise<void>
  toggleTagExpanded: (fullPath: string) => void
  setExpandedTagPaths: (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => void
}

function reportFailure(titleKey: MessageKey): void {
  useUi.getState().toast({ title: t(titleKey), tone: 'danger' })
}

/**
 * One store per scope: four applications organise their own folders and tags, and a single module
 * array would have two open hubs overwrite each other.
 */
const organizerStores = new Map<AttachmentHubScope, StoreApi<HubOrganizerState>>()

function organizerStoreFor(scope: AttachmentHubScope): StoreApi<HubOrganizerState> {
  const existing = organizerStores.get(scope)
  if (existing) return existing
  const created = createStore<HubOrganizerState>()((set) => ({
    folders: [],
    tags: [],
    expandedFolders: [],
    expandedTagPaths: new Set<string>(),
    loading: false,

    load: async () => {
      set({ loading: true })
      try {
        const [folders, tags] = await Promise.all([
          attachmentHubApi.folders.list(scope),
          attachmentHubApi.tags.list(scope),
        ])
        set({ folders, tags, loading: false })
      }
      catch {
        set({ loading: false })
        reportFailure('attachments.organizer_load_failed')
      }
    },

    createFolder: async (name, parentId = null) => {
      try {
        const created = await attachmentHubApi.folders.create(scope, {
          name: name?.trim() || t('attachments.new_folder'),
          parentId,
        })
        set((state) => ({
          folders: [...state.folders, created],
          expandedFolders: parentId && !state.expandedFolders.includes(parentId)
            ? [...state.expandedFolders, parentId]
            : state.expandedFolders,
        }))
        return created
      }
      catch {
        reportFailure('attachments.folder_create_failed')
        return null
      }
    },

    patchFolder: async (id, patch) => {
      try {
        const updated = await attachmentHubApi.folders.patch(scope, id, patch)
        set((state) => ({ folders: state.folders.map((f) => (f.id === id ? updated : f)) }))
      }
      catch {
        reportFailure('attachments.folder_save_failed')
      }
    },

    deleteFolder: async (id) => {
      try {
        await attachmentHubApi.folders.remove(scope, id)
        set((state) => ({
          folders: state.folders.filter((f) => f.id !== id),
          expandedFolders: state.expandedFolders.filter((folderId) => folderId !== id),
        }))
      }
      catch {
        reportFailure('attachments.folder_delete_failed')
      }
    },

    setExpandedFolders: (updater) => {
      set((state) => ({
        expandedFolders: typeof updater === 'function' ? updater(state.expandedFolders) : updater,
      }))
    },

    toggleFolderExpanded: (id) => {
      set((state) => ({
        expandedFolders: state.expandedFolders.includes(id)
          ? state.expandedFolders.filter((folderId) => folderId !== id)
          : [...state.expandedFolders, id],
      }))
    },

    createTag: async (name, color) => {
      try {
        const created = await attachmentHubApi.tags.create(scope, { name, color })
        set((state) => {
          const known = state.tags.some((tag) => tag.id === created.id || tag.name === created.name)
          return {
            tags: known
              ? state.tags.map((tag) => (tag.id === created.id || tag.name === created.name ? created : tag))
              : [...state.tags, created],
          }
        })
        return created
      }
      catch {
        reportFailure('attachments.tag_create_failed')
        return null
      }
    },

    patchTag: async (id, patch) => {
      try {
        const updated = await attachmentHubApi.tags.patch(scope, id, patch)
        set((state) => ({ tags: state.tags.map((tag) => (tag.id === id ? updated : tag)) }))
      }
      catch {
        reportFailure('attachments.tag_save_failed')
      }
    },

    deleteTag: async (id) => {
      try {
        await attachmentHubApi.tags.remove(scope, id)
        set((state) => ({ tags: state.tags.filter((tag) => tag.id !== id) }))
      }
      catch {
        reportFailure('attachments.tag_delete_failed')
      }
    },

    toggleTagExpanded: (fullPath) => {
      set((state) => {
        const next = new Set(state.expandedTagPaths)
        if (next.has(fullPath)) next.delete(fullPath)
        else next.add(fullPath)
        return { expandedTagPaths: next }
      })
    },

    setExpandedTagPaths: (updater) => {
      set((state) => ({
        expandedTagPaths: typeof updater === 'function' ? updater(state.expandedTagPaths) : updater,
      }))
    },
  }))
  organizerStores.set(scope, created)
  return created
}

export function useHubOrganizer<T>(scope: AttachmentHubScope, selector: (state: HubOrganizerState) => T): T {
  return useStore(organizerStoreFor(scope), selector)
}

export function useHubFolderTree(scope: AttachmentHubScope): FolderNode[] {
  const folders = useHubOrganizer(scope, (state) => state.folders)
  // Rebuilt only when the folders change: every consumer reads the tree on each render, and a fresh
  // array each time would invalidate theirs as well.
  return useMemo(
    () => buildFolderTree(folders.map(hubFolderToNoteFolder), new Map()),
    [folders],
  )
}

export function useHubTagTree(scope: AttachmentHubScope): {
  tree: TagTreeNode[]
  flatTree: TagTreeNode[]
} {
  const tags = useHubOrganizer(scope, (state) => state.tags)
  const expandedTagPaths = useHubOrganizer(scope, (state) => state.expandedTagPaths)
  return useMemo(() => {
    const tree = buildTagTree(tags.map(hubTagToNoteTag))
    return { tree, flatTree: flattenTagTree(tree, expandedTagPaths) }
  }, [tags, expandedTagPaths])
}
