import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { AlarmClock, Archive, Bookmark, ChevronRight, ChevronsUpDown, FileText, Flag, FolderClosed, FolderPlus, Inbox, MoreHorizontal, PanelLeft, PanelLeftClose, Palette, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import type { EmailFolder, EmailSystemFolder, EmailTag } from '@shared/email/model'
import { EMAIL_SIDEBAR_FOLDERS, isEmailSystemFolder } from '@shared/email/model'
import type { EmailSavedSearch } from '@shared/email/searches'
import { emailSearchQueriesEqual } from '@shared/email/searches'
import {
  emailFolderDepthAllowed,
  emailFolderDescendantIds,
  emailFolderMoveAllowed,
  emailFolderTree,
  type EmailFolderNode,
} from '@shared/email/folders'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Button, IconButton, SectionLabel, Spinner } from '../../components/primitives'
import { FilterInput } from '../../components/FilterInput'
import { Menu, Tooltip, confirm, prompt, useContextMenu, type MenuItem } from '../../components/overlay'
import { compileQuery, queryKeeps, type Query } from '../../lib/query-match'
import { usePinyinVersion } from '../../lib/pinyin'
import { useDropState } from '../../lib/drop-state'
import { treeIndent, treeItemProps, useExpandedSet, useTreeKeyboard, type MoveMenuFolder } from '../../lib/tree'
import { useUi } from '../../store/ui'
import { FolderColorMenu } from '../folders/FolderAppearanceMenus'
import { FolderMoveMenu } from '../folders/FolderMoveMenu'
import {
  dragLeftTarget,
  emailDragBlocked,
  hasEmailDrag,
  hasEmailFolderDrag,
  readEmailDrag,
  readEmailFolderDrag,
  setEmailDragImage,
  writeEmailFolderDrag,
} from './email-drag'
import { reportEmailFailure } from './email-org'
import { EmailTagSidebar } from './EmailTagSidebar'
import { EMAIL_SIDEBAR_PANEL_ID, EmailSidebarTabs, emailSidebarTabId, type EmailSidebarTab } from './EmailSidebarTabs'
import { SYSTEM_FOLDER_LABEL_KEYS } from './format'
import type { EmailLoadStatus } from './store'

const FOLDER_ICONS: Record<EmailSystemFolder, typeof Inbox> = {
  inbox: Inbox,
  sent: Send,
  draft: FileText,
  archive: Archive,
  trash: Trash2,
  spam: Trash2,
}

const FOLDER_MENU_WIDTH = 184

interface FolderTreeActions {
  folders: readonly EmailFolder[]
  activeFolderId: string | null
  expanded: ReadonlySet<string>
  forceOpen: boolean
  moveTree: MoveMenuFolder[]
  onToggle: (folderId: string) => void
  onSelect: (folderId: string) => void
  onNewChild: (folder: EmailFolder, label: string) => void
  onRename: (folder: EmailFolder) => void
  onColor: (folder: EmailFolder, color: string | null) => void
  onMove: (folder: EmailFolder, parentId: string | null) => void
  onDelete: (folder: EmailFolder) => void
  onDropMessages: (folderId: string, emailIds: string[]) => void
  onDropFolder: (folderId: string, parentId: string) => void
}

function placeholderSystemNode(id: EmailSystemFolder): EmailFolderNode {
  return {
    folder: { id, name: id, isDeletable: false, unreadCount: 0, parentId: null, color: null, sortOrder: 0 },
    depth: 0,
    children: [],
  }
}

function toMoveMenuTree(nodes: readonly EmailFolderNode[]): MoveMenuFolder[] {
  return nodes.map((node) => ({
    id: node.folder.id,
    name: node.folder.name,
    children: toMoveMenuTree(node.children),
    directNotes: 0,
    color: node.folder.color,
  }))
}

function moveExclusions(folders: readonly EmailFolder[], folderId: string): Set<string> {
  return new Set(
    folders
      .filter((candidate) => !emailFolderMoveAllowed(folders, folderId, candidate.id))
      .map((candidate) => candidate.id),
  )
}

function folderLabel(folder: EmailFolder): string {
  return isEmailSystemFolder(folder.id) ? t(SYSTEM_FOLDER_LABEL_KEYS[folder.id]) : folder.name
}

function filterFolderNodes(nodes: readonly EmailFolderNode[], query: Query): EmailFolderNode[] {
  return nodes.flatMap((node) => {
    const children = filterFolderNodes(node.children, query)
    if (queryKeeps(query, folderLabel(node.folder))) return [node]
    return children.length ? [{ ...node, children }] : []
  })
}

function collectParentFolderIds(nodes: readonly EmailFolderNode[]): string[] {
  return nodes.flatMap((node) => node.children.length ? [node.folder.id, ...collectParentFolderIds(node.children)] : [])
}

export type EmailSystemSearch = 'important' | 'followup'

export function FolderSidebar({
  accountId,
  folders,
  activeFolderId,
  activeSystemSearch,
  onSelectSystemSearch,
  onSelect,
  onCreate,
  onRename,
  onColor,
  onMove,
  onDelete,
  onDropMessages,
  onDropTagMessages,
  tags,
  tagsStatus,
  tagsError,
  activeTagName,
  onSelectTag,
  onReloadTags,
  searches,
  searchesStatus,
  searchesError,
  activeSearchQuery,
  onSelectSearch,
  onSaveCurrentSearch,
  onRenameSearch,
  onDeleteSearch,
  onReloadSearches,
  onClose,
  onCollapse,
  accountSwitcher,
  favoritesTab,
  contactsTab,
  groupsTab,
  footer,
}: {
  accountId: string
  folders: readonly EmailFolder[]
  activeFolderId: string | null
  activeSystemSearch: EmailSystemSearch | null
  onSelectSystemSearch: (query: string) => void
  onSelect: (folderId: string) => void
  onCreate: (name: string, parentId: string | null) => Promise<void>
  onRename: (folderId: string, name: string) => Promise<void>
  onColor: (folderId: string, color: string | null) => Promise<void>
  onMove: (folderId: string, parentId: string | null) => Promise<void>
  onDelete: (folderId: string) => Promise<void>
  onDropMessages: (folderId: string, emailIds: string[]) => void
  onDropTagMessages: (tag: EmailTag, emailIds: string[]) => void
  tags: readonly EmailTag[]
  tagsStatus: EmailLoadStatus
  tagsError: string | null
  activeTagName: string | null
  onSelectTag: (name: string) => void
  onReloadTags: () => Promise<void>
  searches: readonly EmailSavedSearch[]
  searchesStatus: EmailLoadStatus
  searchesError: string | null
  activeSearchQuery: string | null
  onSelectSearch: (query: string) => void
  onSaveCurrentSearch: () => void
  onRenameSearch: (searchId: string, name: string) => Promise<void>
  onDeleteSearch: (searchId: string) => Promise<void>
  onReloadSearches: () => Promise<void>
  onClose?: () => void
  onCollapse?: () => void
  accountSwitcher?: ReactNode
  favoritesTab?: ReactNode
  contactsTab?: ReactNode
  groupsTab?: ReactNode
  footer?: ReactNode
}) {
  const { expanded, toggle, setMany, setExpanded } = useExpandedSet()
  const [tab, setTab] = useState<EmailSidebarTab>('folders')
  const [folderQuery, setFolderQuery] = useState('')
  const pinyinVersion = usePinyinVersion()
  const compiledFolderQuery = useMemo(() => compileQuery(folderQuery), [folderQuery])
  const searchingFolders = Boolean(folderQuery.trim()) && !compiledFolderQuery.error
  const tree = useMemo(() => emailFolderTree(folders), [folders])
  const systemNodes = useMemo(
    () => EMAIL_SIDEBAR_FOLDERS.map((id) => tree.find((node) => node.folder.id === id) ?? placeholderSystemNode(id)),
    [tree],
  )
  const customFolders = useMemo(() => folders.filter((folder) => !isEmailSystemFolder(folder.id)), [folders])
  const nestedUnderSystem = useMemo(() => {
    const ids = new Set<string>()
    for (const id of EMAIL_SIDEBAR_FOLDERS) {
      for (const child of emailFolderDescendantIds(folders, id)) ids.add(child)
    }
    return ids
  }, [folders])
  const customRoots = useMemo(
    () => customFolders.filter((folder) => !nestedUnderSystem.has(folder.id)),
    [customFolders, nestedUnderSystem],
  )
  const customTree = useMemo(() => emailFolderTree(customRoots), [customRoots])
  const moveTree = useMemo(() => toMoveMenuTree(emailFolderTree(customFolders)), [customFolders])
  const shownSystemNodes = useMemo(
    () => searchingFolders ? systemNodes.filter((node) => queryKeeps(compiledFolderQuery, folderLabel(node.folder))) : systemNodes,
    [compiledFolderQuery, pinyinVersion, searchingFolders, systemNodes],
  )
  const shownCustomTree = useMemo(
    () => searchingFolders ? filterFolderNodes(customTree, compiledFolderQuery) : customTree,
    [compiledFolderQuery, customTree, pinyinVersion, searchingFolders],
  )
  const treeParentIds = useMemo(() => collectParentFolderIds(tree), [tree])
  const allParentsExpanded = treeParentIds.length > 0 && treeParentIds.every((id) => expanded.has(id))
  const noFolderMatches = searchingFolders && shownSystemNodes.length === 0 && shownCustomTree.length === 0

  useEffect(() => {
    if (!activeFolderId) return
    const byId = new Map(folders.map((folder) => [folder.id, folder]))
    const seen = new Set<string>([activeFolderId])
    const ancestors: string[] = []
    let current = byId.get(activeFolderId)
    while (current?.parentId && !seen.has(current.parentId)) {
      seen.add(current.parentId)
      ancestors.push(current.parentId)
      current = byId.get(current.parentId)
    }
    if (!ancestors.length) return
    setExpanded((previous) =>
      ancestors.every((id) => previous.has(id)) ? previous : new Set([...previous, ...ancestors]),
    )
  }, [activeFolderId, folders, setExpanded])

  const choose = (folderId: string): void => {
    onSelect(folderId)
    onClose?.()
  }

  const createIn = async (parentId: string | null, parentLabel: string): Promise<void> => {
    const name = await prompt({
      title: parentId ? t('email.folder.new_child') : t('email.folder.new_title'),
      description: parentId
        ? t('email.folder.new_child_hint', { name: parentLabel })
        : t('email.folder.new_hint'),
      placeholder: t('email.folder.name_placeholder'),
      confirmLabel: t('email.folder.create'),
    })
    if (name === null) return
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      await onCreate(trimmed, parentId)
      if (parentId) setMany([parentId], true)
    } catch (error) {
      reportEmailFailure(error)
    }
  }

  const rename = async (folder: EmailFolder): Promise<void> => {
    const name = await prompt({
      title: t('email.folder.rename_title', { name: folder.name }),
      placeholder: t('email.folder.name_placeholder'),
      defaultValue: folder.name,
      confirmLabel: t('email.folder.rename'),
    })
    if (name === null) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === folder.name) return
    try {
      await onRename(folder.id, trimmed)
    } catch (error) {
      reportEmailFailure(error)
    }
  }

  const setColor = async (folder: EmailFolder, color: string | null): Promise<void> => {
    try {
      await onColor(folder.id, color)
    } catch (error) {
      reportEmailFailure(error)
    }
  }

  const move = async (folder: EmailFolder, parentId: string | null): Promise<void> => {
    try {
      await onMove(folder.id, parentId)
      if (parentId) setMany([parentId], true)
    } catch (error) {
      reportEmailFailure(error)
    }
  }

  const dropFolder = (draggedId: string, parentId: string): void => {
    if (draggedId === parentId || !emailFolderMoveAllowed(folders, draggedId, parentId)) {
      useUi.getState().toast({ title: t('email.drag.folder_invalid'), tone: 'danger' })
      return
    }
    const dragged = folders.find((folder) => folder.id === draggedId)
    if (!dragged) return
    void move(dragged, parentId)
  }

  const remove = async (folder: EmailFolder): Promise<void> => {
    const ok = await confirm({
      title: t('email.folder.delete_title', { name: folder.name }),
      description: t('email.folder.delete_hint'),
      confirmLabel: t('email.folder.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await onDelete(folder.id)
    } catch (error) {
      reportEmailFailure(error)
    }
  }

  const actions: FolderTreeActions = {
    folders,
    activeFolderId,
    expanded,
    forceOpen: searchingFolders,
    moveTree,
    onToggle: toggle,
    onSelect: choose,
    onNewChild: (folder, label) => { void createIn(folder.id, label) },
    onRename: (folder) => { void rename(folder) },
    onColor: (folder, color) => { void setColor(folder, color) },
    onMove: (folder, parentId) => { void move(folder, parentId) },
    onDelete: (folder) => { void remove(folder) },
    onDropMessages,
    onDropFolder: dropFolder,
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--bg-sunken)]">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2">
        <div className="min-w-0 flex-1">{accountSwitcher}</div>
        {onCollapse && (
          <Tooltip label={t('sidebar.collapse_navigation')} side="right">
            <IconButton label={t('sidebar.collapse_navigation')} size="sm" onClick={onCollapse}>
              <PanelLeftClose size={14} aria-hidden="true" />
            </IconButton>
          </Tooltip>
        )}
      </header>
      <EmailSidebarTabs active={tab} onSelect={setTab} />
      <div
        id={EMAIL_SIDEBAR_PANEL_ID}
        role="tabpanel"
        aria-labelledby={emailSidebarTabId(tab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        {tab === 'folders' && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-8 shrink-0 items-center justify-between gap-1 px-2">
              <Tooltip label={allParentsExpanded ? t('email.folder.collapse_all') : t('email.folder.expand_all')} side="bottom">
                <IconButton
                  label={allParentsExpanded ? t('email.folder.collapse_all') : t('email.folder.expand_all')}
                  size="xs"
                  disabled={treeParentIds.length === 0}
                  onClick={() => setExpanded(allParentsExpanded ? new Set() : new Set(treeParentIds))}
                >
                  <ChevronsUpDown size={13} className={cn('transition-transform', allParentsExpanded && 'rotate-180')} />
                </IconButton>
              </Tooltip>
              <IconButton label={t('email.folder.new')} size="xs" onClick={() => { void createIn(null, '') }}>
                <Plus size={13} />
              </IconButton>
            </div>
            <div className="shrink-0 px-2 pb-1">
              <FilterInput
                value={folderQuery}
                onChange={setFolderQuery}
                query={compiledFolderQuery}
                label={t('email.a11y.folders')}
                placeholder={t('email.sidebar.filter_folders')}
                className="mt-0"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              <nav aria-label={t('email.a11y.folders')} className="flex flex-col gap-3">
                <div role="tree" aria-label={t('email.a11y.folders')} className="flex flex-col gap-0.5">
                  {shownSystemNodes.map((node, index) => (
                    <FolderBranch
                      key={node.folder.id}
                      node={node}
                      setSize={shownSystemNodes.length}
                      posInSet={index + 1}
                      actions={actions}
                    />
                  ))}
                </div>
                {!searchingFolders && (
                  <div className="flex flex-col gap-0.5">
                    <SectionLabel className="px-2 py-0">{t('email.folder.views')}</SectionLabel>
                    {([
                      { id: 'important', query: 'is:important', label: t('email.folder.important'), Icon: Flag },
                      { id: 'followup', query: 'is:followup', label: t('email.folder.follow_up'), Icon: AlarmClock },
                    ] as const).map(({ id, query, label, Icon }) => {
                      const active = activeSystemSearch === id
                      return (
                        <button
                          key={id}
                          type="button"
                          data-email-view={id}
                          aria-current={active ? 'page' : undefined}
                          onClick={() => {
                            onSelectSystemSearch(query)
                            onClose?.()
                          }}
                          className={cn(
                            'flex min-h-8 items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)]',
                            active
                              ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                          )}
                        >
                          <span className="flex size-4 shrink-0 items-center justify-center">
                            <Icon size={14} aria-hidden="true" />
                          </span>
                          <span className="min-w-0 flex-1 truncate">{label}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
                <div className="flex flex-col gap-0.5">
                  <SectionLabel className="px-2 py-0">{t('email.folder.custom')}</SectionLabel>
                  {shownCustomTree.length > 0 && (
                    <div role="tree" aria-label={t('email.folder.custom')} className="flex flex-col gap-0.5">
                      {shownCustomTree.map((node, index) => (
                        <FolderBranch
                          key={node.folder.id}
                          node={node}
                          setSize={shownCustomTree.length}
                          posInSet={index + 1}
                          actions={actions}
                        />
                      ))}
                    </div>
                  )}
                  {!searchingFolders && shownCustomTree.length === 0 && (
                    <p className="m-0 px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('email.folder.empty')}</p>
                  )}
                </div>
                {noFolderMatches && (
                  <p className="m-0 px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('email.sidebar.no_matches')}</p>
                )}
              </nav>
            </div>
          </div>
        )}
        {tab === 'tags' && (
          <EmailTagSidebar
            accountId={accountId}
            tags={tags}
            status={tagsStatus}
            error={tagsError}
            activeTagName={activeTagName}
            onSelect={(name) => {
              onSelectTag(name)
              onClose?.()
            }}
            onReload={onReloadTags}
            onDropMessages={onDropTagMessages}
          />
        )}
        {tab === 'favorites' && favoritesTab}
        {tab === 'contacts' && contactsTab}
        {tab === 'groups' && groupsTab}
        {tab === 'searches' && (
          <SavedSearchList
            searches={searches}
            status={searchesStatus}
            error={searchesError}
            activeSearchQuery={activeSearchQuery}
            onSelect={(query) => {
              onSelectSearch(query)
              onClose?.()
            }}
            onSaveCurrent={onSaveCurrentSearch}
            onRename={onRenameSearch}
            onDelete={onDeleteSearch}
            onReload={onReloadSearches}
          />
        )}
      </div>
      {footer && (
        <div className="shrink-0 border-t border-[var(--border-subtle)] p-2">
          {footer}
        </div>
      )}
    </div>
  )
}

function FolderBranch({
  node,
  setSize,
  posInSet,
  actions,
}: {
  node: EmailFolderNode
  setSize: number
  posInSet: number
  actions: FolderTreeActions
}) {
  const menu = useContextMenu()
  const moreRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [dropping, setDropping] = useDropState(false)
  const treeKeyDown = useTreeKeyboard()
  const folder = node.folder
  const systemId = isEmailSystemFolder(folder.id) ? folder.id : null
  const Icon = systemId ? FOLDER_ICONS[systemId] : FolderClosed
  const label = systemId ? t(SYSTEM_FOLDER_LABEL_KEYS[systemId]) : folder.name
  const hasChildren = node.children.length > 0
  const open = actions.forceOpen || actions.expanded.has(folder.id)
  const active = actions.activeFolderId === folder.id
  const childrenId = `email-folder-children-${folder.id}`
  const canCreateChild = emailFolderDepthAllowed(actions.folders, folder.id)
  const openMenuFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    event.preventDefault()
    setMenuOpen(false)
    const rect = event.currentTarget.getBoundingClientRect()
    menu.openAt({ x: rect.left + 12, y: rect.top + Math.min(rect.height / 2, 16) })
  }
  const openContextMenu = (event: ReactMouseEvent): void => {
    setMenuOpen(false)
    menu.onContextMenu(event)
  }
  const dragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    const acceptsMessages = hasEmailDrag(event.dataTransfer)
    const acceptsFolder = !systemId && hasEmailFolderDrag(event.dataTransfer)
    if (!acceptsMessages && !acceptsFolder) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropping(true)
  }
  const dragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (dragLeftTarget(event.currentTarget, event.relatedTarget)) setDropping(false)
  }
  const drop = (event: ReactDragEvent<HTMLDivElement>): void => {
    const emailIds = readEmailDrag(event.dataTransfer)
    if (emailIds.length > 0) {
      event.preventDefault()
      event.stopPropagation()
      setDropping(false)
      actions.onDropMessages(folder.id, emailIds)
      return
    }
    const draggedId = readEmailFolderDrag(event.dataTransfer)
    if (!draggedId) return
    event.preventDefault()
    event.stopPropagation()
    setDropping(false)
    if (systemId || draggedId === folder.id) return
    actions.onDropFolder(draggedId, folder.id)
  }
  const startDrag = (event: ReactDragEvent<HTMLButtonElement>): void => {
    if (systemId || emailDragBlocked()) {
      event.preventDefault()
      return
    }
    writeEmailFolderDrag(event.dataTransfer, folder.id)
    setEmailDragImage(event.dataTransfer, event.currentTarget)
  }
  const items: MenuItem[] = [
    {
      id: 'new-child',
      label: t('email.folder.new_child'),
      icon: <FolderPlus size={13} />,
      disabled: !canCreateChild,
      onSelect: () => actions.onNewChild(folder, label),
    },
  ]
  if (!systemId) {
    items.push(
      { id: 'rename', label: t('email.folder.rename'), icon: <Pencil size={13} />, onSelect: () => actions.onRename(folder) },
      {
        id: 'color',
        label: t('folders.color'),
        icon: <Palette size={13} />,
        submenu: ({ closeMenu }) => (
          <FolderColorMenu
            color={folder.color}
            onSelectColor={(color) => {
              actions.onColor(folder, color)
              closeMenu()
            }}
          />
        ),
      },
      {
        id: 'move',
        label: t('email.folder.move'),
        icon: <FolderClosed size={13} />,
        submenu: ({ closeMenu }) => (
          <FolderMoveMenu
            tree={actions.moveTree}
            subject={{ id: folder.id, name: folder.name, children: [], directNotes: 0, color: folder.color }}
            currentParentId={folder.parentId}
            excludedIds={moveExclusions(actions.folders, folder.id)}
            rootLabel={t('email.folder.top_level')}
            onSelect={(parentId) => {
              actions.onMove(folder, parentId)
              closeMenu()
            }}
          />
        ),
      },
      { id: 'delete', label: t('email.folder.delete'), icon: <Trash2 size={13} />, tone: 'danger', separatorBefore: true, onSelect: () => actions.onDelete(folder) },
    )
  }
  return (
    <div
      {...treeItemProps({ level: node.depth + 1, expanded: hasChildren ? open : undefined, selected: active, setSize, posInSet })}
      onContextMenu={openContextMenu}
      onKeyDown={openMenuFromKeyboard}
    >
      <div
        className={cn(
          'group flex min-h-8 items-center gap-0.5 pr-0.5',
          dropping && 'ring-1 ring-[var(--accent)]',
        )}
        style={{ paddingLeft: treeIndent(node.depth) }}
        onDragOver={dragOver}
        onDragLeave={dragLeave}
        onDrop={drop}
      >
        {hasChildren ? (
          <button
            type="button"
            data-tree-toggle
            aria-expanded={open}
            aria-controls={childrenId}
            aria-label={t(open ? 'email.folder.collapse' : 'email.folder.expand', { name: label })}
            onClick={() => actions.onToggle(folder.id)}
            className="flex size-4 shrink-0 items-center justify-center rounded-[var(--r-xs)] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            <ChevronRight size={12} className={open ? 'rotate-90 transition-transform duration-[var(--dur-fast)]' : 'transition-transform duration-[var(--dur-fast)]'} />
          </button>
        ) : (
          <span aria-hidden="true" className="size-4 shrink-0" />
        )}
        <button
          type="button"
          data-tree-row
          data-email-folder-row={folder.id}
          draggable={!systemId}
          onDragStart={startDrag}
          onKeyDown={treeKeyDown}
          onClick={() => actions.onSelect(folder.id)}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)]',
            active
              ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
          )}
        >
          <span
            className="flex size-4 shrink-0 items-center justify-center"
            style={folder.color && !systemId ? { color: folder.color } : undefined}
          >
            <Icon size={systemId ? 14 : 13} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {folder.unreadCount > 0 && (
            <span className="shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">
              {folder.unreadCount}
            </span>
          )}
        </button>
        <IconButton
          label={t('email.folder.more', { name: label })}
          size="xs"
          active={menuOpen}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => {
            menu.close()
            moreRef.current = event.currentTarget
            setMenuOpen(!menuOpen)
          }}
        >
          <MoreHorizontal size={12} />
        </IconButton>
      </div>
      <div id={childrenId} role={open ? 'group' : undefined}>
        {open && node.children.map((child, index) => (
          <FolderBranch
            key={child.folder.id}
            node={child}
            setSize={node.children.length}
            posInSet={index + 1}
            actions={actions}
          />
        ))}
      </div>
      <Menu anchor={moreRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} width={FOLDER_MENU_WIDTH} label={t('email.folder.more_actions')} />
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items} width={FOLDER_MENU_WIDTH} label={t('email.folder.more_actions')} />}
    </div>
  )
}

function SavedSearchList({
  searches,
  status,
  error,
  activeSearchQuery,
  onSelect,
  onSaveCurrent,
  onRename,
  onDelete,
  onReload,
}: {
  searches: readonly EmailSavedSearch[]
  status: EmailLoadStatus
  error: string | null
  activeSearchQuery: string | null
  onSelect: (query: string) => void
  onSaveCurrent: () => void
  onRename: (searchId: string, name: string) => Promise<void>
  onDelete: (searchId: string) => Promise<void>
  onReload: () => Promise<void>
}) {
  const rename = async (search: EmailSavedSearch): Promise<void> => {
    const name = await prompt({
      title: t('email.saved_search.rename_title', { name: search.name }),
      defaultValue: search.name,
      confirmLabel: t('email.saved_search.rename'),
    })
    if (name === null) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === search.name) return
    try {
      await onRename(search.id, trimmed)
    } catch (failure) {
      reportEmailFailure(failure)
    }
  }

  const remove = async (search: EmailSavedSearch): Promise<void> => {
    const ok = await confirm({
      title: t('email.saved_search.delete_title', { name: search.name }),
      description: t('email.saved_search.delete_hint'),
      confirmLabel: t('email.saved_search.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await onDelete(search.id)
    } catch (failure) {
      reportEmailFailure(failure)
    }
  }

  const [query, setQuery] = useState('')
  const pinyinVersion = usePinyinVersion()
  const compiled = useMemo(() => compileQuery(query), [query])
  const visible = useMemo(
    () => searches.filter((search) => queryKeeps(compiled, search.name) || queryKeeps(compiled, search.query)),
    [compiled, pinyinVersion, searches],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 px-2">
        <Tooltip label={t('email.saved_search.new')} side="bottom">
          <IconButton
            label={t('email.saved_search.new')}
            size="xs"
            disabled={!activeSearchQuery}
            onClick={onSaveCurrent}
          >
            <Plus size={13} />
          </IconButton>
        </Tooltip>
      </div>
      <div className="shrink-0 px-2 pb-1">
        <FilterInput
          value={query}
          onChange={setQuery}
          query={compiled}
          label={t('email.saved_search.section')}
          placeholder={t('email.sidebar.filter_searches')}
          className="mt-0"
        />
      </div>
      <nav aria-label={t('email.saved_search.section')} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
        {status === 'loading' && searches.length === 0 && (
          <p role="status" className="flex items-center gap-1.5 px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            <Spinner size={11} />
            {t('email.saved_search.loading')}
          </p>
        )}
        {status === 'error' && (
          <div role="alert" className="flex flex-col gap-1 rounded-[var(--r-md)] px-2 py-1">
            <span className="min-w-0 break-words text-[length:var(--text-11)] text-[var(--danger)]">
              {error ?? t('email.saved_search.error')}
            </span>
            <Button size="sm" variant="ghost" className="self-start" onClick={() => { void onReload() }}>
              {t('common.retry')}
            </Button>
          </div>
        )}
        {status === 'ready' && searches.length === 0 && (
          <p className="px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('email.saved_search.empty')}</p>
        )}
        {searches.length > 0 && visible.length === 0 && (
          <p className="px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('email.sidebar.no_matches')}</p>
        )}
        {visible.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {visible.map((search) => (
              <SavedSearchRow
                key={search.id}
                search={search}
                active={emailSearchQueriesEqual(search.query, activeSearchQuery)}
                onSelect={onSelect}
                onRename={(target) => { void rename(target) }}
                onDelete={(target) => { void remove(target) }}
              />
            ))}
          </ul>
        )}
      </nav>
    </div>
  )
}

function SavedSearchRow({
  search,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  search: EmailSavedSearch
  active: boolean
  onSelect: (query: string) => void
  onRename: (search: EmailSavedSearch) => void
  onDelete: (search: EmailSavedSearch) => void
}) {
  const menu = useContextMenu()
  const moreRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const openMenuFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    event.preventDefault()
    setMenuOpen(false)
    const rect = event.currentTarget.getBoundingClientRect()
    menu.openAt({ x: rect.left + 12, y: rect.top + Math.min(rect.height / 2, 16) })
  }
  const openContextMenu = (event: ReactMouseEvent): void => {
    setMenuOpen(false)
    menu.onContextMenu(event)
  }
  const items: MenuItem[] = [
    { id: 'rename', label: t('email.saved_search.rename'), icon: <Pencil size={13} />, onSelect: () => onRename(search) },
    { id: 'delete', label: t('email.saved_search.delete'), icon: <Trash2 size={13} />, tone: 'danger', separatorBefore: true, onSelect: () => onDelete(search) },
  ]
  return (
    <li className="flex min-h-8 items-center gap-0.5 pr-0.5">
      <button
        type="button"
        data-email-search-row={search.id}
        aria-current={active ? 'page' : undefined}
        onContextMenu={openContextMenu}
        onKeyDown={openMenuFromKeyboard}
        onClick={() => onSelect(search.query)}
        className={cn(
          'flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)]',
          active
            ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <Bookmark size={13} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 truncate">{search.name}</span>
      </button>
      <IconButton
        label={t('email.saved_search.more', { name: search.name })}
        size="xs"
        active={menuOpen}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => {
          menu.close()
          moreRef.current = event.currentTarget
          setMenuOpen(!menuOpen)
        }}
      >
        <MoreHorizontal size={12} />
      </IconButton>
      <Menu anchor={moreRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} width={FOLDER_MENU_WIDTH} label={t('email.saved_search.more_actions')} />
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items} width={FOLDER_MENU_WIDTH} label={t('email.saved_search.more_actions')} />}
    </li>
  )
}

export function FolderSidebarRail({
  folders,
  activeFolderId,
  onSelect,
  onExpand,
  accountSwitcher,
  footer,
}: {
  folders: readonly EmailFolder[]
  activeFolderId: string | null
  onSelect: (folderId: string) => void
  onExpand: () => void
  accountSwitcher?: ReactNode
  footer?: ReactNode
}) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  return (
    <nav aria-label={t('email.a11y.folders')} className="flex h-full min-h-0 w-full flex-col items-center gap-1 overflow-y-auto bg-[var(--bg-sunken)] py-2">
      {accountSwitcher}
      <Tooltip label={t('sidebar.expand_navigation')} side="right">
        <IconButton label={t('sidebar.expand_navigation')} onClick={onExpand}>
          <PanelLeft size={16} aria-hidden="true" />
        </IconButton>
      </Tooltip>
      <div aria-hidden="true" className="my-1 h-px w-6 shrink-0 bg-[var(--border-subtle)]" />
      {EMAIL_SIDEBAR_FOLDERS.map((id) => {
        const Icon = FOLDER_ICONS[id]
        const label = t(SYSTEM_FOLDER_LABEL_KEYS[id])
        const active = activeFolderId === id
        const unread = byId.get(id)?.unreadCount ?? 0
        return (
          <Tooltip key={id} label={unread > 0 ? `${label} · ${unread}` : label} side="right">
            <IconButton
              label={unread > 0 ? `${label} · ${unread}` : label}
              active={active}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelect(id)}
            >
              <Icon size={16} aria-hidden="true" />
            </IconButton>
          </Tooltip>
        )
      })}
      <span className="flex-1" />
      {footer && (
        <div className="flex w-full shrink-0 justify-center border-t border-[var(--border-subtle)] py-2">
          {footer}
        </div>
      )}
    </nav>
  )
}
