import { Z_INDEX } from '../../../lib/z-index'
import { Menu } from '../../../components/overlay'
import { ContextMenuToolbar, toolbarSearchActions, toolbarState } from './toolbar'
import { useContextMenuState, type EditorContextMenuProps } from './use-context-menu'

const MENU_WIDTH = 232

/**
 * The note's context menu.
 *
 * One component for every block kind: the rows come from `useContextMenuState`, which asks the kind's
 * own builder and then the note-wide ones. The header strip and the filter box are the parts that
 * belong to no kind, which is why they are attached here rather than repeated in each builder.
 */
export function EditorContextMenu(props: EditorContextMenuProps) {
  const { point, onClose, showToolbar, searchable } = props
  const { ctx, items, toolbarCopy } = useContextMenuState(props)
  if (!point || items.length === 0) return null
  const toolbar = toolbarState(ctx, toolbarCopy, onClose)
  return (
    <Menu
      anchor={point}
      open
      onClose={onClose}
      items={items}
      width={MENU_WIDTH}
      zIndex={Z_INDEX.hoverPinned}
      header={showToolbar ? <ContextMenuToolbar {...toolbar} /> : undefined}
      searchable={searchable}
      searchActions={searchable ? toolbarSearchActions(toolbar) : undefined}
    />
  )
}
