import { describe, expect, it } from 'vitest'
import { Decoration, EditorView } from '@codemirror/view'
import { EditorState, RangeSetBuilder } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { collectMarkDecorations, markdownDecorations } from './decorations'

const ANCHOR_LINE = '\u951a\u70b9\uff1a[[#\u76ee\u6807\u5c0f\u8282]]'
const DOC = `# \u6807\u9898\n${ANCHOR_LINE}\n\u7ed3\u5c3e\u3002`

function mount(doc: string): EditorView {
  const container = document.createElement('div')
  document.body.append(container)
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, addKeymap: false }), markdownDecorations] }),
    parent: container,
  })
  syntaxTree(view.state).cursor()
  return view
}

/** Two visible ranges whose boundary falls inside the anchor line, as a wrapped viewport does. */
function splitRanges(view: EditorView): [{ from: number, to: number }, { from: number, to: number }] {
  const line = view.state.doc.line(2)
  const middle = line.from + 5
  return [{ from: 0, to: middle }, { from: middle, to: view.state.doc.length }]
}

function addAll(marks: ReturnType<typeof collectMarkDecorations>): boolean {
  const builder = new RangeSetBuilder<Decoration>()
  try {
    for (const mark of marks) builder.add(mark.from, mark.to, mark.deco)
    builder.finish()
    return true
  }
  catch {
    return false
  }
}

describe('collectMarkDecorations', () => {
  it('emits ranges in the order RangeSetBuilder demands', () => {
    const view = mount(DOC)
    const marks = collectMarkDecorations(view, [splitRanges(view)[0]])
    expect(marks.length).toBeGreaterThan(0)
    for (let index = 1; index < marks.length; index++) expect(marks[index]!.from).toBeGreaterThan(marks[index - 1]!.from)
    view.destroy()
  })

  it('survives a viewport boundary that falls inside a marked line', () => {
    const view = mount(DOC)
    const marks = collectMarkDecorations(view, splitRanges(view))
    for (let index = 1; index < marks.length; index++) expect(marks[index]!.from).toBeGreaterThan(marks[index - 1]!.from)
    expect(addAll(marks)).toBe(true)
    view.destroy()
  })

  it('lets a line shared by two visible ranges contribute each mark once', () => {
    const view = mount(DOC)
    const ranges = splitRanges(view)
    const shared = collectMarkDecorations(view, ranges)
    const alone = collectMarkDecorations(view, [ranges[0]])
    expect(shared.map((mark) => `${mark.from}:${mark.to}`)).toEqual(alone.map((mark) => `${mark.from}:${mark.to}`))
    view.destroy()
  })

  it('marks both the wiki link and the hashtag of a heading anchor', () => {
    const view = mount(DOC)
    const marks = collectMarkDecorations(view, [{ from: 0, to: view.state.doc.length }])
    expect(marks.filter((mark) => mark.deco.spec.attributes?.['data-tag'] !== undefined)).toHaveLength(1)
    expect(marks.filter((mark) => (mark.deco.spec.class as string)?.includes('cm-md-wikilink'))).toHaveLength(1)
    view.destroy()
  })

  it('still leaves a fenced block alone when the fence is only partly visible', () => {
    const doc = `pre\n\`\`\`js\nconst x = "[[Note]]"\n\`\`\`\npost`
    const view = mount(doc)
    const marks = collectMarkDecorations(view, [{ from: 0, to: view.state.doc.length }])
    expect(marks).toHaveLength(0)
    const line = view.state.doc.line(5)
    const tail = collectMarkDecorations(view, [{ from: line.from, to: view.state.doc.length }])
    expect(tail.filter((mark) => mark.deco.spec.class === 'cm-md-wikilink')).toHaveLength(0)
    view.destroy()
  })

  it('returns nothing when nothing is visible', () => {
    const view = mount(DOC)
    expect(collectMarkDecorations(view, [])).toEqual([])
    view.destroy()
  })
})
