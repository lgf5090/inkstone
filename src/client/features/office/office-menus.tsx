import { useMemo, useState, type ReactNode } from 'react'
import {
  ArrowUpDown,
  ClipboardPaste,
  Copy,
  Download,
  FilePlus2,
  FileText,
  FolderClosed,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GalleryHorizontal,
  Hash,
  History,
  Info,
  LayoutDashboard,
  LayoutGrid,
  List,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Scissors,
  Smile,
  Star,
  StarOff,
  Table2,
  Tags,
  Trash2,
  Upload,
  Presentation,
  FileType2,
} from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import { OFFICE_FILE_TYPES, type OfficeFileType } from '@shared/office/constants'
import type { OfficeFileSummary, OfficeFolder, OfficeTag } from '@shared/office/model'
import type { MoveMenuFolder } from '../../lib/tree'
import { t } from '../../lib/i18n'
import { MenuSubmenuList, type MenuItem } from '../../components/overlay'
import { FIELD_BASE } from '../../components/form'
import { FolderColorMenu, FolderIconMenu } from '../folders/FolderAppearanceMenus'
import { FolderMoveMenu } from '../folders/FolderMoveMenu'
import { TagColorMenu } from '../tags/TagAppearanceMenus'
import { OFFICE_SORT_DIRECTIONS, OFFICE_VIEW_MODES, type OfficeSortDirection, type OfficeSortKey, type OfficeViewMode } from './office-prefs'
import type { OfficeSmartView } from './office-address'

const TYPE_LABEL_KEYS: Record<OfficeFileType, MessageKey> = {
  sheets: 'office.type.sheets',
  docs: 'office.type.docs',
  slides: 'office.type.slides',
  bases: 'office.type.bases',
  boards: 'office.type.boards',
  pdfs: 'office.type.pdfs',
}

const TYPE_NEW_KEYS: Record<OfficeFileType, MessageKey> = {
  sheets: 'office.new.sheets',
  docs: 'office.new.docs',
  slides: 'office.new.slides',
  bases: 'office.new.bases',
  boards: 'office.new.boards',
  pdfs: 'office.new.pdfs',
}

const VIEW_LABEL_KEYS: Record<OfficeViewMode, MessageKey> = {
  list: 'office.view.list',
  card: 'office.view.card',
  gallery: 'office.view.gallery',
}

const SORT_LABEL_KEYS: Record<OfficeSortKey, MessageKey> = {
  updated: 'office.sort.updated',
  name: 'office.sort.name',
  created: 'office.sort.created',
  type: 'office.sort.type',
  size: 'office.sort.size',
}

const SMART_VIEW_LABEL_KEYS: Record<OfficeSmartView, MessageKey> = {
  all: 'office.view.all_files',
  recent: 'office.view.recent',
  starred: 'office.view.starred',
  pinned: 'office.view.pinned',
  trash: 'office.view.trash',
}

export function officeTypeLabel(type: OfficeFileType): string {
  return t(TYPE_LABEL_KEYS[type])
}

export function officeTypeIcon(type: OfficeFileType, size = 14): ReactNode {
  switch (type) {
    case 'sheets':
      return <Table2 size={size} aria-hidden="true" />
    case 'docs':
      return <FileText size={size} aria-hidden="true" />
    case 'slides':
      return <Presentation size={size} aria-hidden="true" />
    case 'bases':
      return <LayoutDashboard size={size} aria-hidden="true" />
    case 'boards':
      return <Smile size={size} aria-hidden="true" />
    case 'pdfs':
      return <FileType2 size={size} aria-hidden="true" />
  }
}

export function officeViewIcon(mode: OfficeViewMode, size = 14): ReactNode {
  if (mode === 'list') return <List size={size} aria-hidden="true" />
  if (mode === 'card') return <LayoutGrid size={size} aria-hidden="true" />
  return <GalleryHorizontal size={size} aria-hidden="true" />
}

export function officeViewLabel(mode: OfficeViewMode): string {
  return t(VIEW_LABEL_KEYS[mode])
}

export function officeSortLabel(key: OfficeSortKey): string {
  return t(SORT_LABEL_KEYS[key])
}

export function officeSmartViewLabel(view: OfficeSmartView): string {
  return t(SMART_VIEW_LABEL_KEYS[view])
}

function newFileItems(onNewFile: (type: OfficeFileType) => void): MenuItem[] {
  return OFFICE_FILE_TYPES.map((type) => ({
    id: `new-${type}`,
    label: t(TYPE_NEW_KEYS[type]),
    icon: officeTypeIcon(type),
    onSelect: () => onNewFile(type),
  }))
}

/** The six products as menu rows; shared by every "new file" menu in the shell. */
export function officeNewFileMenuItems(onNewFile: (type: OfficeFileType) => void): MenuItem[] {
  return newFileItems(onNewFile)
}

function sortItems(
  sortKey: OfficeSortKey,
  sortDir: OfficeSortDirection,
  onSort: (key: OfficeSortKey, dir: OfficeSortDirection) => void,
): MenuItem[] {
  return [
    ...(Object.keys(SORT_LABEL_KEYS) as OfficeSortKey[]).map((key): MenuItem => ({
      id: `sort-${key}`,
      label: officeSortLabel(key),
      checked: sortKey === key,
      onSelect: () => onSort(key, sortDir),
    })),
    ...OFFICE_SORT_DIRECTIONS.map((dir): MenuItem => ({
      id: `sort-dir-${dir}`,
      label: t(dir === 'asc' ? 'office.sort.asc' : 'office.sort.desc'),
      checked: sortDir === dir,
      separatorBefore: dir === 'asc',
      onSelect: () => onSort(sortKey, dir),
    })),
  ]
}

export function officeSortMenuItems(
  sortKey: OfficeSortKey,
  sortDir: OfficeSortDirection,
  onSort: (key: OfficeSortKey, dir: OfficeSortDirection) => void,
): MenuItem[] {
  return sortItems(sortKey, sortDir, onSort)
}

/** One row per tag, filtered as the reader types; the panel is a submenu, not a dialog. */
function TagAddMenu({ tags, onAdd, closeMenu }: {
  tags: readonly OfficeTag[]
  onAdd: (tagIds: string[]) => void
  closeMenu: () => void
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase()
  const visible = useMemo(
    () => (needle ? tags.filter((tag) => tag.name.toLocaleLowerCase().includes(needle)) : tags),
    [tags, needle],
  )
  return (
    <div
      className="w-[236px] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)] outline-none"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="p-1 pb-1.5">
        <input
          autoFocus
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t('office.tags.pick_title')}
          placeholder={t('office.tags.pick_title')}
          className={`${FIELD_BASE} h-8 text-[length:var(--text-12)]`}
        />
      </div>
      <div role="group" aria-label={t('office.tags.pick_title')} className="max-h-[240px] overflow-y-auto">
        {visible.map((tag) => (
          <button
            key={tag.id}
            type="button"
            onClick={() => {
              onAdd([tag.id])
              closeMenu()
            }}
            className="flex h-8 w-full items-center gap-2 rounded-[var(--r-sm)] px-2 text-left text-[length:var(--text-12)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <Hash size={12} style={{ color: tag.color ?? 'var(--text-quaternary)' }} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{tag.name}</span>
          </button>
        ))}
        {visible.length === 0 && (
          <p className="px-2 py-3 text-center text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
            {t('office.tags.none')}
          </p>
        )}
      </div>
    </div>
  )
}

export interface OfficeFileMenuInput {
  file: OfficeFileSummary
  /** The selection the action applies to; the right-clicked file is always included. */
  targets: readonly OfficeFileSummary[]
  tags: readonly OfficeTag[]
  trashed: boolean
  clipboardEmpty: boolean
  onOpen: (file: OfficeFileSummary) => void
  onRename: (file: OfficeFileSummary) => void
  onDuplicate: (file: OfficeFileSummary) => void
  onDownload: (file: OfficeFileSummary) => void
  onToggleStar: (files: readonly OfficeFileSummary[]) => void
  onTogglePin: (file: OfficeFileSummary) => void
  onCopy: (files: readonly OfficeFileSummary[]) => void
  onCut: (files: readonly OfficeFileSummary[]) => void
  onPaste: (folderId: string | null) => void
  onMove: (files: readonly OfficeFileSummary[]) => void
  onAddTag: (files: readonly OfficeFileSummary[], tagIds: string[]) => void
  onVersions: (file: OfficeFileSummary) => void
  onDetails: (file: OfficeFileSummary) => void
  onDelete: (files: readonly OfficeFileSummary[]) => void
  onRestore: (files: readonly OfficeFileSummary[]) => void
  onPurge: (files: readonly OfficeFileSummary[]) => void
}

export function fileMenuItems(input: OfficeFileMenuInput): MenuItem[] {
  const { file, targets, trashed } = input
  const single = targets.length === 1
  if (trashed) {
    return [
      {
        id: 'restore',
        label: t('office.action.restore'),
        icon: <RotateCcw size={14} />,
        onSelect: () => input.onRestore(targets),
      },
      {
        id: 'details',
        label: t('office.action.details'),
        icon: <Info size={14} />,
        disabled: !single,
        onSelect: () => input.onDetails(file),
      },
      {
        id: 'purge',
        label: t('office.action.purge'),
        icon: <Trash2 size={14} />,
        tone: 'danger',
        separatorBefore: true,
        onSelect: () => input.onPurge(targets),
      },
    ]
  }
  const allStarred = targets.every((item) => item.isStarred)
  return [
    {
      id: 'open',
      label: t('office.action.open'),
      icon: <FolderOpen size={14} />,
      disabled: !single,
      onSelect: () => input.onOpen(file),
    },
    {
      id: 'rename',
      label: t('office.action.rename'),
      icon: <Pencil size={14} />,
      disabled: !single,
      onSelect: () => input.onRename(file),
    },
    {
      id: 'duplicate',
      label: t('office.action.duplicate'),
      icon: <Copy size={14} />,
      disabled: !single,
      onSelect: () => input.onDuplicate(file),
    },
    {
      id: 'copy',
      label: t('office.action.copy'),
      icon: <Copy size={14} />,
      onSelect: () => input.onCopy(targets),
    },
    {
      id: 'cut',
      label: t('office.action.cut'),
      icon: <Scissors size={14} />,
      onSelect: () => input.onCut(targets),
    },
    {
      id: 'paste',
      label: t('office.action.paste'),
      icon: <ClipboardPaste size={14} />,
      disabled: input.clipboardEmpty,
      ...(input.clipboardEmpty ? { reason: t('office.clipboard.empty') } : {}),
      onSelect: () => input.onPaste(file.folderId),
    },
    {
      id: 'download',
      label: t('office.action.download'),
      icon: <Download size={14} />,
      disabled: !single,
      onSelect: () => input.onDownload(file),
    },
    {
      id: 'star',
      label: allStarred ? t('office.action.unstar') : t('office.action.star'),
      icon: allStarred ? <StarOff size={14} /> : <Star size={14} />,
      onSelect: () => input.onToggleStar(targets),
    },
    {
      id: 'pin',
      label: file.isPinned ? t('office.action.unpin') : t('office.action.pin'),
      icon: file.isPinned ? <PinOff size={14} /> : <Pin size={14} />,
      disabled: !single,
      separatorBefore: true,
      onSelect: () => input.onTogglePin(file),
    },
    {
      id: 'move',
      label: t('office.action.move'),
      icon: <FolderInput size={14} />,
      onSelect: () => input.onMove(targets),
    },
    {
      id: 'tags',
      label: t('office.action.tags'),
      icon: <Tags size={14} />,
      submenu: ({ closeMenu }) => (
        <TagAddMenu
          tags={input.tags}
          closeMenu={closeMenu}
          onAdd={(tagIds) => input.onAddTag(targets, tagIds)}
        />
      ),
    },
    {
      id: 'versions',
      label: t('office.action.versions'),
      icon: <History size={14} />,
      disabled: !single || file.rev === 0,
      ...(!single ? {} : file.rev === 0 ? { reason: t('office.versions.empty') } : {}),
      onSelect: () => input.onVersions(file),
    },
    {
      id: 'details',
      label: t('office.action.details'),
      icon: <Info size={14} />,
      disabled: !single,
      onSelect: () => input.onDetails(file),
    },
    {
      id: 'delete',
      label: t('office.action.delete'),
      icon: <Trash2 size={14} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => input.onDelete(targets),
    },
  ]
}

export interface OfficeFolderMenuInput {
  folder: OfficeFolder
  moveTree: readonly MoveMenuFolder[]
  excludedIds: ReadonlySet<string>
  clipboardEmpty: boolean
  canCreateChild: boolean
  onOpen: (folder: OfficeFolder) => void
  onCreateFile: (folderId: string, type: OfficeFileType) => void
  onCreateChild: (folderId: string) => void
  onRename: (folder: OfficeFolder) => void
  onColor: (folder: OfficeFolder, color: string | null) => void
  onIcon: (folder: OfficeFolder, icon: string | null) => void
  onMove: (folder: OfficeFolder, parentId: string | null) => void
  onSort: (folder: OfficeFolder, key: 'name' | 'updated') => void
  onPaste: (folderId: string) => void
  onDelete: (folder: OfficeFolder, strategy: 'move-up' | 'delete') => void
}

export function folderMenuItems(input: OfficeFolderMenuInput): MenuItem[] {
  const { folder } = input
  return [
    {
      id: 'open',
      label: t('office.action.open'),
      icon: <FolderOpen size={14} />,
      onSelect: () => input.onOpen(folder),
    },
    {
      id: 'new-file',
      label: t('office.menu.folder.new_file'),
      icon: <FilePlus2 size={14} />,
      submenu: ({ closeMenu }) => (
        <MenuSubmenuList
          label={t('office.menu.folder.new_file')}
          width={196}
          items={newFileItems((type) => {
            input.onCreateFile(folder.id, type)
            closeMenu()
          })}
        />
      ),
    },
    {
      id: 'new-child',
      label: t('office.folder.new_child'),
      icon: <FolderPlus size={14} />,
      disabled: !input.canCreateChild,
      ...(input.canCreateChild ? {} : { reason: t('office.folder.depth_limit') }),
      onSelect: () => input.onCreateChild(folder.id),
    },
    {
      id: 'paste',
      label: t('office.menu.folder.paste_here'),
      icon: <ClipboardPaste size={14} />,
      disabled: input.clipboardEmpty,
      ...(input.clipboardEmpty ? { reason: t('office.clipboard.empty') } : {}),
      onSelect: () => input.onPaste(folder.id),
    },
    {
      id: 'rename',
      label: t('office.folder.rename'),
      icon: <Pencil size={14} />,
      separatorBefore: true,
      onSelect: () => input.onRename(folder),
    },
    {
      id: 'color',
      label: t('office.folder.color'),
      icon: <Palette size={14} />,
      submenu: ({ closeMenu }) => (
        <FolderColorMenu
          color={folder.color}
          onSelectColor={(color) => {
            input.onColor(folder, color)
            closeMenu()
          }}
        />
      ),
    },
    {
      id: 'icon',
      label: t('office.folder.icon'),
      icon: <Smile size={14} />,
      submenu: ({ closeMenu }) => (
        <FolderIconMenu
          icon={folder.icon}
          onSelectIcon={(icon) => {
            input.onIcon(folder, icon)
            closeMenu()
          }}
        />
      ),
    },
    {
      id: 'move',
      label: t('office.folder.move'),
      icon: <FolderInput size={14} />,
      submenu: ({ closeMenu }) => (
        <FolderMoveMenu
          tree={input.moveTree}
          subject={{ id: folder.id, name: folder.name, children: [], directNotes: 0, icon: folder.icon, color: folder.color }}
          currentParentId={folder.parentId}
          excludedIds={input.excludedIds}
          rootLabel={t('office.folder.root')}
          onSelect={(parentId) => {
            input.onMove(folder, parentId)
            closeMenu()
          }}
        />
      ),
    },
    {
      id: 'sort',
      label: t('office.menu.folder.sort'),
      icon: <ArrowUpDown size={14} />,
      submenu: ({ closeMenu }) => (
        <MenuSubmenuList
          label={t('office.menu.folder.sort')}
          items={[
            {
              id: 'sort-name',
              label: t('office.menu.folder.sort_by_name'),
              onSelect: () => {
                input.onSort(folder, 'name')
                closeMenu()
              },
            },
            {
              id: 'sort-updated',
              label: t('office.menu.folder.sort_by_updated'),
              onSelect: () => {
                input.onSort(folder, 'updated')
                closeMenu()
              },
            },
          ]}
        />
      ),
    },
    {
      id: 'delete',
      label: t('office.folder.delete'),
      icon: <Trash2 size={14} />,
      tone: 'danger',
      separatorBefore: true,
      submenu: ({ closeMenu }) => (
        <MenuSubmenuList
          label={t('office.folder.delete')}
          width={214}
          items={[
            {
              id: 'delete-move-up',
              label: t('office.folder.delete.move_up'),
              onSelect: () => {
                input.onDelete(folder, 'move-up')
                closeMenu()
              },
            },
            {
              id: 'delete-subtree',
              label: t('office.folder.delete.delete_subtree'),
              tone: 'danger',
              onSelect: () => {
                input.onDelete(folder, 'delete')
                closeMenu()
              },
            },
          ]}
        />
      ),
    },
  ]
}

export interface OfficeTagMenuInput {
  tag: OfficeTag
  path: string
  required: boolean
  onRequire: (tag: OfficeTag | null) => void
  onRename: (tag: OfficeTag) => void
  onCreateChild: (path: string) => void
  onColor: (tag: OfficeTag, color: string | null) => void
  onTogglePin: (tag: OfficeTag) => void
  onDelete: (tag: OfficeTag) => void
}

export function tagMenuItems(input: OfficeTagMenuInput): MenuItem[] {
  const { tag } = input
  return [
    {
      id: 'require',
      label: t('office.tag.require'),
      icon: <Tags size={14} />,
      checked: input.required,
      onSelect: () => input.onRequire(input.required ? null : tag),
    },
    {
      id: 'exclude',
      label: t('office.tag.exclude'),
      icon: <Tags size={14} />,
      disabled: true,
      reason: t('office.tag.exclude_unavailable'),
      onSelect: () => undefined,
    },
    {
      id: 'rename',
      label: t('office.tag.rename'),
      icon: <Pencil size={14} />,
      separatorBefore: true,
      onSelect: () => input.onRename(tag),
    },
    {
      id: 'new-child',
      label: t('office.tag.new_child'),
      icon: <Plus size={14} />,
      onSelect: () => input.onCreateChild(input.path),
    },
    {
      id: 'color',
      label: t('office.tag.color'),
      icon: <Palette size={14} />,
      submenu: ({ closeMenu }) => (
        <TagColorMenu
          color={tag.color}
          onSelectColor={(color) => {
            input.onColor(tag, color)
            closeMenu()
          }}
        />
      ),
    },
    {
      id: 'pin',
      label: t('office.tag.pin'),
      icon: tag.isPinned ? <PinOff size={14} /> : <Pin size={14} />,
      checked: tag.isPinned,
      onSelect: () => input.onTogglePin(tag),
    },
    {
      id: 'delete',
      label: t('office.tag.delete'),
      icon: <Trash2 size={14} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => input.onDelete(tag),
    },
  ]
}

export interface OfficeBlankMenuInput {
  viewMode: OfficeViewMode
  sortKey: OfficeSortKey
  sortDir: OfficeSortDirection
  clipboardEmpty: boolean
  onCreateFile: (type: OfficeFileType) => void
  onCreateFolder: () => void
  onPaste: () => void
  onRefresh: () => void
  onImport: () => void
  onViewMode: (mode: OfficeViewMode) => void
  onSort: (key: OfficeSortKey, dir: OfficeSortDirection) => void
}

export function blankAreaMenuItems(input: OfficeBlankMenuInput): MenuItem[] {
  return [
    {
      id: 'new-file',
      label: t('office.menu.blank.new_file'),
      icon: <FilePlus2 size={14} />,
      submenu: ({ closeMenu }) => (
        <MenuSubmenuList
          label={t('office.menu.blank.new_file')}
          width={196}
          items={newFileItems((type) => {
            input.onCreateFile(type)
            closeMenu()
          })}
        />
      ),
    },
    {
      id: 'new-folder',
      label: t('office.menu.blank.new_folder'),
      icon: <FolderPlus size={14} />,
      onSelect: input.onCreateFolder,
    },
    {
      id: 'import',
      label: t('office.action.import'),
      icon: <Upload size={14} />,
      onSelect: input.onImport,
    },
    {
      id: 'paste',
      label: t('office.menu.blank.paste'),
      icon: <ClipboardPaste size={14} />,
      disabled: input.clipboardEmpty,
      ...(input.clipboardEmpty ? { reason: t('office.clipboard.empty') } : {}),
      onSelect: input.onPaste,
    },
    {
      id: 'refresh',
      label: t('office.menu.blank.refresh'),
      icon: <RefreshCw size={14} />,
      separatorBefore: true,
      onSelect: input.onRefresh,
    },
    {
      id: 'view',
      label: t('office.view.label'),
      icon: <LayoutGrid size={14} />,
      submenu: () => (
        <MenuSubmenuList
          label={t('office.view.label')}
          items={OFFICE_VIEW_MODES.map((mode): MenuItem => ({
            id: `view-${mode}`,
            label: officeViewLabel(mode),
            icon: officeViewIcon(mode),
            checked: input.viewMode === mode,
            onSelect: () => input.onViewMode(mode),
          }))}
        />
      ),
    },
    {
      id: 'sort',
      label: t('office.menu.blank.sort'),
      icon: <ArrowUpDown size={14} />,
      submenu: () => (
        <MenuSubmenuList
          label={t('office.menu.blank.sort')}
          items={sortItems(input.sortKey, input.sortDir, input.onSort)}
        />
      ),
    },
  ]
}

export interface OfficeEditorTabMenuInput {
  index: number
  count: number
  onClose: () => void
  onCloseOthers: () => void
  onCloseRight: () => void
  onDuplicate: () => void
  onShowInList: () => void
}

export function editorTabMenuItems(input: OfficeEditorTabMenuInput): MenuItem[] {
  return [
    {
      id: 'close',
      label: t('office.menu.tab.close'),
      icon: <FolderClosed size={14} />,
      onSelect: input.onClose,
    },
    {
      id: 'close-others',
      label: t('office.menu.tab.close_others'),
      disabled: input.count < 2,
      onSelect: input.onCloseOthers,
    },
    {
      id: 'close-right',
      label: t('office.menu.tab.close_right'),
      disabled: input.index >= input.count - 1,
      onSelect: input.onCloseRight,
    },
    {
      id: 'duplicate',
      label: t('office.action.duplicate'),
      icon: <Copy size={14} />,
      separatorBefore: true,
      onSelect: input.onDuplicate,
    },
    {
      id: 'show-in-list',
      label: t('office.menu.tab.show_in_list'),
      icon: <List size={14} />,
      onSelect: input.onShowInList,
    },
  ]
}