import { useState, useRef, type MouseEvent, type DragEvent } from 'react'
import {
  ChevronRight,
  Download,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react'
import type { PasswordGroup } from '@shared/tools/password/types'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { Badge, IconButton } from '../../../components/primitives'
import { Menu, useContextMenu, Tooltip, type MenuItem } from '../../../components/overlay'

export const MAX_GROUP_TREE_DEPTH = 7

export interface GroupTreeNodeProps {
  group: PasswordGroup
  depth: number
  selectedGroupId: string | null
  expandedIds: Set<string>
  accountCountMap: Record<string, number>
  onSelect: (group: PasswordGroup) => void
  onToggleExpand: (groupId: string) => void
  onNewChild: (parent: PasswordGroup) => void
  onRename: (group: PasswordGroup) => void
  onDelete: (group: PasswordGroup) => void
  onExport: (group: PasswordGroup) => void
  onImport: (group: PasswordGroup) => void
  onMoveGroup: (draggedGroupId: string, targetParentId: string) => void
  onMoveAccount: (accountId: string, targetGroupId: string) => void
}

export function GroupTreeNode({
  group,
  depth,
  selectedGroupId,
  expandedIds,
  accountCountMap,
  onSelect,
  onToggleExpand,
  onNewChild,
  onRename,
  onDelete,
  onExport,
  onImport,
  onMoveGroup,
  onMoveAccount,
}: GroupTreeNodeProps) {
  const isSelected = selectedGroupId === group.id
  const hasChildren = Boolean(group.childs && group.childs.length > 0)
  const isExpanded = expandedIds.has(group.id)
  const accountCount = accountCountMap[group.id] || 0
  const canHaveChildren = depth < MAX_GROUP_TREE_DEPTH

  const [isDragOver, setIsDragOver] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const moreBtnRef = useRef<HTMLButtonElement>(null)
  const contextMenu = useContextMenu()

  const handleDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.dataTransfer.setData('text/inkstone-password-group-id', group.id)
    e.dataTransfer.setData(
      'application/json',
      JSON.stringify({ type: 'password-group', id: group.id }),
    )
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (!isDragOver) setIsDragOver(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    // 1. Account drag dropped onto this group
    const accountId = e.dataTransfer.getData('text/inkstone-password-account-id')
    if (accountId) {
      onMoveAccount(accountId, group.id)
      return
    }

    // 2. Group drag dropped onto this group
    const draggedGroupId = e.dataTransfer.getData('text/inkstone-password-group-id')
    if (draggedGroupId && draggedGroupId !== group.id) {
      onMoveGroup(draggedGroupId, group.id)
    }
  }

  const menuItems: MenuItem[] = [
    ...(canHaveChildren
      ? [
          {
            id: 'new-child',
            label: t('tools.password.group.new_child'),
            icon: <Plus size={14} />,
            onSelect: () => onNewChild(group),
          },
        ]
      : []),
    {
      id: 'rename',
      label: t('tools.password.group.rename'),
      icon: <Pencil size={14} />,
      onSelect: () => onRename(group),
    },
    {
      id: 'export',
      label: t('tools.password.group.export'),
      icon: <Download size={14} />,
      onSelect: () => onExport(group),
    },
    {
      id: 'import',
      label: t('tools.password.group.import'),
      icon: <Upload size={14} />,
      onSelect: () => onImport(group),
    },
    {
      id: 'delete',
      label: t('tools.password.group.delete'),
      icon: <Trash2 size={14} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => onDelete(group),
    },
  ]

  const indentPx = (depth - 1) * 12 + 6

  return (
    <div
      data-testid={`group-tree-node-${group.id}`}
      data-depth={depth}
      className="select-none"
    >
      <div
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onContextMenu={(e: MouseEvent<HTMLDivElement>) => {
          setMoreMenuOpen(false)
          contextMenu.onContextMenu(e)
        }}
        style={{ paddingLeft: `${indentPx}px` }}
        className={cn(
          'group relative flex h-8 items-center gap-1.5 rounded-[var(--r-sm)] pr-1.5 text-[length:var(--text-13)]',
          'transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
          isSelected
            ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
          isDragOver && 'bg-[var(--accent-softer,rgba(59,130,246,0.15))] ring-1 ring-[var(--accent)]',
        )}
      >
        {/* Expand / Collapse Toggle Arrow. A leaf keeps the space it would have taken, so the icons of a
            branch and its children still line up. */}
        <button
          type="button"
          aria-label={isExpanded ? t('tools.password.group.collapse') : t('tools.password.group.expand')}
          data-testid="group-toggle"
          disabled={!hasChildren}
          onClick={() => {
            onToggleExpand(group.id)
          }}
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-[var(--r-xs)] text-[var(--text-tertiary)]',
            'transition-transform duration-[var(--dur-fast)]',
            !hasChildren && 'invisible',
            hasChildren && isExpanded && 'rotate-90 text-[var(--text-primary)]',
            hasChildren && 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
          )}
        >
          <ChevronRight size={13} />
        </button>

        {/* Selecting the group is a press on the row, so the row is a button and its controls are
            siblings: a `div` that selected on click and held three buttons was mouse-only. */}
        <button
          type="button"
          data-testid="group-row"
          aria-current={isSelected ? 'true' : undefined}
          onClick={() => onSelect(group)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
        >
          {/* Folder Icon */}
          <span className="shrink-0 text-[var(--text-tertiary)]">
            {hasChildren && isExpanded ? <FolderOpen size={15} /> : <Folder size={15} />}
          </span>

          {/* Group Name */}
          <span
            data-testid="group-name"
            className="min-w-0 flex-1 truncate text-left"
            title={group.name}
          >
            {group.name}
          </span>

          {/* Account Count Badge */}
          {accountCount > 0 && (
            <Badge
              tone={isSelected ? 'accent' : 'neutral'}
              className="shrink-0 group-hover:hidden"
            >
              {accountCount}
            </Badge>
          )}
        </button>

        {/* Hover Action Buttons. No click handler: the row beside it is the press target now, so a tap
            on a control cannot also select the group. */}
        <div
          data-testid="group-hover-actions"
          className="hidden shrink-0 items-center gap-0.5 group-hover:flex"
        >
          {canHaveChildren && (
            <Tooltip label={t('tools.password.group.new_child')} side="top">
              <IconButton
                data-testid="group-new-child-btn"
                label={t('tools.password.group.new_child')}
                size="sm"
                onClick={() => onNewChild(group)}
              >
                <Plus size={13} />
              </IconButton>
            </Tooltip>
          )}

          <Tooltip label={t('tools.password.common.more_actions')} side="top">
            <button
              ref={moreBtnRef}
              data-testid="group-more-btn"
              type="button"
              aria-label={t('tools.password.common.more_actions')}
              onClick={() => setMoreMenuOpen(true)}
              className="flex size-6 items-center justify-center rounded-[var(--r-xs)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <MoreHorizontal size={13} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Menu for "More Actions" button */}
      <Menu
        anchor={moreBtnRef}
        open={moreMenuOpen}
        onClose={() => setMoreMenuOpen(false)}
        items={menuItems}
      />

      {/* Right Click Context Menu */}
      {contextMenu.point && (
        <Menu
          anchor={contextMenu.point}
          open
          onClose={contextMenu.close}
          items={menuItems}
        />
      )}

      {/* Render Child Groups Recursively */}
      {hasChildren && isExpanded && (
        <div className="space-y-0.5">
          {group.childs!.map((child) => (
            <GroupTreeNode
              key={child.id}
              group={child}
              depth={depth + 1}
              selectedGroupId={selectedGroupId}
              expandedIds={expandedIds}
              accountCountMap={accountCountMap}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
              onNewChild={onNewChild}
              onRename={onRename}
              onDelete={onDelete}
              onExport={onExport}
              onImport={onImport}
              onMoveGroup={onMoveGroup}
              onMoveAccount={onMoveAccount}
            />
          ))}
        </div>
      )}
    </div>
  )
}
