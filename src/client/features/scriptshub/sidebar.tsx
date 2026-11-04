/**
 * The ScriptsHub rail: the saved views, the folder tree and the tag tree.
 *
 * The tree shapes are the notebook's own: `treeItemProps` carries the roving path and depth, and the
 * drag payload is a private MIME type so a note dragged from the notebook can never land in a script
 * folder by accident. Nothing here owns data; it reads the store and asks it to filter.
 */
import { useMemo, useState } from 'react'
import {
  BarChart3, ChevronRight, Copy, FileCode2, FilePlus2, FolderClosed, FolderPlus, MoreHorizontal,
  Pin, Plus, Star, Tag, Trash2, Upload,
} from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import type { MessageKey } from '@shared/locales/en-US'
import { navigateToPath } from '../../lib/app-history'
import { IconButton, Button } from '../../components/primitives'
import { Input, commitOnEnter } from '../../components/form'
import { ColorWellField } from '../../components/color-field'
import { Drawer, Menu, Modal, confirm, useContextMenu, type MenuItem } from '../../components/overlay'
import { useScriptsHub, folderPathOf } from './store'
import { treeIndent } from '../../lib/tree'
import { copyText } from '../../lib/clipboard'
import { useUi } from '../../store/ui'
import type { ScriptFolder, ScriptTag } from '@shared/scriptshub/types'

const FOLDER_DRAG = 'application/x-scriptshub-folder'

type FilterId = 'all' | 'favorites' | 'pinned' | 'published' | 'deprecated'

const FILTERS: Array<{ id: FilterId; labelKey: MessageKey; icon: typeof Star }> = [
  { id: 'all', labelKey: 'scriptshub.sidebar.all', icon: FileCode2 },
  { id: 'favorites', labelKey: 'scriptshub.sidebar.favorites', icon: Star },
  { id: 'pinned', labelKey: 'scriptshub.sidebar.pinned', icon: Pin },
  { id: 'published', labelKey: 'scriptshub.sidebar.published', icon: Upload },
  { id: 'deprecated', labelKey: 'scriptshub.sidebar.deprecated', icon: Trash2 },
]

interface NameDialogState {
  kind: 'folder' | 'tag'
  mode: 'create' | 'rename'
  id?: string
  parentId?: string | null
  name: string
  color: string | null
}

export function SnippetsSidebar({ mobile = false, onNavigate }: {
  mobile?: boolean
  onNavigate?: () => void
}) {
  const overview = useScriptsHub((state) => state.overview)
  const query = useScriptsHub((state) => state.query)
  const loadList = useScriptsHub((state) => state.loadList)
  const toast = useUi((state) => state.toast)
  const folders = overview?.folders ?? []
  const tags = overview?.tags ?? []
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<NameDialogState | null>(null)
  const [saving, setSaving] = useState(false)

  const folderTree = useMemo(() => buildFolderTree(folders), [folders])
  const tagTree = useMemo(() => buildTagTree(tags), [tags])

  const chooseFilter = (id: FilterId) => {
    void loadList({ quick: id, folderId: null, tagId: null, offset: 0 })
    onNavigate?.()
  }
  const chooseFolder = (id: string | null) => {
    void loadList({ folderId: id, tagId: null, quick: 'all', offset: 0 })
    onNavigate?.()
  }
  const chooseTag = (id: string) => {
    void loadList({ tagId: id, folderId: null, quick: 'all', offset: 0 })
    onNavigate?.()
  }

  const submitDialog = async () => {
    if (!dialog) return
    setSaving(true)
    try {
      if (dialog.kind === 'folder') {
        if (dialog.mode === 'create') {
          await useScriptsHub.getState().createFolder({ name: dialog.name, parentId: dialog.parentId ?? null, color: dialog.color })
        } else if (dialog.id) {
          await useScriptsHub.getState().updateFolder(dialog.id, { name: dialog.name, color: dialog.color })
        }
      } else if (dialog.mode === 'create') {
        await useScriptsHub.getState().createTag({ name: dialog.name, parentId: dialog.parentId ?? null, color: dialog.color })
      } else if (dialog.id) {
        await useScriptsHub.getState().updateTag(dialog.id, { name: dialog.name, color: dialog.color })
      }
      setDialog(null)
    } finally {
      setSaving(false)
    }
  }

  const deleteFolder = async (folder: ScriptFolder) => {
    const agreed = await confirm({
      title: t('scriptshub.confirm.delete_folder_title', { name: folder.name }),
      description: t('scriptshub.confirm.delete_folder_body'),
      confirmLabel: t('scriptshub.common.delete'),
      tone: 'danger',
    })
    if (agreed) await useScriptsHub.getState().deleteFolder(folder.id)
  }

  const deleteTag = async (tag: ScriptTag) => {
    const agreed = await confirm({
      title: t('scriptshub.confirm.delete_tag_title', { name: tag.name }),
      description: t('scriptshub.confirm.delete_tag_body'),
      confirmLabel: t('scriptshub.common.delete'),
      tone: 'danger',
    })
    if (agreed) await useScriptsHub.getState().deleteTag(tag.id)
  }

  const moveFolder = async (folderId: string, parentId: string | null) => {
    const targetPath = folderPathOf(folders, parentId)
    if (targetPath.some((entry) => entry.id === folderId)) return
    await useScriptsHub.getState().updateFolder(folderId, { parentId })
  }

  const copyFolderPath = async (folder: ScriptFolder) => {
    const path = folderPathOf(folders, folder.id).map((entry) => entry.name).join('/')
    const ok = await copyText(path)
    toast({ title: ok ? t('scriptshub.toast.path_copied') : t('scriptshub.common.copy_failed'), tone: ok ? 'success' : 'danger' })
  }

  const createInFolder = (folderId: string | null) => {
    void useScriptsHub.getState().create({
      title: t('scriptshub.defaults.new_title'),
      folderId,
      language: 'shell',
    }).then((detail) => useScriptsHub.getState().select(detail.id))
    onNavigate?.()
  }

  const content = (
    <div className="flex h-full min-h-0 w-full flex-col">
      <nav aria-label={t('scriptshub.sidebar.views')} className="space-y-px px-2 pt-2">
        {FILTERS.map((filter) => {
          const Icon = filter.icon
          const active = query.quick === filter.id && !query.folderId && !query.tagId
          const count = filter.id === 'all'
            ? overview?.counts.snippets
            : filter.id === 'favorites'
              ? overview?.counts.favorites
              : filter.id === 'pinned'
                ? overview?.counts.pinned
                : filter.id === 'published'
                  ? overview?.counts.published
                  : overview?.counts.deprecated
          return (
            <button
              key={filter.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => chooseFilter(filter.id)}
              className={cn(
                'flex h-10 w-full items-center gap-2 rounded-[var(--r-md)] px-2.5 text-left text-[length:var(--text-12-5)] md:h-[30px]',
                active ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
              )}
            >
              <Icon size={14} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{t(filter.labelKey)}</span>
              {count !== undefined && count > 0 && (
                <span className="tabular shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{count}</span>
              )}
            </button>
          )
        })}
        <button
          type="button"
          onClick={() => {
            navigateToPath('/scripts/stats')
            onNavigate?.()
          }}
          className="flex h-10 w-full items-center gap-2 rounded-[var(--r-md)] px-2.5 text-left text-[length:var(--text-12-5)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] md:h-[30px]"
        >
          <BarChart3 size={14} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{t('scriptshub.sidebar.stats')}</span>
        </button>
      </nav>

      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-3">
        <section aria-labelledby="scriptshub-folders-heading">
          <div className="flex items-center gap-1 px-1.5">
            <p id="scriptshub-folders-heading" className="min-w-0 flex-1 text-[length:var(--text-10-5)] font-semibold tracking-wide text-[var(--text-quaternary)] uppercase">
              {t('scriptshub.sidebar.folders')}
            </p>
            <IconButton
              label={t('scriptshub.sidebar.new_folder')}
              size="xs"
              onClick={() => setDialog({ kind: 'folder', mode: 'create', parentId: null, name: '', color: null })}
            >
              <FolderPlus size={12} aria-hidden="true" />
            </IconButton>
          </div>
          <div role="group" aria-label={t('scriptshub.sidebar.folders')} className="mt-1 space-y-px">
            {folderTree.length === 0 && (
              <p className="px-2 py-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('scriptshub.sidebar.no_folders')}</p>
            )}
            {folderTree.map((node) => (
              <FolderNode
                key={node.folder.id}
                node={node}
                depth={0}
                expanded={expandedFolders}
                onToggle={(id) => setExpandedFolders((current) => toggleSet(current, id))}
                activeId={query.folderId ?? null}
                onChoose={chooseFolder}
                onNew={(parentId) => setDialog({ kind: 'folder', mode: 'create', parentId, name: '', color: null })}
                onRename={(folder) => setDialog({ kind: 'folder', mode: 'rename', id: folder.id, name: folder.name, color: folder.color })}
                onDelete={deleteFolder}
                onMove={moveFolder}
                onNewSnippet={createInFolder}
                onCopyPath={copyFolderPath}
              />
            ))}
            <div
              className="rounded-[var(--r-md)] px-2 py-1.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]"
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(FOLDER_DRAG)) return
                event.preventDefault()
              }}
              onDrop={(event) => {
                const id = event.dataTransfer.getData(FOLDER_DRAG)
                if (id) void moveFolder(id, null)
              }}
            >
              {t('scriptshub.sidebar.drop_root')}
            </div>
          </div>
        </section>

        <section aria-labelledby="scriptshub-tags-heading">
          <div className="flex items-center gap-1 px-1.5">
            <p id="scriptshub-tags-heading" className="min-w-0 flex-1 text-[length:var(--text-10-5)] font-semibold tracking-wide text-[var(--text-quaternary)] uppercase">
              {t('scriptshub.sidebar.tags')}
            </p>
            <IconButton
              label={t('scriptshub.sidebar.new_tag')}
              size="xs"
              onClick={() => setDialog({ kind: 'tag', mode: 'create', parentId: null, name: '', color: null })}
            >
              <Plus size={12} aria-hidden="true" />
            </IconButton>
          </div>
          <div role="group" aria-label={t('scriptshub.sidebar.tags')} className="mt-1 space-y-px">
            {tagTree.length === 0 && (
              <p className="px-2 py-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('scriptshub.sidebar.no_tags')}</p>
            )}
            {tagTree.map((node) => (
              <TagNode
                key={node.tag.id}
                node={node}
                expanded={expandedTags}
                onToggle={(id) => setExpandedTags((current) => toggleSet(current, id))}
                activeId={query.tagId ?? null}
                onChoose={chooseTag}
                onNew={(parentId) => setDialog({ kind: 'tag', mode: 'create', parentId, name: '', color: null })}
                onRename={(tag) => setDialog({ kind: 'tag', mode: 'rename', id: tag.id, name: tag.name, color: tag.color })}
                onDelete={deleteTag}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  )

  return (
    <>
      <aside className={cn(
        'h-full min-h-0 w-[248px] shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]',
        mobile ? 'hidden' : 'hidden md:block',
      )}>
        {content}
      </aside>
      {mobile && (
        <Drawer open onClose={() => onNavigate?.()} side="left" width={286} title={t('scriptshub.sidebar.title')}>
          {content}
        </Drawer>
      )}
      <NameDialog
        state={dialog}
        saving={saving}
        onChange={setDialog}
        onClose={() => setDialog(null)}
        onSubmit={() => void submitDialog()}
      />
    </>
  )
}

function toggleSet(current: Set<string>, id: string): Set<string> {
  const next = new Set(current)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

interface FolderTreeNode {
  folder: ScriptFolder
  children: FolderTreeNode[]
}

function buildFolderTree(folders: readonly ScriptFolder[]): FolderTreeNode[] {
  const byParent = new Map<string | null, ScriptFolder[]>()
  for (const folder of folders) {
    const siblings = byParent.get(folder.parentId) ?? []
    siblings.push(folder)
    byParent.set(folder.parentId, siblings)
  }
  const build = (parentId: string | null): FolderTreeNode[] => (byParent.get(parentId) ?? [])
    .map((folder) => ({ folder, children: build(folder.id) }))
  return build(null)
}

function FolderNode({
  node, depth, expanded, onToggle, activeId, onChoose, onNew, onRename, onDelete, onMove, onNewSnippet, onCopyPath,
}: {
  node: FolderTreeNode
  depth: number
  expanded: Set<string>
  onToggle: (id: string) => void
  activeId: string | null
  onChoose: (id: string | null) => void
  onNew: (parentId: string) => void
  onRename: (folder: ScriptFolder) => void
  onDelete: (folder: ScriptFolder) => void
  onMove: (folderId: string, parentId: string | null) => Promise<void>
  onNewSnippet: (folderId: string) => void
  onCopyPath: (folder: ScriptFolder) => void
}) {
  const menu = useContextMenu()
  const anchorLabel = t('scriptshub.common.more')
  const items: MenuItem[] = [
    { id: 'new-snippet', label: t('scriptshub.menu.new_snippet'), icon: <FilePlus2 size={13} aria-hidden="true" />, onSelect: () => onNewSnippet(node.folder.id) },
    { id: 'new', label: t('scriptshub.sidebar.new_subfolder'), icon: <FolderPlus size={13} aria-hidden="true" />, onSelect: () => onNew(node.folder.id) },
    { id: 'rename', label: t('scriptshub.common.rename'), onSelect: () => onRename(node.folder) },
    { id: 'copy-path', label: t('scriptshub.menu.copy_path'), icon: <Copy size={13} aria-hidden="true" />, separatorBefore: true, onSelect: () => onCopyPath(node.folder) },
    { id: 'delete', label: t('scriptshub.common.delete'), icon: <Trash2 size={13} aria-hidden="true" />, tone: 'danger', separatorBefore: true, onSelect: () => onDelete(node.folder) },
  ]
  const isOpen = expanded.has(node.folder.id)
  const hasChildren = node.children.length > 0
  return (
    <div>
      <div
        data-scriptshub-folder-row
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(FOLDER_DRAG, node.folder.id)
          event.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(FOLDER_DRAG)) return
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          const id = event.dataTransfer.getData(FOLDER_DRAG)
          if (id && id !== node.folder.id) void onMove(id, node.folder.id)
        }}
        className={cn(
          'group relative flex h-10 items-center gap-1 rounded-[var(--r-md)] pr-1 md:h-[28px]',
          activeId === node.folder.id ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
        )}
        style={{ paddingLeft: treeIndent(depth) }}
      >
        <button
          type="button"
          aria-label={isOpen ? t('scriptshub.sidebar.collapse') : t('scriptshub.sidebar.expand')}
          aria-expanded={hasChildren ? isOpen : undefined}
          disabled={!hasChildren}
          onClick={(event) => {
            event.stopPropagation()
            onToggle(node.folder.id)
          }}
          className={cn('flex size-6 shrink-0 items-center justify-center text-[var(--text-quaternary)] md:size-4', isOpen && 'rotate-90', !hasChildren && 'invisible')}
        >
          <ChevronRight size={11} aria-hidden="true" />
        </button>
        <FolderClosed size={13} aria-hidden="true" style={{ color: node.folder.color ?? 'var(--text-tertiary)' }} />
        <button
          type="button"
          onClick={() => onChoose(node.folder.id)}
          onDoubleClick={() => onRename(node.folder)}
          onContextMenu={(event) => {
            event.preventDefault()
            menu.onContextMenu(event)
          }}
          className="min-w-0 flex-1 truncate py-1 text-left text-[length:var(--text-12)] font-medium"
        >
          {node.folder.name}
        </button>
        {node.folder.snippetCount > 0 && (
          <span className="tabular shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{node.folder.snippetCount}</span>
        )}
        <IconButton
          label={anchorLabel}
          size="xs"
          onClick={(event) => {
            event.stopPropagation()
            menu.close()
            menu.onContextMenu(event)
          }}
          className="opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
        >
          <MoreHorizontal size={12} aria-hidden="true" />
        </IconButton>
      </div>
      {isOpen && node.children.map((child) => (
        <FolderNode
          key={child.folder.id}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          onToggle={onToggle}
          activeId={activeId}
          onChoose={onChoose}
          onNew={onNew}
          onRename={onRename}
          onDelete={onDelete}
          onMove={onMove}
          onNewSnippet={onNewSnippet}
          onCopyPath={onCopyPath}
        />
      ))}
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items} />}
    </div>
  )
}

interface TagTreeNode {
  tag: ScriptTag
  children: TagTreeNode[]
}

function buildTagTree(tags: readonly ScriptTag[]): TagTreeNode[] {
  const byParent = new Map<string | null, ScriptTag[]>()
  for (const tag of tags) {
    const siblings = byParent.get(tag.parentId) ?? []
    siblings.push(tag)
    byParent.set(tag.parentId, siblings)
  }
  const build = (parentId: string | null): TagTreeNode[] => (byParent.get(parentId) ?? [])
    .map((tag) => ({ tag, children: build(tag.id) }))
  return build(null)
}

function TagNode({
  node, expanded, onToggle, activeId, onChoose, onNew, onRename, onDelete,
}: {
  node: TagTreeNode
  expanded: Set<string>
  onToggle: (id: string) => void
  activeId: string | null
  onChoose: (id: string) => void
  onNew: (parentId: string) => void
  onRename: (tag: ScriptTag) => void
  onDelete: (tag: ScriptTag) => void
}) {
  const menu = useContextMenu()
  const isOpen = expanded.has(node.tag.id)
  const items: MenuItem[] = [
    { id: 'filter', label: t('scriptshub.tag.filter'), icon: <Tag size={13} aria-hidden="true" />, onSelect: () => onChoose(node.tag.id) },
    { id: 'copy', label: t('scriptshub.tag.copy_name'), icon: <Copy size={13} aria-hidden="true" />, onSelect: () => {
      void copyText(`#${node.tag.name}`).then((ok) => {
        useUi.getState().toast({ title: ok ? t('scriptshub.tag.copied') : t('scriptshub.common.copy_failed'), tone: ok ? 'success' : 'danger' })
      })
    } },
    { id: 'new', label: t('scriptshub.sidebar.new_subtag'), icon: <Plus size={13} aria-hidden="true" />, separatorBefore: true, onSelect: () => onNew(node.tag.id) },
    { id: 'rename', label: t('scriptshub.common.rename'), onSelect: () => onRename(node.tag) },
    { id: 'color', label: t('scriptshub.tag.color'), onSelect: () => onRename(node.tag) },
    { id: 'delete', label: t('scriptshub.common.delete'), icon: <Trash2 size={13} aria-hidden="true" />, tone: 'danger', separatorBefore: true, onSelect: () => onDelete(node.tag) },
  ]
  return (
    <div>
      <div
        className={cn(
          'group flex h-9 items-center gap-1.5 rounded-[var(--r-md)] px-2 md:h-[26px]',
          activeId === node.tag.id ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
        )}
      >
        <button
          type="button"
          aria-label={isOpen ? t('scriptshub.sidebar.collapse') : t('scriptshub.sidebar.expand')}
          aria-expanded={node.children.length ? isOpen : undefined}
          disabled={node.children.length === 0}
          onClick={(event) => {
            event.stopPropagation()
            onToggle(node.tag.id)
          }}
          className={cn('flex size-5 shrink-0 items-center justify-center text-[var(--text-quaternary)]', isOpen && 'rotate-90', node.children.length === 0 && 'invisible')}
        >
          <ChevronRight size={10} aria-hidden="true" />
        </button>
        <Tag size={12} aria-hidden="true" style={{ color: node.tag.color ?? 'var(--text-tertiary)' }} />
        <button
          type="button"
          onClick={() => onChoose(node.tag.id)}
          onContextMenu={(event) => {
            event.preventDefault()
            menu.onContextMenu(event)
          }}
          className="min-w-0 flex-1 truncate text-left text-[length:var(--text-11-5)]"
        >
          {node.tag.name}
        </button>
        {node.tag.snippetCount > 0 && (
          <span className="tabular shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">{node.tag.snippetCount}</span>
        )}
        <IconButton
          label={t('scriptshub.common.more')}
          size="xs"
          onClick={(event) => {
            event.stopPropagation()
            menu.close()
            menu.onContextMenu(event)
          }}
          className="opacity-100 md:opacity-0 md:group-hover:opacity-100"
        >
          <MoreHorizontal size={11} aria-hidden="true" />
        </IconButton>
      </div>
      {isOpen && node.children.map((child) => (
        <TagNode
          key={child.tag.id}
          node={child}
          expanded={expanded}
          onToggle={onToggle}
          activeId={activeId}
          onChoose={onChoose}
          onNew={onNew}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items} />}
    </div>
  )
}

function NameDialog({ state, saving, onChange, onClose, onSubmit }: {
  state: NameDialogState | null
  saving: boolean
  onChange: (state: NameDialogState | null) => void
  onClose: () => void
  onSubmit: () => void
}) {
  const title = state
    ? state.mode === 'create'
      ? state.kind === 'folder' ? t('scriptshub.dialog.new_folder') : t('scriptshub.dialog.new_tag')
      : state.kind === 'folder' ? t('scriptshub.dialog.rename_folder') : t('scriptshub.dialog.rename_tag')
    : ''
  const nameLabel = state?.kind === 'folder' ? t('scriptshub.dialog.folder_name') : t('scriptshub.dialog.tag_name')
  return (
    <Modal
      open={state !== null}
      onClose={onClose}
      title={title}
      width={420}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('scriptshub.common.cancel')}</Button>
          <Button variant="primary" loading={saving} disabled={!state?.name.trim()} onClick={onSubmit}>
            {t('scriptshub.common.save')}
          </Button>
        </>
      )}
    >
      {state && (
        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{nameLabel}</span>
            <Input
              autoFocus
              value={state.name}
              onChange={(event) => onChange({ ...state, name: event.target.value })}
              onKeyDown={(event) => commitOnEnter(event, onSubmit)}
              placeholder={state.kind === 'folder' ? t('scriptshub.dialog.folder_placeholder') : t('scriptshub.dialog.tag_placeholder')}
            />
          </label>
          <div className="flex items-center gap-3">
            <ColorWellField
              value={state.color}
              label={t('scriptshub.dialog.color')}
              onChange={(color) => onChange({ ...state, color })}
            />
            <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('scriptshub.dialog.color')}</span>
          </div>
        </div>
      )}
    </Modal>
  )
}

/**
 * A folder list in the notebook's own `Folder` shape, so the shared picker and the move menu accept
 * script folders without a second implementation of the path logic.
 */
export function asNotebookFolders(folders: readonly ScriptFolder[]) {
  return folders.map((folder) => ({
    id: folder.id,
    parentId: folder.parentId,
    name: folder.name,
    icon: folder.icon,
    color: folder.color,
    position: folder.position,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
    noteCount: folder.snippetCount,
  }))
}
