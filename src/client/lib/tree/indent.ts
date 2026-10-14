/**
 * The one source of truth for how far a tree row steps in per depth level.
 *
 * The sidebar folders, the tag tree, the stencil library and the move picker all draw the same row
 * geometry, so the step lives here rather than being re-derived as `6 + depth * 13` — and the four
 * other constants that grew beside it (`4 + depth * 13`, `6 + depth * 14`, `4 + depth * 12`). Rows
 * apply it as an inline `paddingLeft`, which is the runtime-value case the style rule allows.
 */
export const TREE_INDENT_BASE = 6
export const TREE_INDENT_STEP = 13

export function treeIndent(depth: number): number {
  return TREE_INDENT_BASE + depth * TREE_INDENT_STEP
}
