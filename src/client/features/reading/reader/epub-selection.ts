import { anchorFrom } from '../engine/highlight-anchor'
import { offsetForPoint, type TextIndex } from '../engine/text-index'

export interface StageSelection {
  start: number
  end: number
  text: string
  rect: DOMRect
  prefix?: string
  suffix?: string
  chapter?: number
}

export function readEpubSelection(doc: HTMLElement, index: TextIndex): StageSelection | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!doc.contains(range.startContainer) || !doc.contains(range.endContainer)) return null
  const start = offsetForPoint(index, range.startContainer, range.startOffset)
  const end = offsetForPoint(index, range.endContainer, range.endOffset)
  if (start < 0 || end < 0 || end <= start) return null
  const text = selection.toString()
  if (!text.trim()) return null
  const anchor = anchorFrom(index, start, end)
  return { start, end, text, rect: range.getBoundingClientRect(), prefix: anchor.prefix, suffix: anchor.suffix }
}
