import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder, StateEffect } from '@codemirror/state'
import { encodeDataValue } from '../lib/markdown/data-attr'
import { syntaxTree } from '@codemirror/language'


const taskDone = Decoration.mark({ class: 'cm-md-task-done' })
// The name rides on the mark because CodeMirror strips attributes a decoration does not declare,
// and the hover and context-menu paths both identify a hashtag by that datum.
const tagMarkFor = (name: string) => Decoration.mark({ class: 'cm-md-tag', attributes: { 'data-tag': encodeDataValue(name) } })
const wikiMark = Decoration.mark({ class: 'cm-md-wikilink' })

const TAG_RE = /(^|[\s(\uff08[\u3010>\u300c\u300e\uff0c,\u3001;\uff1b])#([\p{L}\p{N}_\-/·]{1,60})(?![\p{L}\p{N}_\-/·])/gu
const WIKI_RE = /\[\[[^[\]\n]{1,200}\]\]/g
const TASK_DONE_RE = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[[xX]\][ \t]+)(.*)$/

export interface MarkRange {
  from: number
  to: number
  deco: Decoration
}

/**
 * The marks the visible text carries, in the order `RangeSetBuilder` demands.
 *
 * Every visible range contributes to one list that is sorted once, because a viewport boundary
 * usually falls *inside* a wrapped line: two adjacent ranges then both claim that line, and
 * re-emitting its marks after the builder has already been handed a later one walks `from`
 * backwards — which CodeMirror answers by throwing and dropping the whole plugin. `seen` is what
 * makes a shared line contribute once.
 */
export function collectMarkDecorations(view: EditorView, ranges: readonly { from: number, to: number }[]): MarkRange[] {
  const tree = syntaxTree(view.state)
  const doc = view.state.doc
  const marks: MarkRange[] = []
  if (ranges.length === 0) return marks
  const seen = new Set<number>()

  const fenced: { from: number; to: number }[] = []
  tree.iterate({
    from: ranges[0]!.from,
    to: ranges[ranges.length - 1]!.to,
    enter(node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        fenced.push({ from: node.from, to: node.to })
      }
    },
  })

  for (const { from, to } of ranges) {
    const startLine = doc.lineAt(from).number
    const endLine = doc.lineAt(to).number

    for (let n = startLine; n <= endLine; n++) {
      if (seen.has(n)) continue
      seen.add(n)
      const line = doc.line(n)
      if (fenced.some((b) => line.from >= b.from && line.to <= b.to)) continue
      const text = line.text

      const done = TASK_DONE_RE.exec(text)
      if (done && done[2]) {
        marks.push({
          from: line.from + done[1]!.length,
          to: line.to,
          deco: taskDone,
        })
      }

      TAG_RE.lastIndex = 0
      for (const match of text.matchAll(TAG_RE)) {
        const offset = (match.index ?? 0) + (match[1]?.length ?? 0)
        marks.push({
          from: line.from + offset,
          to: line.from + offset + 1 + match[2]!.length,
          deco: tagMarkFor(match[2]!),
        })
      }

      WIKI_RE.lastIndex = 0
      for (const match of text.matchAll(WIKI_RE)) {
        marks.push({
          from: line.from + (match.index ?? 0),
          to: line.from + (match.index ?? 0) + match[0].length,
          deco: wikiMark,
        })
      }
    }
  }

  return marks.sort((left, right) => left.from - right.from)
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const mark of collectMarkDecorations(view, view.visibleRanges)) {
    builder.add(mark.from, mark.to, mark.deco)
  }
  return builder.finish()
}

export const markdownDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)


export const setFocusMode = StateEffect.define<boolean>()

const focusParagraph = Decoration.line({ class: 'cm-focus-paragraph' })


export const focusModePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none

    constructor(view: EditorView) {
      this.compute(view)
    }

    update(update: ViewUpdate) {
      const modeChanged = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(setFocusMode)),
      )
      if (update.docChanged || update.selectionSet || update.viewportChanged || modeChanged) {
        this.compute(update.view)
      }
    }

    compute(view: EditorView) {
      const enabled = view.dom.closest('[data-focus-mode="true"]')
      if (!enabled) {
        this.decorations = Decoration.none
        return
      }
      const doc = view.state.doc
      const cursorLine = doc.lineAt(view.state.selection.main.head).number

      let start = cursorLine
      let end = cursorLine
      while (start > 1 && doc.line(start - 1).text.trim()) start--
      while (end < doc.lines && doc.line(end + 1).text.trim()) end++

      const builder = new RangeSetBuilder<Decoration>()
      for (let n = start; n <= end; n++) {
        builder.add(doc.line(n).from, doc.line(n).from, focusParagraph)
      }
      this.decorations = builder.finish()
    }
  },
  { decorations: (plugin) => plugin.decorations },
)


export const typewriterPlugin = ViewPlugin.fromClass(
  class {
    view: EditorView
    pointerSelecting = false
    centerFrame = 0
    releaseTimer = 0

    constructor(view: EditorView) {
      this.view = view


      view.contentDOM.addEventListener('pointerdown', this.onPointerDown, true)
      document.addEventListener('pointerup', this.onPointerEnd, true)
      document.addEventListener('pointercancel', this.onPointerEnd, true)
      window.addEventListener('blur', this.onPointerEnd)
    }

    update(update: ViewUpdate) {
      if (!update.selectionSet && !update.docChanged) return
      const enabled = update.view.dom.closest('[data-typewriter="true"]')
      if (!enabled) return
      const pointerSelection = update.transactions.some((transaction) =>
        transaction.isUserEvent('select.pointer'),
      )
      if (pointerSelection) {


        cancelAnimationFrame(this.centerFrame)
        return
      }
      if (this.pointerSelecting) return

      if (update.selectionSet && !update.state.selection.main.empty) return

      cancelAnimationFrame(this.centerFrame)
      this.centerFrame = requestAnimationFrame(() => {
        if (this.pointerSelecting) return
        const view = this.view
        const head = view.state.selection.main.head
        const block = view.lineBlockAt(head)
        const scroller = view.scrollDOM
        const target = block.top - scroller.clientHeight / 2 + block.height / 2
        const delta = Math.abs(scroller.scrollTop - target)
        if (delta > 4) scroller.scrollTop = target
      })
    }

    destroy() {
      cancelAnimationFrame(this.centerFrame)
      window.clearTimeout(this.releaseTimer)
      this.view.contentDOM.removeEventListener('pointerdown', this.onPointerDown, true)
      document.removeEventListener('pointerup', this.onPointerEnd, true)
      document.removeEventListener('pointercancel', this.onPointerEnd, true)
      window.removeEventListener('blur', this.onPointerEnd)
    }

    onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      window.clearTimeout(this.releaseTimer)
      cancelAnimationFrame(this.centerFrame)
      this.pointerSelecting = true
    }

    onPointerEnd = () => {

      window.clearTimeout(this.releaseTimer)
      this.releaseTimer = window.setTimeout(() => {
        this.pointerSelecting = false
      }, 80)
    }
  },
)
