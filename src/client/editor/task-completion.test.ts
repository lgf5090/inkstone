import { EditorView } from '@codemirror/view'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorSelection, EditorState } from '@codemirror/state'
import { beforeEach, describe, expect, it } from 'vitest'
import { taskFieldSource } from './task-completion'

const cp = (...codes: number[]): string => String.fromCodePoint(...codes)
const DUE = cp(0x1F4C5)

// jsdom has no Range.getClientRects, which CodeMirror's measurement needs once a view is attached.
{
  const proto = Range.prototype as unknown as { getClientRects?: () => DOMRectList }
  if (!proto.getClientRects) proto.getClientRects = () => [] as unknown as DOMRectList
}

async function completeAt(doc: string, caret = doc.length) {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(caret) })
  const result = await taskFieldSource(new CompletionContext(state, caret, true))
  return { result, state }
}

async function accept(doc: string, label: string, caret = doc.length): Promise<string> {
  const { result, state } = await completeAt(doc, caret)
  expect(result, doc).not.toBeNull()
  const option = result!.options.find((entry) => entry.label === label)
  expect(option, `${label} was not offered in ${JSON.stringify(result!.options.map((entry) => entry.label))}`).toBeTruthy()
  const host = document.createElement('div')
  document.body.append(host)
  const view = new EditorView({ state, parent: host })
  ;(option!.apply as (view: EditorView) => void)(view)
  const text = view.state.doc.toString()
  view.destroy()
  host.remove()
  return text
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('where the menu appears', () => {
  it('stays out of a line that is not a task', async () => {
    expect((await completeAt('just some prose, typed out')).result).toBeNull()
    expect((await completeAt('- a plain bullet item')).result).toBeNull()
  })

  it('opens in the middle of the description, where a field word is being typed', async () => {
    // `…write |the plan` is where typing `due` should pull up the due-date field, so the menu is not
    // confined to the end of the line.
    const doc = '- [ ] write the plan'
    const { result } = await completeAt(doc, 12)
    expect(result).not.toBeNull()
    expect(result!.from).toBe(12)
  })

  it('stays out while the caret is still in the checkbox itself', async () => {
    expect((await completeAt('- [ ] write the plan', 5)).result).toBeNull()
  })

  it('opens once the caret is past the checkbox', async () => {
    const { result } = await completeAt('- [ ] write the plan ')
    expect(result).not.toBeNull()
    expect(result!.options.map((option) => option.label)).toContain(`${DUE} due date`)
  })
})

describe('accepting a suggestion', () => {
  it('adds the field at the caret and keeps the rest of the line', async () => {
    const text = await accept('- [ ] write the plan ', `${DUE} due date`)
    expect(text).toBe(`- [ ] write the plan ${DUE} `)
  })

  it('writes the day a date word names, replacing what was typed', async () => {
    const { result } = await completeAt(`- [ ] write the plan ${DUE} toda`)
    const label = result!.options.find((option) => option.label.startsWith('today'))!.label
    const text = await accept(`- [ ] write the plan ${DUE} toda`, label)
    expect(text).toMatch(new RegExp(`^- \\[ \\] write the plan ${DUE} \\d{4}-\\d{2}-\\d{2} $`))
  })

  it('does not offer a field the line already carries', async () => {
    const { result } = await completeAt(`- [ ] write the plan ${DUE} 2026-10-20 `)
    expect(result!.options.map((option) => option.label)).not.toContain(`${DUE} due date`)
  })

  it('offers the emoji fields on a line already written with inline fields', async () => {
    // The reader's completion format is a stamping choice, not a wall: both spellings are read off the
    // same line, so the menu does not go quiet just because the note says `[due:: …]`.
    const doc = '- [ ] write the plan [due:: 2026-10-20'
    const { result } = await completeAt(doc)
    expect(result).not.toBeNull()
    expect(result!.options.map((option) => option.label)).toContain(`${DUE} due date`)
  })
})
