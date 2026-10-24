import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { ChevronRight, ChevronsUpDown, CornerDownRight, MoreHorizontal, Palette, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import type { EmailTag } from '@shared/email/model'
import { emailTagAncestorPaths, emailTagLeafName, isValidEmailTagPath, normalizeEmailTagPath } from '@shared/email/tags'
import type { Tag } from '@shared/types'
import { cn } from '../../lib/cn'
import { useDropState } from '../../lib/drop-state'
import { buildTagTree, childTagPath, collectParentPaths, renameTagSegment, searchTagTree, type TagTreeNode } from '../../lib/tag-tree'
import { compileQuery } from '../../lib/query-match'
import { usePinyinVersion } from '../../lib/pinyin'
import { treeIndent, treeItemProps, useExpandedSet, useTreeKeyboard } from '../../lib/tree'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { FilterInput } from '../../components/FilterInput'
import { TagPill } from '../../components/TagChip'
import { Menu, Tooltip, confirm, prompt, useContextMenu, type MenuItem } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { TagColorMenu } from '../tags/TagAppearanceMenus'
import { dragLeftTarget, hasEmailDrag, readEmailDrag } from './email-drag'
import { createEmailTag, deleteEmailTag, reportEmailFailure, updateEmailTag } from './email-org'
import type { EmailLoadStatus } from './store'

const TAG_MENU_WIDTH = 184

function tagRecord(tag: EmailTag): Tag {
  return { id: tag.id, name: tag.name, color: tag.color, count: tag.count, createdAt: 0 }
}

function sameTagPath(a: string | null, b: string): boolean {
  if (!a) return false
  return normalizeEmailTagPath(a).toLowerCase() === normalizeEmailTagPath(b).toLowerCase()
}

export function EmailTagSidebar({
  accountId,
  tags,
  status,
  error,
  activeTagName,
  onSelect,
  onReload,
  onDropMessages,
}: {
  accountId: string
  tags: readonly EmailTag[]
  status: EmailLoadStatus
  error: string | null
  activeTagName: string | null
  onSelect: (name: string) => void
  onReload: () => Promise<void>
  onDropMessages: (tag: EmailTag, emailIds: string[]) => void
}) {
  const { expanded, setMany, setExpanded, toggle } = useExpandedSet()
  const [query, setQuery] = useState('')
  const pinyinVersion = usePinyinVersion()
  const compiled = useMemo(() => compileQuery(query), [query])
  const tree = useMemo(() => buildTagTree(tags.map(tagRecord)), [tags])
  const searched = useMemo(() => searchTagTree(tree, compiled), [tree, compiled, pinyinVersion])
  const searching = Boolean(query.trim()) && !compiled.error
  const shownTree = searching ? searched.nodes : tree
  const parentPaths = useMemo(() => collectParentPaths(shownTree), [shownTree])
  const allExpanded = parentPaths.length > 0 && parentPaths.every((path) => expanded.has(path))

  useEffect(() => {
    if (!activeTagName) return
    const ancestors = emailTagAncestorPaths(activeTagName)
    if (ancestors.length) setMany(ancestors, true)
  }, [activeTagName, setMany])

  const createUnder = async (parentPath: string | null): Promise<void> => {
    const name = await prompt({
      title: parentPath ? t('email.tag.new_child') : t('email.tag.new_title'),
      description: parentPath
        ? t('email.tag.new_child_hint', { name: parentPath })
        : t('email.tag.new_hint'),
      placeholder: t('email.tag.name_placeholder'),
      confirmLabel: t('email.tag.create'),
    })
    if (name === null) return
    const trimmed = name.trim()
    if (!trimmed) return
    const path = parentPath ? childTagPath(parentPath, trimmed) : normalizeEmailTagPath(trimmed)
    if (!isValidEmailTagPath(path)) {
      useUi.getState().toast({ title: t('email.toast.failed'), description: t('email.tag.invalid'), tone: 'danger' })
      return
    }
    try {
      await createEmailTag(accountId, { name: path })
      if (parentPath) setMany([parentPath], true)
    } catch (reason) {
      reportEmailFailure(reason)
    }
  }

  const rename = async (tag: EmailTag): Promise<void> => {
    const name = await prompt({
      title: t('email.tag.rename_title', { name: tag.name }),
      placeholder: t('email.tag.name_placeholder'),
      defaultValue: emailTagLeafName(tag.name),
      confirmLabel: t('email.tag.rename'),
    })
    if (name === null) return
    const next = renameTagSegment(tag.name, name)
    if (next === tag.name) return
    if (!isValidEmailTagPath(next)) {
      useUi.getState().toast({ title: t('email.toast.failed'), description: t('email.tag.invalid'), tone: 'danger' })
      return
    }
    try {
      await updateEmailTag(accountId, tag.id, { name: next })
    } catch (reason) {
      reportEmailFailure(reason)
    }
  }

  const setColor = async (tag: EmailTag, color: string | null): Promise<void> => {
    try {
      await updateEmailTag(accountId, tag.id, { color })
    } catch (reason) {
      reportEmailFailure(reason)
    }
  }

  const remove = async (tag: EmailTag): Promise<void> => {
    const ok = await confirm({
      title: t('email.tag.delete_title', { name: tag.name }),
      description: t('email.tag.delete_hint'),
      confirmLabel: t('email.tag.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await deleteEmailTag(accountId, tag.id)
    } catch (reason) {
      reportEmailFailure(reason)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between gap-1 px-2">
        <Tooltip label={allExpanded ? t('email.tag.collapse_all') : t('email.tag.expand_all')} side="bottom">
          <IconButton
            label={allExpanded ? t('email.tag.collapse_all') : t('email.tag.expand_all')}
            size="xs"
            disabled={parentPaths.length === 0}
            onClick={() => setExpanded(allExpanded ? new Set() : new Set(parentPaths))}
          >
            <ChevronsUpDown size={13} className={cn('transition-transform', allExpanded && 'rotate-180')} />
          </IconButton>
        </Tooltip>
        <IconButton label={t('email.tag.new')} size="xs" onClick={() => { void createUnder(null) }}>
          <Plus size={13} />
        </IconButton>
      </div>
      <div className="shrink-0 px-2 pb-1">
        <FilterInput value={query} onChange={setQuery} query={compiled} label={t('email.tag.section')} placeholder={t('email.sidebar.filter_tags')} className="mt-0" />
      </div>
      <nav aria-label={t('email.a11y.tags')} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
        {status === 'loading' && tags.length === 0 && (
          <p role="status" className="flex items-center gap-1.5 px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            <Spinner size={11} />
            {t('email.tag.loading')}
          </p>
        )}
        {status === 'error' && (
          <div role="alert" className="flex flex-col gap-1 rounded-[var(--r-md)] px-2 py-1">
            <span className="min-w-0 break-words text-[length:var(--text-11)] text-[var(--danger)]">
              {error ?? t('email.tag.error')}
            </span>
            <Button size="sm" variant="ghost" className="self-start" onClick={() => { void onReload() }}>
              {t('common.retry')}
            </Button>
          </div>
        )}
        {status === 'ready' && tags.length === 0 && (
          <p className="px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('email.tag.empty')}</p>
        )}
        {searching && shownTree.length === 0 && (
          <p className="px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('email.sidebar.no_matches')}</p>
        )}
        {shownTree.length > 0 && (
          <div role="tree" aria-label={t('email.a11y.tags')} className="flex flex-col gap-0.5">
            {shownTree.map((node, index) => (
              <TagBranch
                key={node.fullPath}
                node={node}
                setSize={shownTree.length}
                posInSet={index + 1}
                activeTagName={activeTagName}
                expanded={expanded}
                forceOpen={searching}
                onToggle={toggle}
                onCreateChild={(path) => { void createUnder(path) }}
                onRename={(tag) => { void rename(tag) }}
                onColor={(tag, color) => { void setColor(tag, color) }}
                onDelete={(tag) => { void remove(tag) }}
                onFilter={onSelect}
                onDropMessages={onDropMessages}
              />
            ))}
          </div>
        )}
      </nav>
    </div>
  )
}

function TagBranch({
  node,
  setSize,
  posInSet,
  activeTagName,
  expanded,
  forceOpen = false,
  onToggle,
  onCreateChild,
  onRename,
  onColor,
  onDelete,
  onFilter,
  onDropMessages,
}: {
  node: TagTreeNode
  setSize: number
  posInSet: number
  activeTagName: string | null
  expanded: ReadonlySet<string>
  forceOpen?: boolean
  onToggle: (path: string) => void
  onCreateChild: (path: string) => void
  onRename: (tag: EmailTag) => void
  onColor: (tag: EmailTag, color: string | null) => void
  onDelete: (tag: EmailTag) => void
  onFilter: (path: string) => void
  onDropMessages: (tag: EmailTag, emailIds: string[]) => void
}) {
  const menu = useContextMenu()
  const moreRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [dropping, setDropping] = useDropState(false)
  const treeKeyDown = useTreeKeyboard()
  const hasChildren = node.children.length > 0
  const open = forceOpen || expanded.has(node.fullPath)
  const active = sameTagPath(activeTagName, node.fullPath)
  const tag = node.tag
  const count = node.isVirtual ? node.totalCount : node.count
  const childrenId = `email-tag-children-${encodeURIComponent(node.fullPath)}`
  const acceptsDrop = !node.isVirtual
  const dragOver = (event: ReactDragEvent<HTMLButtonElement>): void => {
    if (!acceptsDrop || !hasEmailDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropping(true)
  }
  const dragLeave = (event: ReactDragEvent<HTMLButtonElement>): void => {
    if (dragLeftTarget(event.currentTarget, event.relatedTarget)) setDropping(false)
  }
  const drop = (event: ReactDragEvent<HTMLButtonElement>): void => {
    if (!acceptsDrop) return
    const emailIds = readEmailDrag(event.dataTransfer)
    if (emailIds.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    setDropping(false)
    onDropMessages(tag, emailIds)
  }
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
  const items: MenuItem[] = node.isVirtual
    ? [
        { id: 'new-child', label: t('email.tag.new_child'), icon: <CornerDownRight size={13} />, onSelect: () => onCreateChild(node.fullPath) },
      ]
    : [
        { id: 'new-child', label: t('email.tag.new_child'), icon: <CornerDownRight size={13} />, onSelect: () => onCreateChild(node.fullPath) },
        { id: 'rename', label: t('email.tag.rename'), icon: <Pencil size={13} />, onSelect: () => onRename(tag) },
        {
          id: 'color',
          label: t('tags.color'),
          icon: <Palette size={13} />,
          submenu: ({ closeMenu }) => (
            <TagColorMenu
              color={tag.color}
              onSelectColor={(color) => {
                onColor(tag, color)
                closeMenu()
              }}
            />
          ),
        },
        { id: 'filter', label: t('email.tag.filter'), icon: <Search size={13} />, onSelect: () => onFilter(node.fullPath) },
        { id: 'delete', label: t('email.tag.delete'), icon: <Trash2 size={13} />, tone: 'danger', separatorBefore: true, onSelect: () => onDelete(tag) },
      ]
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
            aria-label={t(open ? 'email.tag.collapse' : 'email.tag.expand', { name: node.fullPath })}
            onClick={() => onToggle(node.fullPath)}
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
          data-email-tag-row={node.isVirtual ? undefined : tag.id}
          onKeyDown={treeKeyDown}
          onDragOver={dragOver}
          onDragLeave={dragLeave}
          onDrop={drop}
          aria-current={active ? 'page' : undefined}
          aria-label={node.isVirtual
            ? t('email.tag.expand', { name: node.fullPath })
            : `${t('email.tag.filter')}: ${node.fullPath}`}
          onClick={() => {
            if (node.isVirtual) onToggle(node.fullPath)
            else onFilter(node.fullPath)
          }}
          className={cn(
            'flex min-w-0 flex-1 items-center rounded-[var(--r-md)] py-0.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
            dropping && 'ring-1 ring-[var(--accent)]',
          )}
        >
          <TagPill
            label={node.name}
            color={tag.color}
            pressed={active}
            className="max-w-full"
            trailing={count > 0
              ? <span className="tabular shrink-0 text-[length:var(--text-10)] text-[color:var(--text-quaternary)]">{count}</span>
              : undefined}
          />
        </button>
        <IconButton
          label={t('email.tag.more', { name: node.fullPath })}
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
          <TagBranch
            key={child.fullPath}
            node={child}
            setSize={node.children.length}
            posInSet={index + 1}
            activeTagName={activeTagName}
            expanded={expanded}
            forceOpen={forceOpen}
            onToggle={onToggle}
            onCreateChild={onCreateChild}
            onRename={onRename}
            onColor={onColor}
            onDelete={onDelete}
            onFilter={onFilter}
            onDropMessages={onDropMessages}
          />
        ))}
      </div>
      <Menu anchor={moreRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} width={TAG_MENU_WIDTH} label={t('email.tag.more_actions')} />
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items} width={TAG_MENU_WIDTH} label={t('email.tag.more_actions')} />}
    </div>
  )
}
