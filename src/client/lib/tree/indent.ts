/**
 * The one source of truth for how far a tree row steps in per depth level.
 *
 * The sidebar folders, the tag tree, the calendar/todo and inbox trees and the move picker all draw
 * the same row geometry, so the base and the step live here and a row calls `treeIndent(depth)`
 * instead of re-deriving `base + depth * step` inline. Rows apply the result as an inline
 * `paddingLeft`, which is the runtime-value case the style rule allows.
 *
 * This is the contract to converge on, not a claim that it already holds everywhere: a few rows — a
 * chat taxonomy list and the like — still hand-write their own `n + depth * m` and will drift from
 * these constants until they call `treeIndent`. Until they do, this module defines the step; it does
 * not prove that nothing else computes one.
 */
export const TREE_INDENT_BASE = 6
export const TREE_INDENT_STEP = 13

export function treeIndent(depth: number): number {
  return TREE_INDENT_BASE + depth * TREE_INDENT_STEP
}
