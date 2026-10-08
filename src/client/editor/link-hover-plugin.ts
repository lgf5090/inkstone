import { Facet } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { decodeDataValue, encodeDataValue } from '../lib/markdown/data-attr'

const WIKI_TEXT_RE = /^\[\[([\s\S]+)\]\]$/
const TAG_TEXT_RE = /^#([\p{L}\p{N}_\-/·]{1,60})$/u
const HOVER_SELECTOR = '.cm-md-wikilink, [data-wikilink], .cm-md-tag, [data-tag], .cm-md-link, [data-mdlink], a[href], img[src]'

interface LinkHoverCallbacks {
  propose: (link: HTMLElement | null, options?: { immediate?: boolean }) => void
  hide: () => boolean
}

export const linkHoverFacet = Facet.define<LinkHoverCallbacks>()

export function linkHoverExtension() {
  return ViewPlugin.fromClass(LinkHoverPlugin)
}

class LinkHoverPlugin {
  hovered: HTMLElement | null = null
  caretMark: HTMLElement | null = null
  lastProposed: HTMLElement | null = null
  view: EditorView

  constructor(view: EditorView) {
    this.view = view
    view.contentDOM.addEventListener('mousemove', this.move)
    view.contentDOM.addEventListener('mouseleave', this.leave)
    view.contentDOM.addEventListener('keydown', this.keydown)
    view.contentDOM.addEventListener('focus', this.keyboardCheck)
  }

  destroy() {
    this.view.contentDOM.removeEventListener('mousemove', this.move)
    this.view.contentDOM.removeEventListener('mouseleave', this.leave)
    this.view.contentDOM.removeEventListener('keydown', this.keydown)
    this.view.contentDOM.removeEventListener('focus', this.keyboardCheck)
  }

  update(update: ViewUpdate) {
    if (update.selectionSet || update.docChanged) this.keyboardCheck()
  }

  keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    const callback = this.view.state.facet(linkHoverFacet)[0]
    if (callback?.hide()) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  move = (event: MouseEvent) => {
    const mark = (event.target as Element).closest<HTMLElement>(HOVER_SELECTOR)
    this.applyHover(mark)
  }

  leave = () => {
    this.applyHover(null)
  }

  keyboardCheck = () => {
    this.view.requestMeasure({
      read: () => {
        const head = this.view.state.selection.main.head
        const coords = this.view.coordsAtPos(head)
        if (!coords) return null
        const point = { x: coords.left, y: coords.top }
        const marks = [...this.view.contentDOM.querySelectorAll<HTMLElement>(HOVER_SELECTOR)]
        return marks.find((candidate) => containsPoint(candidate, point)) ?? null
      },
      write: (mark) => {
        this.caretMark = mark
        this.emit()
      },
    })
  }

  applyHover = (mark: HTMLElement | null) => {
    this.hovered = mark
    this.emit()
  }

  emit = () => {
    const callback = this.view.state.facet(linkHoverFacet)[0]
    const mark = this.hovered ?? caretProposable(this.caretMark)
    if (mark) {
      if (mark === this.lastProposed) return
      const raw = wikiRawOf(mark)
      if (raw != null) mark.dataset.wikilink = encodeDataValue(raw)
      else {
        const tag = tagRawOf(mark)
        // The caret path reads whichever datum the mark just got, so a hashtag has to carry
        // its own; without this the sidebar and preview hover but the editor does not. A link
        // mark already arrived with its destination, so it needs nothing written.
        if (tag == null && !carriesDestination(mark)) return
        if (tag != null) mark.dataset.tag = encodeDataValue(tag)
      }
      this.lastProposed = mark
      callback?.propose(mark, { immediate: this.hovered == null })
    } else if (this.lastProposed !== null) {
      this.lastProposed = null
      callback?.propose(null)
    }
  }
}

function wikiRawOf(mark: HTMLElement): string | null {
  const encoded = mark.dataset.wikilink
  if (encoded !== undefined) return decodeDataValue(encoded) || null
  const match = WIKI_TEXT_RE.exec(mark.textContent ?? '')
  return match ? match[1]!.trim() : null
}

function tagRawOf(mark: HTMLElement): string | null {
  const encoded = mark.dataset.tag
  if (encoded !== undefined) return decodeDataValue(encoded) || null
  const match = TAG_TEXT_RE.exec((mark.textContent ?? '').trim())
  return match ? match[1]!.trim() : null
}

/** Whether the span already states where it goes: a source mark, or a rendered link or picture. */
function carriesDestination(mark: HTMLElement): boolean {
  return mark.dataset.mdlink !== undefined || mark.hasAttribute('href') || mark.hasAttribute('src')
}

// A link mark on the caret path would put a card over the very address the reader is still typing,
// so links preview on the pointer only. Wiki and tag spans keep both paths, because their marks are
// complete as soon as the closing pair lands and a caret there is where the reader wants the card.
function caretProposable(mark: HTMLElement | null): HTMLElement | null {
  if (!mark) return null
  if (!carriesDestination(mark)) return mark
  return wikiRawOf(mark) === null && tagRawOf(mark) === null ? null : mark
}

function containsPoint(element: HTMLElement, point: { x: number, y: number }): boolean {
  const rect = element.getBoundingClientRect()
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
}
