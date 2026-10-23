import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { AlarmClock, Archive, ChevronRight, FileText, Flag, FolderClosed, FolderPlus, Inbox, MoreHorizontal, PanelLeft, PanelLeftClose, Palette, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import type { EmailFolder, EmailSystemFolder, EmailTag } from '@shared/email/model'
import { EMAIL_SIDEBAR_FOLDERS, isEmailSystemFolder } from '@shared/email/model'
import {
  emailFolderDepthAllowed,
  emailFolderDescendantIds,
  emailFolderMoveAllowed,
  emailFolderTree,
  type EmailFolderNode,
} from '@shared/email/folders'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { IconButton, SectionLabel } from '../../components/primitives'
import { Menu, Tooltip, confirm, prompt, useContextMenu, type MenuItem } from '../../components/overlay'
import { treeIndent, treeItemProps, useExpandedSet, useTreeKeyboard, type MoveMenuFolder } from '../../lib/tree'
import { FolderColorMenu } from '../folders/FolderAppearanceMenus'
import { FolderMoveMenu } from '../folders/FolderMoveMenu'
import { reportEmailFailure } from './email-org'
import { EmailTagSidebar } from './EmailTagSidebar'
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
  moveTree: MoveMenuFolder[]
  onToggle: (folderId: string) => void
  onSelect: (folderId: string) => void
  onNewChild: (folder: EmailFolder, label: string) => void
  onRename: (folder: EmailFolder) => void
  onColor: (folder: EmailFolder, color: string | null) => void
  onMove: (folder: EmailFolder, parentId: string | null) => void
  onDelete: (folder: EmailFolder) => void
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
  tags,
  tagsStatus,
  tagsError,
  activeTagName,
  onSelectTag,
  onReloadTags,
  onClose,
  onCollapse,
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
  tags: readonly EmailTag[]
  tagsStatus: EmailLoadStatus
  tagsError: string | null
  activeTagName: string | null
  onSelectTag: (name: string) => void
  onReloadTags: () => Promise<void>
  onClose?: () => void
  onCollapse?: () => void
  footer?: ReactNode
}) {
  const { expanded, toggle, setMany, setExpanded } = useExpandedSet()
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
    moveTree,
    onToggle: toggle,
    onSelect: choose,
    onNewChild: (folder, label) => { void createIn(folder.id, label) },
    onRename: (folder) => { void rename(folder) },
    onColor: (folder, color) => { void setColor(folder, color) },
    onMove: (folder, parentId) => { void move(folder, parentId) },
    onDelete: (folder) => { void remove(folder) },
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--bg-sunken)]">
      {onCollapse && (
        <div className="flex h-11 shrink-0 items-center justify-end px-2">
          <Tooltip label={t('sidebar.collapse_navigation')} side="right">
            <IconButton label={t('sidebar.collapse_navigation')} size="sm" onClick={onCollapse}>
              <PanelLeftClose size={14} aria-hidden="true" />
            </IconButton>
          </Tooltip>
        </div>
      )}
      <div className={cn('flex min-h-0 w-full flex-1 flex-col gap-3 overflow-y-auto px-2', onCollapse ? 'pb-3' : 'py-3')}>
        <nav aria-label={t('email.a11y.folders')} className="flex flex-col gap-3">
          <div role="tree" aria-label={t('email.a11y.folders')} className="flex flex-col gap-0.5">
            {systemNodes.map((node, index) => (
              <FolderBranch
                key={node.folder.id}
                node={node}
                setSize={systemNodes.length}
                posInSet={index + 1}
                actions={actions}
              />
            ))}
          </div>
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
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between gap-1 pr-0.5">
              <SectionLabel className="p-0">{t('email.folder.custom')}</SectionLabel>
              <IconButton label={t('email.folder.new')} size="xs" onClick={() => { void createIn(null, '') }}>
                <Plus size={12} />
              </IconButton>
            </div>
            {customTree.length > 0 && (
              <div role="tree" aria-label={t('email.folder.custom')} className="flex flex-col gap-0.5">
                {customTree.map((node, index) => (
                  <FolderBranch
                    key={node.folder.id}
                    node={node}
                    setSize={customTree.length}
                    posInSet={index + 1}
                    actions={actions}
                  />
                ))}
              </div>
            )}
          </div>
        </nav>
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
        />
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
  const treeKeyDown = useTreeKeyboard()
  const folder = node.folder
  const systemId = isEmailSystemFolder(folder.id) ? folder.id : null
  const Icon = systemId ? FOLDER_ICONS[systemId] : FolderClosed
  const label = systemId ? t(SYSTEM_FOLDER_LABEL_KEYS[systemId]) : folder.name
  const hasChildren = node.children.length > 0
  const open = actions.expanded.has(folder.id)
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
      <div className="group flex min-h-8 items-center gap-0.5 pr-0.5" style={{ paddingLeft: treeIndent(node.depth) }}>
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

export function FolderSidebarRail({
  folders,
  activeFolderId,
  onSelect,
  onExpand,
  footer,
}: {
  folders: readonly EmailFolder[]
  activeFolderId: string | null
  onSelect: (folderId: string) => void
  onExpand: () => void
  footer?: ReactNode
}) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  return (
    <nav aria-label={t('email.a11y.folders')} className="flex h-full min-h-0 w-full flex-col items-center gap-1 overflow-y-auto bg-[var(--bg-sunken)] py-2">
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
