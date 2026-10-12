/**
 * Character offsets into a chapter's prose.
 *
 * A highlight has to survive the next time the book is opened, and the only thing that is stable
 * across a re-render is the text itself: element identity, layout and column count all change with the
 * font, the window and the theme. So a position in a flowing book is "chapter N, character M", and
 * this module is the bidirectional map between those numbers and the text nodes the DOM actually
 * holds.
 *
 * The index is built once per rendered chapter and thrown away with it.
 */
export interface TextIndex {
  /** Text nodes in document order, with the ones that hold nothing skipped. */
  nodes: Text[]
  /** Where each node's text begins in `text`, same order as `nodes`. */
  starts: number[]
  /** The chapter's whole visible text, which is what a stored offset indexes into. */
  text: string
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TITLE'])

export function buildTextIndex(root: Node): TextIndex {
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      if (!node.nodeValue?.length) return NodeFilter.FILTER_REJECT
      if (parent?.closest('script,style,noscript')) return NodeFilter.FILTER_REJECT
      if (parent?.classList.contains('reader-mark-gutter')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node as Text
    if (SKIP_TAGS.has(element.parentElement?.tagName ?? '')) continue
    nodes.push(element)
    starts.push(text.length)
    text += element.nodeValue ?? ''
  }
  return { nodes, starts, text }
}

/**
 * The chapter offset of a DOM point, or -1 when the point is not in this index.
 *
 * A selection that straddles an existing highlight still lands on text nodes the index holds, because
 * splitting a node into segments preserves the concatenation: the caller rebuilds the index after
 * painting marks and the numbers keep meaning the same thing.
 */
export function offsetForPoint(index: TextIndex, node: Node, offset: number): number {
  const at = index.nodes.indexOf(node as Text)
  if (at < 0) return -1
  return index.starts[at]! + Math.min(offset, (index.nodes[at]!.nodeValue ?? '').length)
}

export interface TextPoint {
  node: Text
  offset: number
}

/** The DOM point for a chapter offset. The end of the chapter maps into the last node, not past it. */
export function pointForOffset(index: TextIndex, offset: number): TextPoint | null {
  if (!index.nodes.length) return null
  const clamped = Math.max(0, Math.min(offset, index.text.length))
  let low = 0
  let high = index.starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (index.starts[middle]! <= clamped) low = middle
    else high = middle - 1
  }
  const node = index.nodes[low]!
  const within = clamped - index.starts[low]!
  return { node, offset: Math.min(within, (node.nodeValue ?? '').length) }
}

export function sliceText(index: TextIndex, from: number, to: number): string {
  return index.text.slice(Math.max(0, from), Math.max(0, to))
}

/** The element a point sits in, which is what a page turn has to scroll to. */
export function elementForOffset(index: TextIndex, offset: number): Element | null {
  const point = pointForOffset(index, offset)
  if (!point) return null
  const parent = point.node.parentElement
  if (!parent) return null
  return parent.closest('[id]') ?? parent
}
