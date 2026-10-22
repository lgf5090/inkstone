import { useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Palette,
  Pencil,
  Smile,
  Trash2,
} from 'lucide-react'
import { cn } from '../../../lib/cn'
import { isImeComposing } from '../../../lib/ime'
import { t } from '../../../lib/i18n'
import { treeIndent } from '../../../lib/tree/indent'
import type { FolderNode } from '../../../store/notes'
import { Menu, confirm, useContextMenu, type MenuItem } from '../../../components/overlay'
import { FolderColorMenu, FolderIconMenu } from '../../folders/FolderAppearanceMenus'
import { HUB_ATTACHMENT_DRAG_TYPE, parseDroppedFileIds } from '../attachment-helpers'
import type { HubOrganizerState } from '../attachment-store'

export interface HubFolderRowProps {
  node: FolderNode
  selectedFolderId: string | null
  renamingFolderId: string | null
  expandedFolders: string[]
  onToggleExpand: (id: string) => void
  onStartRename: (id: string) => void
  onFinishRename: (id: string, name: string) => void
  onSelectFolder: (id: string | null) => void
  onChooseParent: (id: string) => void
  onDropFilesToFolder: (fileIds: string[], targetFolderId: string | null) => Promise<void>
  createFolder: HubOrganizerState['createFolder']
  patchFolder: HubOrganizerState['patchFolder']
  deleteFolder: HubOrganizerState['deleteFolder']
}

function buildFolderMenuItems(props: HubFolderRowProps): MenuItem[] {
  const { node, createFolder, patchFolder, deleteFolder, onStartRename, onChooseParent } = props
  return [
    { id: 'new_subfolder', label: t('sidebar.new_subfolder'), icon: <FolderPlus size={13} />, onSelect: () => void createFolder(undefined, node.id) },
    { id: 'rename', label: t('sidebar.rename'), icon: <Pencil size={13} />, onSelect: () => onStartRename(node.id) },
    {
      id: 'color',
      label: t('folders.color'),
      icon: <Palette size={13} />,
      submenu: ({ closeMenu }) => (
        <FolderColorMenu
          color={node.color}
          onSelectColor={(color) => {
            void patchFolder(node.id, { color })
            closeMenu()
          }}
        />
      ),
    },
    {
      id: 'icon',
      label: t('folders.icon'),
      icon: <Smile size={13} />,
      submenu: ({ closeMenu }) => (
        <FolderIconMenu
          icon={node.icon}
          onSelectIcon={(icon) => {
            void patchFolder(node.id, { icon })
            closeMenu()
          }}
        />
      ),
    },
    { id: 'move', label: t('folders.move_to'), icon: <FolderClosed size={13} />, onSelect: () => onChooseParent(node.id) },
    {
      id: 'delete',
      label: t('sidebar.delete_folder'),
      icon: <Trash2 size={13} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => {
        void confirm({ title: t('sidebar.delete_folder_value0', { value0: node.name }), confirmLabel: t('common.delete'), tone: 'danger' }).then((ok) => {
          if (ok) void deleteFolder(node.id)
        })
      },
    },
  ]
}

export function HubFolderRow(props: HubFolderRowProps) {
  const { node, selectedFolderId, renamingFolderId, expandedFolders } = props
  const [nameInput, setNameInput] = useState(node.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const contextMenu = useContextMenu()

  useEffect(() => {
    if (renamingFolderId === node.id) {
      setNameInput(node.name)
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [renamingFolderId, node.id, node.name])

  const expanded = expandedFolders.includes(node.id)
  const hasChildren = Boolean(node.children?.length)
  const menuItems = buildFolderMenuItems(props)

  return (
    <div>
      <FolderRowBody
        {...props}
        isRenaming={renamingFolderId === node.id}
        nameInput={nameInput}
        inputRef={inputRef}
        moreButtonRef={moreButtonRef}
        expanded={expanded}
        hasChildren={hasChildren}
        active={selectedFolderId === node.id}
        onNameChange={setNameInput}
        onMoreClick={() => setIsMenuOpen((prev) => !prev)}
        onRowContextMenu={(e) => {
          setIsMenuOpen(false)
          contextMenu.onContextMenu(e)
        }}
      />
      <Menu open={isMenuOpen} anchor={moreButtonRef} items={menuItems} onClose={() => setIsMenuOpen(false)} />
      {contextMenu.point && <Menu open anchor={contextMenu.point} items={menuItems} onClose={contextMenu.close} />}
      {hasChildren && expanded && (
        <div className='space-y-px'>
          {node.children!.map((child) => (
            <HubFolderRow key={child.id} {...props} node={child} />
          ))}
        </div>
      )}
    </div>
  )
}

interface FolderRowBodyProps extends HubFolderRowProps {
  expanded: boolean
  active: boolean
  hasChildren: boolean
  isRenaming: boolean
  nameInput: string
  inputRef: React.RefObject<HTMLInputElement | null>
  moreButtonRef: React.RefObject<HTMLButtonElement | null>
  onNameChange: (value: string) => void
  onMoreClick: () => void
  onRowContextMenu: (e: React.MouseEvent) => void
}

function FolderRowBody(props: FolderRowBodyProps) {
  const {
    node, expanded, active, hasChildren, isRenaming, nameInput, inputRef, moreButtonRef,
    onNameChange, onToggleExpand, onFinishRename, onSelectFolder, onMoreClick, onRowContextMenu,
    onDropFilesToFolder,
  } = props
  const [isDragOver, setIsDragOver] = useState(false)

  return (
    <div
      onContextMenu={onRowContextMenu}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(HUB_ATTACHMENT_DRAG_TYPE)) return
        e.preventDefault()
        e.stopPropagation()
        setIsDragOver(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDragOver(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(HUB_ATTACHMENT_DRAG_TYPE)) return
        e.preventDefault()
        e.stopPropagation()
        setIsDragOver(false)
        const ids = parseDroppedFileIds(e.dataTransfer.getData(HUB_ATTACHMENT_DRAG_TYPE))
        if (ids.length) void onDropFilesToFolder(ids, node.id)
      }}
      style={{ paddingLeft: `${treeIndent(node.depth)}px` }}
      className={cn(
        'group flex h-8 w-full items-center gap-[var(--sp-1)] rounded-[var(--r-md)] pr-[var(--sp-1)] text-left text-[length:var(--text-12)] font-medium transition-colors',
        active ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        isDragOver && 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]',
      )}
    >
      <button
        type='button'
        aria-expanded={expanded}
        aria-label={t(expanded ? 'sidebar.collapse' : 'sidebar.expand')}
        onClick={(e) => {
          e.stopPropagation()
          onToggleExpand(node.id)
        }}
        className={cn(
          'flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-tertiary)] transition-transform',
          !hasChildren && 'invisible',
          expanded && 'rotate-90',
        )}
      >
        <ChevronRight size={11} />
      </button>

      {isRenaming ? (
        <input
          ref={inputRef}
          type='text'
          value={nameInput}
          aria-label={t('sidebar.rename')}
          onChange={(e) => onNameChange(e.target.value)}
          onBlur={() => onFinishRename(node.id, nameInput.trim() || node.name)}
          onKeyDown={(e) => {
            // Enter accepts an IME candidate as well as it commits a name, so a reader typing a
            // folder in pinyin would finish with half a word and a closed field.
            if (isImeComposing(e)) return
            if (e.key === 'Enter') onFinishRename(node.id, nameInput.trim() || node.name)
            if (e.key === 'Escape') onFinishRename(node.id, node.name)
          }}
          className='min-w-0 flex-1 rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-[var(--sp-1)] py-[var(--sp-0-5)] text-[length:var(--text-12)] text-[var(--text-primary)] outline-none'
        />
      ) : (
        <button
          type='button'
          onClick={() => onSelectFolder(node.id)}
          className='flex min-w-0 flex-1 cursor-pointer items-center gap-[var(--sp-1-5)] py-[var(--sp-1)] text-left'
        >
          <span style={{ color: node.color ?? undefined }} className={cn('shrink-0', !node.color && 'text-[var(--text-quaternary)]')}>
            {node.icon ? <span className='text-[length:var(--text-12)]'>{node.icon}</span> : expanded ? <FolderOpen size={13} /> : <FolderClosed size={13} />}
          </span>
          <span className='truncate'>{node.name}</span>
        </button>
      )}

      <button
        ref={moreButtonRef}
        type='button'
        aria-label={t('common.more_actions')}
        onClick={(e) => {
          e.stopPropagation()
          onMoreClick()
        }}
        className='cursor-pointer rounded p-[var(--sp-0-5)] text-[var(--text-quaternary)] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[var(--bg-sunken)] hover:text-[var(--text-primary)]'
      >
        <MoreHorizontal size={12} />
      </button>
    </div>
  )
}
