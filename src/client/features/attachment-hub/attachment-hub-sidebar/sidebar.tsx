import { useEffect, useMemo, useState } from 'react'
import {
  Archive,
  ChevronsDownUp,
  ChevronsUpDown,
  Film,
  FileText,
  HardDrive,
  Images,
  LayoutDashboard,
  Link2Off,
  Pin,
  Plus,
  Star,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { HubAttachmentStats } from '@shared/attachment-hub'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { formatBytes } from '../../../lib/time'
import { IconButton } from '../../../components/primitives'
import { Tooltip, prompt } from '../../../components/overlay'
import { FolderPicker } from '../../folders/FolderPicker'
import { useHubScope } from '../hub-scope'
import { useHubFolderTree, useHubOrganizer, useHubTagTree } from '../attachment-store'
import { DEFAULT_QUOTA_BYTES, hubFolderToNoteFolder, type HubCategory } from '../attachment-helpers'
import { SectionLabel } from './label'
import { HubFolderRow } from './folder-row'
import { HubTagRow } from './tag-row'

interface AttachmentHubSidebarProps {
  selectedCategory: HubCategory
  onSelectCategory: (category: HubCategory) => void
  selectedFolderId: string | null
  onSelectFolder: (folderId: string | null) => void
  selectedTag: string | null
  onSelectTag: (tag: string | null) => void
  stats?: HubAttachmentStats
  onDropFilesToFolder: (fileIds: string[], targetFolderId: string | null) => Promise<void>
}

function categoryList(): { id: HubCategory; label: string; icon: ReactNode }[] {
  return [
    { id: 'dashboard', label: t('attachments.dashboard'), icon: <LayoutDashboard size={14} /> },
    { id: 'all', label: t('attachments.all_files'), icon: <HardDrive size={14} /> },
    { id: 'image', label: t('attachments.photos'), icon: <Images size={14} /> },
    { id: 'document', label: t('attachments.documents'), icon: <FileText size={14} /> },
    { id: 'media', label: t('attachments.media'), icon: <Film size={14} /> },
    { id: 'archive', label: t('attachments.archives'), icon: <Archive size={14} /> },
    { id: 'starred', label: t('attachments.starred_files'), icon: <Star size={14} /> },
    { id: 'pinned', label: t('attachments.pinned_files'), icon: <Pin size={14} /> },
    { id: 'unreferenced', label: t('attachments.unreferenced_files'), icon: <Link2Off size={14} /> },
  ]
}

export function AttachmentHubSidebar(props: AttachmentHubSidebarProps) {
  const { selectedCategory, onSelectCategory, selectedFolderId, onSelectFolder, selectedTag, onSelectTag, stats, onDropFilesToFolder } = props
  const scope = useHubScope()
  const tree = useHubFolderTree(scope)
  const { tree: tagTree, flatTree } = useHubTagTree(scope)
  const folders = useHubOrganizer(scope, (state) => state.folders)
  const load = useHubOrganizer(scope, (state) => state.load)
  const createFolder = useHubOrganizer(scope, (state) => state.createFolder)
  const patchFolder = useHubOrganizer(scope, (state) => state.patchFolder)
  const deleteFolder = useHubOrganizer(scope, (state) => state.deleteFolder)
  const createTag = useHubOrganizer(scope, (state) => state.createTag)
  const patchTag = useHubOrganizer(scope, (state) => state.patchTag)
  const deleteTag = useHubOrganizer(scope, (state) => state.deleteTag)
  const expandedFolders = useHubOrganizer(scope, (state) => state.expandedFolders)
  const toggleFolderExpanded = useHubOrganizer(scope, (state) => state.toggleFolderExpanded)
  const setExpandedFolders = useHubOrganizer(scope, (state) => state.setExpandedFolders)
  const expandedTagPaths = useHubOrganizer(scope, (state) => state.expandedTagPaths)
  const toggleTagExpanded = useHubOrganizer(scope, (state) => state.toggleTagExpanded)
  const setExpandedTagPaths = useHubOrganizer(scope, (state) => state.setExpandedTagPaths)

  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [movingFolderId, setMovingFolderId] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  const parentTagPaths = useMemo(() => {
    const paths: string[] = []
    const visit = (nodes: typeof tagTree) => {
      for (const node of nodes) {
        if (node.children.length > 0) {
          paths.push(node.fullPath)
          visit(node.children)
        }
      }
    }
    visit(tagTree)
    return paths
  }, [tagTree])

  const allTagsExpanded = parentTagPaths.length > 0 && parentTagPaths.every((path) => expandedTagPaths.has(path))
  const allFoldersExpanded = tree.length > 0 && tree.every((folder) => expandedFolders.includes(folder.id))

  const folderIds = useMemo(() => {
    const ids: string[] = []
    const collect = (nodes: typeof tree) => {
      for (const node of nodes) {
        ids.push(node.id)
        collect(node.children)
      }
    }
    collect(tree)
    return ids
  }, [tree])

  const handleCreateRootFolder = async () => {
    const created = await createFolder()
    if (created) setRenamingFolderId(created.id)
  }

  const handleCreateNewTag = async () => {
    const name = await prompt({ title: t('tags.new'), placeholder: t('tags.new_placeholder') })
    if (name?.trim()) await createTag(name.trim())
  }

  return (
    <div className='flex h-full w-60 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[length:var(--text-12-5)] select-none'>
      <div className='min-h-0 flex-1 space-y-[var(--sp-4)] overflow-y-auto px-[var(--sp-2)] py-[var(--sp-3)]'>
        <div>
          <SectionLabel>{t('attachments.categories')}</SectionLabel>
          <div className='space-y-px'>
            {categoryList().map((category) => {
              const active = selectedCategory === category.id && !selectedFolderId && !selectedTag
              return (
                <button
                  key={category.id}
                  type='button'
                  aria-pressed={active}
                  onClick={() => onSelectCategory(category.id)}
                  className={cn(
                    'flex h-8 w-full cursor-pointer items-center gap-[var(--sp-2)] rounded-[var(--r-md)] px-[var(--sp-2)] text-left font-medium transition-colors',
                    active ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <span className={cn('shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}>
                    {category.icon}
                  </span>
                  <span className='flex-1 truncate'>{category.label}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <SectionHeader
            title={t('navigation.folder')}
            expandLabel={allFoldersExpanded ? t('folders.collapse_all') : t('folders.expand_all')}
            isExpanded={allFoldersExpanded}
            onToggleAll={() => setExpandedFolders(allFoldersExpanded ? [] : folderIds)}
            addLabel={t('common.new_folder')}
            onAdd={() => void handleCreateRootFolder()}
          />
          <div className='space-y-px'>
            {tree.map((node) => (
              <HubFolderRow
                key={node.id}
                node={node}
                selectedFolderId={selectedFolderId}
                renamingFolderId={renamingFolderId}
                expandedFolders={expandedFolders}
                onToggleExpand={toggleFolderExpanded}
                onStartRename={setRenamingFolderId}
                onFinishRename={(id, name) => {
                  void patchFolder(id, { name })
                  setRenamingFolderId(null)
                }}
                onSelectFolder={onSelectFolder}
                onChooseParent={setMovingFolderId}
                onDropFilesToFolder={onDropFilesToFolder}
                createFolder={createFolder}
                patchFolder={patchFolder}
                deleteFolder={deleteFolder}
              />
            ))}
            {tree.length === 0 && <p className='px-[var(--sp-2)] py-[var(--sp-1-5)] text-[length:var(--text-12)] text-[var(--text-tertiary)] italic'>{t('folders.no_folders')}</p>}
          </div>
        </div>

        <div>
          <SectionHeader
            title={t('navigation.tag')}
            expandLabel={allTagsExpanded ? t('folders.collapse_all') : t('folders.expand_all')}
            isExpanded={allTagsExpanded}
            onToggleAll={() => setExpandedTagPaths(allTagsExpanded ? new Set() : new Set(parentTagPaths))}
            addLabel={t('tags.new')}
            onAdd={() => void handleCreateNewTag()}
          />
          <div className='space-y-px'>
            {flatTree.map((node) => (
              <HubTagRow
                key={node.fullPath}
                node={node}
                selectedTag={selectedTag}
                expandedTagPaths={expandedTagPaths}
                onToggleExpand={toggleTagExpanded}
                onSelectTag={onSelectTag}
                patchTag={patchTag}
                deleteTag={deleteTag}
              />
            ))}
            {flatTree.length === 0 && <p className='px-[var(--sp-2)] py-[var(--sp-1-5)] text-[length:var(--text-12)] text-[var(--text-tertiary)] italic'>{t('tags.no_match')}</p>}
          </div>
        </div>
      </div>

      {stats && <StatsFooter stats={stats} />}

      {movingFolderId && (
        <FolderPicker
          open
          title={t('folders.move_to')}
          folders={folders.map(hubFolderToNoteFolder)}
          currentId={movingFolderId}
          onSelect={(parentId) => void patchFolder(movingFolderId, { parentId })}
          onClose={() => setMovingFolderId(null)}
        />
      )}
    </div>
  )
}

function SectionHeader({ title, expandLabel, isExpanded, onToggleAll, addLabel, onAdd }: {
  title: string
  expandLabel: string
  isExpanded: boolean
  onToggleAll: () => void
  addLabel: string
  onAdd: () => void
}) {
  return (
    <div className='flex items-center justify-between px-[var(--sp-2)] pb-[var(--sp-1)]'>
      <SectionLabel>{title}</SectionLabel>
      <div className='flex items-center gap-px'>
        <Tooltip label={expandLabel} side='left'>
          <IconButton label={expandLabel} size='xs' onClick={onToggleAll}>
            {isExpanded ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
          </IconButton>
        </Tooltip>
        <Tooltip label={addLabel} side='right'>
          <IconButton label={addLabel} size='xs' onClick={onAdd}>
            <Plus size={13} />
          </IconButton>
        </Tooltip>
      </div>
    </div>
  )
}

function StatsFooter({ stats }: { stats: HubAttachmentStats }) {
  const totalQuota = stats.totalQuotaBytes || DEFAULT_QUOTA_BYTES
  const usedRatio = Math.min(1, Math.max(0, (stats.totalBytes ?? 0) / totalQuota))
  const usedWidthPct = (usedRatio * 100).toFixed(2)

  return (
    <div className='mt-auto shrink-0 space-y-[var(--sp-1-5)] border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)]/40 p-[var(--sp-3)] text-[length:var(--text-11)]'>
      <div className='flex items-center justify-between font-semibold text-[var(--text-secondary)]'>
        <span>{t('attachments.stats_title')}</span>
        <span className='font-mono text-[length:var(--text-10-5)] tabular'>
          {`${formatBytes(stats.totalBytes)} / ${formatBytes(totalQuota)}`}
        </span>
      </div>
      <div className='h-[var(--sp-1-5)] w-full overflow-hidden rounded-full bg-[var(--border-subtle)]'>
        <div
          style={{ width: `${Math.max(stats.totalBytes > 0 ? 1 : 0, Number(usedWidthPct))}%` }}
          className='h-full rounded-full bg-[var(--accent)] transition-all duration-[var(--dur-slow)]'
        />
      </div>
      <div className='flex justify-between text-[length:var(--text-10)] text-[var(--text-quaternary)]'>
        <span>{t('attachments.total_value0', { value0: stats.totalCount })}</span>
        <span>{t('attachments.unreferenced_count_value0', { value0: stats.unreferencedCount })}</span>
      </div>
    </div>
  )
}
