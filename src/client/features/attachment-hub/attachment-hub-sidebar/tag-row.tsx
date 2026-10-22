import { useRef, useState } from 'react'
import { ChevronRight, Hash, MoreHorizontal, Palette, Pin, Trash2 } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { treeIndent } from '../../../lib/tree/indent'
import type { TagTreeNode } from '../../../lib/tag-tree'
import { Menu, useContextMenu, type MenuItem } from '../../../components/overlay'
import { TagColorMenu } from '../../tags/TagAppearanceMenus'
import type { HubOrganizerState } from '../attachment-store'

export interface HubTagRowProps {
  node: TagTreeNode
  selectedTag: string | null
  expandedTagPaths: Set<string>
  onToggleExpand: (fullPath: string) => void
  onSelectTag: (tag: string | null) => void
  patchTag: HubOrganizerState['patchTag']
  deleteTag: HubOrganizerState['deleteTag']
}

function buildTagMenuItems(props: HubTagRowProps): MenuItem[] {
  const { node, patchTag, deleteTag } = props
  const tag = node.tag
  const items: MenuItem[] = []
  if (tag && !node.isVirtual) {
    items.push({
      id: 'pin',
      label: t(tag.isPinned ? 'tags.unpin' : 'tags.pin'),
      icon: <Pin size={13} />,
      onSelect: () => void patchTag(tag.id, { isPinned: !tag.isPinned }),
    })
    items.push({
      id: 'color',
      label: t('tags.color'),
      icon: <Palette size={13} />,
      submenu: ({ closeMenu }) => (
        <TagColorMenu
          color={tag.color}
          onSelectColor={(color) => {
            void patchTag(tag.id, { color })
            closeMenu()
          }}
        />
      ),
    })
    items.push({
      id: 'delete',
      label: t('tags.delete'),
      icon: <Trash2 size={13} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => void deleteTag(tag.id),
    })
  }
  return items
}

export function HubTagRow(props: HubTagRowProps) {
  const { node, selectedTag, expandedTagPaths } = props
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const contextMenu = useContextMenu()

  const expanded = expandedTagPaths.has(node.fullPath)
  const hasChildren = node.children.length > 0
  const menuItems = buildTagMenuItems(props)

  return (
    <div>
      <div
        onContextMenu={(e) => {
          setIsMenuOpen(false)
          contextMenu.onContextMenu(e)
        }}
        style={{ paddingLeft: `${treeIndent(node.depth)}px` }}
        className={cn(
          'group flex h-8 w-full items-center gap-[var(--sp-1)] rounded-[var(--r-md)] pr-[var(--sp-1)] text-left text-[length:var(--text-12)] font-medium transition-colors',
          selectedTag === node.fullPath
            ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        )}
      >
        <button
          type='button'
          aria-expanded={expanded}
          aria-label={t(expanded ? 'sidebar.collapse' : 'sidebar.expand')}
          onClick={(e) => {
            e.stopPropagation()
            props.onToggleExpand(node.fullPath)
          }}
          className={cn(
            'flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-tertiary)] transition-transform',
            !hasChildren && 'invisible',
            expanded && 'rotate-90',
          )}
        >
          <ChevronRight size={11} />
        </button>

        <button
          type='button'
          onClick={() => props.onSelectTag(node.fullPath)}
          className='flex min-w-0 flex-1 cursor-pointer items-center gap-[var(--sp-1-5)] py-[var(--sp-1)] text-left'
        >
          <Hash size={12} style={{ color: node.tag?.color ?? undefined }} className={cn('shrink-0', !node.tag?.color && 'text-[var(--text-quaternary)]')} />
          <span className='truncate'>{node.name}</span>
        </button>

        {menuItems.length > 0 && (
          <button
            ref={moreButtonRef}
            type='button'
            aria-label={t('common.more_actions')}
            onClick={(e) => {
              e.stopPropagation()
              setIsMenuOpen((prev) => !prev)
            }}
            className='cursor-pointer rounded p-[var(--sp-0-5)] text-[var(--text-quaternary)] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[var(--bg-sunken)] hover:text-[var(--text-primary)]'
          >
            <MoreHorizontal size={12} />
          </button>
        )}
      </div>

      <Menu open={isMenuOpen} anchor={moreButtonRef} items={menuItems} onClose={() => setIsMenuOpen(false)} />
      {contextMenu.point && <Menu open anchor={contextMenu.point} items={menuItems} onClose={contextMenu.close} />}
    </div>
  )
}
