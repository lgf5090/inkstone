/**
 * The one source of truth for how far a tree row steps in per depth level.
 *
 * The sidebar folders, the tag tree, the calendar/todo and inbox trees, the move picker, the stencil
 * library, the RSS rail, the chat taxonomy, the quickadd choices and the reader's contents list all
 * draw the same row geometry, so the base and the step live here and a row calls `treeIndent(depth)`
 * instead of re-deriving `base + depth * step` inline. Rows apply the result as an inline
 * `paddingLeft`, which is the runtime-value case the style rule allows.
 *
 * Two nested renderers indent another way on purpose and are not drift: the JSON tree nests with CSS
 * (`.jt-children` in `styles/prose.css`) because its rows are built as DOM strings rather than by a
 * React row, and a dataview `GROUP BY` nests as ordinary list items because it is a list, not a
 * navigator. A new row that *is* a navigator calls this function.
 */
export const TREE_INDENT_BASE = 6
export const TREE_INDENT_STEP = 13

export function treeIndent(depth: number): number {
  return TREE_INDENT_BASE + depth * TREE_INDENT_STEP
}
