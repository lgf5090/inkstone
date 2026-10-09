/**
 * The rules an editor step follows, worked out on text rather than on a live CodeMirror view: which
 * characters a line owns, what counts as the link on it, and what a cut leaves behind.
 */
import { describe, expect, it } from 'vitest'
import { planEditorAction } from './editor-actions'

const doc = 'first line\nsecond [[Target]] here\nthird'

describe('what an editor action selects', () => {
  it('takes the whole line the caret sits on, without its break', () => {
    const plan = planEditorAction({ text: doc, from: 14, to: 14, action: 'selectLine' })
    expect(plan?.selection).toEqual({ anchor: 11, head: 33 })
    expect(plan?.replace, 'a selection changes no text').toBeNull()
  })

  it('selects the wikilink on that line', () => {
    const plan = planEditorAction({ text: doc, from: 20, to: 20, action: 'selectLink' })
    expect(plan?.selection).toEqual({ anchor: 18, head: 28 })
  })

  it('takes an embed with its bang', () => {
    const plan = planEditorAction({ text: 'a ![[Note]] b', from: 3, to: 3, action: 'selectLink' })
    expect(plan?.selection).toEqual({ anchor: 2, head: 11 })
  })

  it('says there is nothing to select on a line without a link', () => {
    expect(planEditorAction({ text: doc, from: 3, to: 3, action: 'selectLink' })).toBeNull()
  })

  it('collapses the caret to the line edges and the file edges', () => {
    const at = (action: 'lineStart' | 'lineEnd' | 'fileStart' | 'fileEnd') =>
      planEditorAction({ text: doc, from: 20, to: 20, action })?.selection
    expect(at('lineStart')).toEqual({ anchor: 11, head: 11 })
    expect(at('lineEnd')).toEqual({ anchor: 33, head: 33 })
    expect(at('fileStart')).toEqual({ anchor: 0, head: 0 })
    expect(at('fileEnd')).toEqual({ anchor: doc.length, head: doc.length })
  })
})

describe('what an editor action writes', () => {
  it('copies the selection and changes nothing', () => {
    const plan = planEditorAction({ text: doc, from: 0, to: 5, action: 'copy' })
    expect(plan?.copied).toBe('first')
    expect(plan?.replace).toBeNull()
    expect(plan?.selection, 'the reader keeps what they had picked').toEqual({ anchor: 0, head: 5 })
  })

  it('cuts the selection to the clipboard and leaves the caret where it was', () => {
    const plan = planEditorAction({ text: doc, from: 6, to: 10, action: 'cut' })
    expect(plan?.copied).toBe('line')
    expect(plan?.replace).toEqual({ from: 6, to: 10, insert: '' })
    expect(plan?.selection).toEqual({ anchor: 6, head: 6 })
  })

  it('pastes over the selection and lands after what came in', () => {
    const plan = planEditorAction({ text: doc, from: 0, to: 5, action: 'paste', clipboard: 'FIRST' })
    expect(plan?.replace).toEqual({ from: 0, to: 5, insert: 'FIRST' })
    expect(plan?.selection).toEqual({ anchor: 5, head: 5 })
  })

  it('refuses a paste the browser would not hand over', () => {
    expect(planEditorAction({ text: doc, from: 0, to: 0, action: 'paste', clipboard: null })).toBeNull()
    expect(planEditorAction({ text: doc, from: 0, to: 0, action: 'paste' })).toBeNull()
    expect(planEditorAction({ text: doc, from: 0, to: 0, action: 'paste', clipboard: '' }), 'an empty clipboard is still an answer').not.toBeNull()
  })
})

describe('the offsets a plan can be handed', () => {
  it('reads a reversed range as one range', () => {
    const plan = planEditorAction({ text: doc, from: 10, to: 6, action: 'cut' })
    expect(plan?.replace).toEqual({ from: 6, to: 10, insert: '' })
    expect(plan?.copied).toBe('line')
  })

  it('clamps what falls outside the note', () => {
    const plan = planEditorAction({ text: 'ab', from: 99, to: 120, action: 'cut' })
    expect(plan?.replace).toEqual({ from: 2, to: 2, insert: '' })
    expect(plan?.selection).toEqual({ anchor: 2, head: 2 })
  })

  it('keeps a caret inside the line it was placed on', () => {
    expect(planEditorAction({ text: 'no break at the end', from: 19, to: 19, action: 'selectLine' })?.selection)
      .toEqual({ anchor: 0, head: 19 })
  })
})
