import { gutter, GutterMarker, type EditorView } from '@codemirror/view'

/**
 * How many visual rows one logical line occupies.
 *
 * A wrapped line's CodeMirror block is taller than the editor's default line height by exactly
 * the rows it wrapped into; rounding guards the fractional pixels the browser reports for
 * `1.64`-style leading.
 */
export function wrappedRowCount(blockHeight: number, lineHeight: number): number {
  if (!Number.isFinite(blockHeight) || !Number.isFinite(lineHeight) || lineHeight <= 0)
    return 1
  return Math.max(1, Math.round(blockHeight / lineHeight))
}

/**
 * A line number followed by one faint tick per wrapped continuation row.
 *
 * The number still names the logical line, so go-to-line, the status bar and the outline keep
 * agreeing with it — but every visual row now has a gutter mark at its own height, which is what
 * makes a long paragraph read as aligned instead of as a number floating above a block of text.
 */
export class WrapLineNumberMarker extends GutterMarker {
  constructor(
    readonly label: string,
    readonly rows: number,
  ) {
    super()
  }

  eq(other: GutterMarker): boolean {
    return other instanceof WrapLineNumberMarker && other.label === this.label && other.rows === this.rows
  }

  toDOM(): HTMLElement {
    const box = document.createElement('div')
    box.className = 'cm-wrap-line'
    const number = document.createElement('span')
    number.className = 'cm-wrap-line-number'
    number.textContent = this.label
    box.append(number)
    for (let row = 1; row < this.rows; row++) {
      const tick = document.createElement('span')
      tick.className = 'cm-wrap-line-continuation'
      tick.setAttribute('aria-hidden', 'true')
      tick.textContent = '·'
      box.append(tick)
    }
    return box
  }
}

/**
 * The note editor's line-number gutter.
 *
 * `lineNumbers()` cannot draw more than one mark per logical line, so it is replaced here rather
 * than patched around; the visual row count comes from the block CodeMirror already measured.
 */
export function wrapAwareLineNumbers() {
  const marker = (view: EditorView, lineStart: number): GutterMarker => {
    const line = view.state.doc.lineAt(lineStart)
    const block = view.lineBlockAt(lineStart)
    return new WrapLineNumberMarker(String(line.number), wrappedRowCount(block.height, view.defaultLineHeight))
  }
  return gutter({
    class: 'cm-lineNumbers cm-wrap-lineNumbers',
    lineMarker: (view, line) => marker(view, line.from),
    initialSpacer: () => new WrapLineNumberMarker('0', 1),
  })
}
