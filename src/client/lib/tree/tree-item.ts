export interface TreeItemOptions {
  /** 1-based depth, the way `aria-level` counts. */
  level: number
  /** Omitted on a leaf; a branch states whether it is open. */
  expanded?: boolean
  selected?: boolean
  /** The size and 1-based position among the row's siblings, when the tree can tell. */
  setSize?: number
  posInSet?: number
}

export interface TreeItemAria {
  role: 'treeitem'
  'aria-level': number
  'aria-expanded'?: boolean
  'aria-selected'?: boolean
  'aria-setsize'?: number
  'aria-posinset'?: number
}

/**
 * The ARIA a tree row carries, so every tree exposes the same structure to a screen reader instead
 * of each one remembering a different subset. Spread it onto the element that wraps a row and its
 * `role="group"` children; `undefined` fields are dropped rather than rendered as `aria-x="undefined"`.
 */
export function treeItemProps({ level, expanded, selected, setSize, posInSet }: TreeItemOptions): TreeItemAria {
  return {
    role: 'treeitem',
    'aria-level': level,
    ...(expanded === undefined ? {} : { 'aria-expanded': expanded }),
    ...(selected === undefined ? {} : { 'aria-selected': selected }),
    ...(setSize === undefined ? {} : { 'aria-setsize': setSize }),
    ...(posInSet === undefined ? {} : { 'aria-posinset': posInSet }),
  }
}
