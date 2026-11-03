import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

/** The passage a reader quoted into the chat, marked read-only until the editor is left. */
export const setQuotedRange = StateEffect.define<{ from: number, to: number } | null>()

const quoted = Decoration.mark({ class: 'cm-quoted-highlight' })

export const quotedHighlight = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setQuotedRange)) continue
      next = effect.value ? Decoration.set([quoted.range(effect.value.from, effect.value.to)]) : Decoration.none
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

export function markQuotedRange(view: EditorView, range: { from: number, to: number }): void {
  if (range.to <= range.from) return
  view.dispatch({ effects: setQuotedRange.of(range) })
}
