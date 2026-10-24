/**
 * The cursor jump, against a real editor.
 *
 * This is the half of the feature that has no engine in it at all: the markers are already in the note as
 * text, and what has to be proved is that one press takes exactly one group out of the document, puts the
 * carets where the deleted markers were, and lands in the editor's history as the one step it is. Which
 * group is next is the engine's rule and is tested there (`engine/cursor-markers.test.ts`); these cases are
 * about the transaction.
 *
 * The transaction is read off the view's own `dispatch`, and not from `view.state.selection` afterwards,
 * because of the test room rather than the code: jsdom's `Selection` holds one range, so a mounted
 * `EditorView` collapses *every* multi-caret selection back to a single cursor when it syncs with the DOM —
 * even one it was handed itself. The state half of that (a transaction that really carries both carets) is
 * what is asserted here; that a browser shows several cursors at once is a check this suite cannot make,
 * and `editor/commands.ts`'s own caret group has the same limit for the same reason.
 */
import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setActiveEditorView } from '../../editor/commands'
import { initI18n, t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { registerLinkEditorNote } from '../links/store'
import { jumpToNextTemplaterCursor } from './cursor-jump'

const NOTE_ID = 'n1'

/** The literal text `tp.file.cursor(order)` leaves in a rendered template. */
function marker(order?: number | string): string {
  return order === undefined ? '<% tp.file.cursor() %>' : `<% tp.file.cursor(${order}) %>`
}

let view: EditorView | null = null
let transactions: Transaction[] = []

function mountEditor(doc: string, options: { readOnly?: boolean } = {}): EditorView {
  const host = document.createElement('div')
  document.body.append(host)
  const mounted: EditorView = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(0),
      extensions: [history(), ...(options.readOnly ? [EditorState.readOnly.of(true)] : [])],
    }),
    parent: host,
    dispatch: (transaction) => {
      transactions.push(transaction)
      mounted.update([transaction])
    },
  })
  setActiveEditorView(mounted)
  registerLinkEditorNote(mounted, NOTE_ID)
  view = mounted
  return mounted
}

function toastTitles(): string[] {
  return useUi.getState().toasts.map((toast) => toast.title)
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  transactions = []
  document.body.replaceChildren()
  view = null
  setActiveEditorView(null)
  useUi.setState({ activeNoteId: NOTE_ID, toasts: [] })
})

afterEach(() => {
  view?.destroy()
  setActiveEditorView(null)
  document.body.replaceChildren()
})

describe('jumping to the next cursor group', () => {
  it('deletes the group it consumed and lands every caret of the next one', () => {
    const editor = mountEditor(`a${marker(1)}b${marker(1)}c${marker(2)}d`)
    expect(jumpToNextTemplaterCursor()).toBe(true)
    const jumped = transactions[0]!
    // Both members of order 1 go; the carets they leave are one document apart, in the new text.
    expect(jumped.newDoc.toString()).toBe(`abc${marker(2)}d`)
    expect(jumped.selection?.ranges.map((range) => range.from)).toEqual([1, 2])
    expect(jumped.isUserEvent('delete'), 'a deletion, so it is one undo step and not a caret move').toBe(true)
    expect(editor.state.doc.toString()).toBe(`abc${marker(2)}d`)

    expect(jumpToNextTemplaterCursor()).toBe(true)
    expect(transactions[1]!.newDoc.toString()).toBe('abcd')
    expect(transactions[1]!.selection?.ranges.map((range) => range.from)).toEqual([3])
  })

  it('takes only the first of several bare markers, which is what an author of three of them expects', () => {
    const editor = mountEditor(`a${marker()}b${marker()}c`)
    expect(jumpToNextTemplaterCursor()).toBe(true)
    expect(transactions[0]!.selection?.ranges).toHaveLength(1)
    expect(editor.state.doc.toString()).toBe(`ab${marker()}c`)
    expect(transactions[0]!.selection?.ranges.map((range) => range.from)).toEqual([1])
  })

  it('is one undo step, because the reader is editing this note', () => {
    const editor = mountEditor(`a${marker(1)}b`)
    jumpToNextTemplaterCursor()
    expect(editor.state.doc.toString()).toBe('ab')
    expect(undo(editor)).toBe(true)
    expect(editor.state.doc.toString()).toBe(`a${marker(1)}b`)
  })

  it('says so when the note holds no marker, and touches nothing', () => {
    const editor = mountEditor('nothing templated here')
    expect(jumpToNextTemplaterCursor()).toBe(false)
    expect(toastTitles()).toEqual([t('templater.jump.none')])
    expect(transactions).toHaveLength(0)
    expect(editor.state.doc.toString()).toBe('nothing templated here')
  })

  it('refuses with no note open, and with an editor that is showing another note', () => {
    useUi.setState({ activeNoteId: null })
    expect(jumpToNextTemplaterCursor()).toBe(false)
    expect(toastTitles()).toEqual([t('command.no_editor_to_edit')])

    useUi.setState({ activeNoteId: NOTE_ID, toasts: [] })
    const editor = mountEditor(`a${marker(1)}b`)
    registerLinkEditorNote(editor, 'n-other-pane')
    expect(jumpToNextTemplaterCursor()).toBe(false)
    expect(toastTitles()).toEqual([t('command.no_editor_to_edit')])
    expect(transactions).toHaveLength(0)
    expect(editor.state.doc.toString()).toBe(`a${marker(1)}b`)
  })

  it('refuses a read-only editor without changing the document', () => {
    const editor = mountEditor(`a${marker(1)}b`, { readOnly: true })
    expect(jumpToNextTemplaterCursor()).toBe(false)
    expect(transactions).toHaveLength(0)
    expect(editor.state.doc.toString()).toBe(`a${marker(1)}b`)
  })
})
