import {
  applyBodyAtFence,
  applyFencePatchAtSource,
  fenceAt,
  fenceRange,
  joinLines,
  replaceFenceWithText,
  splitLines,
} from '../../../lib/markdown/fence-edit'
import type { MenuCtx } from './types'

/**
 * The door every block menu writes through.
 *
 * A fenced block is edited by patching the note's text, never the DOM or the editor buffer: the same
 * `applyFencePatchAtSource` the block toolbars use, so a menu and a toolbar on one block cannot
 * disagree about where the fence is or widen its markers differently. Both the source pane and the
 * preview take this route, which is also why an edit made after the note changed underneath the render
 * is refused rather than applied to whatever line moved into place.
 */

/** Empty, so any language's fence is a candidate: the caller already knows which block it means. */
const ANY_FENCE: readonly string[] = []

/** The block the menu is pointing at, as the note holds it right now. */
export function currentFence(ctx: MenuCtx): { line: number; info: string; body: string } | null {
  const fence = ctx.editor?.fence ?? ctx.preview?.fence
  const line = fence?.line ?? ctx.preview?.line
  if (!fence || line === undefined) return null
  const read = fenceAt(ctx.content, line, ANY_FENCE)
  if (!read) return null
  return { line, info: read.info, body: read.body }
}

/**
 * Rewrite a block's info string, its body, or both in one edit. Returns false, having written nothing,
 * when the note no longer holds the body the menu was built from.
 */
export function patchFence(ctx: MenuCtx, patch: { info?: string; body?: string }): boolean {
  const at = currentFence(ctx)
  if (!at) return false
  const next = applyFencePatchAtSource(ctx.content, { line: at.line, body: at.body }, patch, ANY_FENCE)
  if (next === null) return false
  ctx.onEditContent(next)
  return true
}

/** Replace only the body, leaving the info string and the marker run exactly as written. */
export function replaceFenceBody(ctx: MenuCtx, body: string): boolean {
  const at = currentFence(ctx)
  if (!at) return false
  const next = applyBodyAtFence(ctx.content, { line: at.line, body: at.body }, body, ANY_FENCE)
  if (next === null) return false
  ctx.onEditContent(next)
  return true
}

/** Drop the whole block, fences included. */
export function removeFence(ctx: MenuCtx): boolean {
  const at = currentFence(ctx)
  if (!at) return false
  const next = replaceFenceWithText(ctx.content, { line: at.line, body: at.body }, '', ANY_FENCE)
  if (next === null) return false
  ctx.onEditContent(next)
  return true
}

/** The block as the note has it, opening marker line through closing marker line. */
export function fenceSource(ctx: MenuCtx): string {
  const at = currentFence(ctx)
  if (!at) return ''
  const span = fenceRange(ctx.content, { line: at.line, body: at.body }, ANY_FENCE)
  if (!span) return ''
  const { lines, eol } = splitLines(ctx.content)
  return joinLines(lines.slice(span.start, span.end), eol, false)
}
