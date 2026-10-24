import { describe, expect, it, vi } from 'vitest'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { templaterHighlight, templaterHighlightPlugin } from './templater'

/**
 * The engine, watched.
 *
 * "Only as much as changed" is the promise this file's whole design rests on, and it is invisible in the
 * result: a stale mark and a freshly scanned one look the same. So the parse is counted by the characters
 * it was handed, which is the only way to ask the question without a browser.
 */
const scans = vi.hoisted(() => ({ texts: [] as string[] }))

vi.mock('../lib/templater/engine/parser', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/templater/engine/parser')>()
  return {
    ...real,
    parseTemplate(template: string) {
      scans.texts.push(template)
      return real.parseTemplate(template)
    },
  }
})

const TAG = '<% tp.date.now("YYYY-MM-DD") %>'

function mount(doc: string, options: { enabled?: () => boolean, extra?: Extension[] } = {}): EditorView {
  const container = document.createElement('div')
  document.body.append(container)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage, addKeymap: false }),
        templaterHighlight({ enabled: options.enabled ?? (() => true) }),
        ...options.extra ?? [],
      ],
    }),
    parent: container,
  })
  // The fence cases ask what the scanner refused to paint, and the Markdown tree that answers that is
  // parsed after the view is built: `syntaxTree` only walks what has been parsed so far.
  ensureSyntaxTree(view.state, view.state.doc.length, 2_000)
  return view
}

interface Painted {
  from: number
  to: number
  text: string
  classes: string[]
  attributes: Record<string, string> | undefined
}

function painted(view: EditorView): Painted[] {
  const plugin = view.plugin(templaterHighlightPlugin)
  const found: Painted[] = []
  if (!plugin) return found
  plugin.decorations.between(0, view.state.doc.length, (from, to, deco) => {
    found.push({
      from,
      to,
      text: view.state.doc.sliceString(from, to),
      classes: String(deco.spec.class ?? '').split(' ').filter(Boolean),
      attributes: deco.spec.attributes,
    })
  })
  return found.sort((left, right) => left.from - right.from || left.to - right.to)
}

describe('templater highlighting', () => {
  it('leaves a note that holds no command unmarked', () => {
    const view = mount('Just prose, a [[wiki link]] and a https://example.com address.\nSecond line.')
    try {
      expect(painted(view)).toEqual([])
    }
    finally {
      view.destroy()
    }
  })

  it('marks the delimiters and the body of an interpolation where the engine read them', () => {
    const doc = `prose ${TAG} tail`
    const view = mount(doc)
    try {
      const start = doc.indexOf('<%')
      expect(painted(view).map((mark) => [mark.from - start, mark.to - start, mark.text, mark.classes])).toEqual([
        [0, 2, '<%', ['cm-templater-tag', 'cm-templater-interpolate', 'cm-templater-delimiter']],
        [2, TAG.length - 2, ' tp.date.now("YYYY-MM-DD") ', ['cm-templater-tag', 'cm-templater-interpolate', 'cm-templater-body']],
        [TAG.length - 2, TAG.length, '%>', ['cm-templater-tag', 'cm-templater-interpolate', 'cm-templater-delimiter']],
      ])
    }
    finally {
      view.destroy()
    }
  })

  it('names the whitespace and marker characters delimiter, not body', () => {
    const view = mount('<%* const x = 1 -%>')
    try {
      const marks = painted(view)
      expect(marks.map((mark) => mark.text)).toEqual(['<%*', ' const x = 1 ', '-%>'])
      expect(marks.map((mark) => mark.classes.includes('cm-templater-execute'))).toEqual([true, true, true])
      expect(marks.map((mark) => mark.classes.includes('cm-templater-delimiter'))).toEqual([true, false, true])
    }
    finally {
      view.destroy()
    }
  })

  it('names the three kinds the engine distinguishes, and the two halves', () => {
    const view = mount('<%+ tp.title %>')
    try {
      const marks = painted(view)
      expect(marks.map((mark) => mark.text)).toEqual(['<%+', ' tp.title ', '%>'])
      expect(marks.map((mark) => mark.classes[1])).toEqual(['cm-templater-dynamic', 'cm-templater-dynamic', 'cm-templater-dynamic'])
      expect(marks.map((mark) => mark.classes[2])).toEqual(['cm-templater-delimiter', 'cm-templater-body', 'cm-templater-delimiter'])
    }
    finally {
      view.destroy()
    }
  })

  it('does not let a %> inside a string end the command early', () => {
    const doc = '<%* const path = "a%>b" %>'
    const view = mount(doc)
    try {
      const marks = painted(view)
      expect(marks.map((mark) => mark.text)).toEqual(['<%*', ' const path = "a%>b" ', '%>'])
      expect(marks[marks.length - 1]!.to).toBe(doc.length)
    }
    finally {
      view.destroy()
    }
  })

  it('carries nothing but a class, so the text, the caret and a screen reader see an unmarked span', () => {
    const view = mount(TAG)
    try {
      expect(painted(view).length).toBe(3)
      for (const mark of painted(view)) expect(mark.attributes).toBeUndefined()
      expect(view.contentDOM.textContent).toBe(TAG)
      expect(view.state.doc.toString()).toBe(TAG)
    }
    finally {
      view.destroy()
    }
  })

  it('follows the reader typing a command, and stops when the command is taken away', () => {
    const view = mount('')
    try {
      // An opener the reader has not closed is not a command yet, and the engine says so.
      view.dispatch({ changes: { from: 0, insert: '<% tp.file.title ' } })
      expect(painted(view)).toEqual([])
      view.dispatch({ changes: { from: view.state.doc.length, insert: '%>' } })
      expect(painted(view).map((mark) => mark.text)).toEqual(['<%', ' tp.file.title ', '%>'])
      view.dispatch({ changes: { from: 0, to: 2, insert: '' } })
      expect(painted(view)).toEqual([])
    }
    finally {
      view.destroy()
    }
  })

  it('paints the commands before one the reader left unclosed', () => {
    const view = mount('<% a %> then <% b')
    try {
      expect(painted(view).map((mark) => mark.text)).toEqual(['<%', ' a ', '%>'])
    }
    finally {
      view.destroy()
    }
  })

  it('paints a multi-line command the moment the reader closes it', () => {
    const doc = '<%*\ntR += title\n'
    const view = mount(doc)
    try {
      expect(painted(view)).toEqual([])
      view.dispatch({ changes: { from: view.state.doc.length, insert: '%>' } })
      const marks = painted(view)
      expect(marks.map((mark) => mark.text)).toEqual(['<%*', '\ntR += title\n', '%>'])
      expect(marks[0]!.from).toBe(0)
      expect(marks[marks.length - 1]!.to).toBe(doc.length + 2)
    }
    finally {
      view.destroy()
    }
  })

  it('paints nothing while the switch is off, and paints on the next transaction after it flips', () => {
    let on = false
    const view = mount(`line one\n${TAG}\nline three`, { enabled: () => on })
    try {
      expect(painted(view)).toEqual([])
      on = true
      view.dispatch({ selection: { anchor: 0 } })
      expect(painted(view).length).toBe(3)
      on = false
      view.dispatch({ selection: { anchor: 1 } })
      expect(painted(view)).toEqual([])
    }
    finally {
      view.destroy()
    }
  })

  it('refuses to mark a read-only view, because its text is not the reader\'s to edit', () => {
    const view = mount(TAG, { extra: [EditorState.readOnly.of(true)] })
    try {
      expect(painted(view)).toEqual([])
    }
    finally {
      view.destroy()
    }
  })

  it('leaves a template-looking tag inside a fenced block alone, and marks the real one', () => {
    const doc = ['before:', '```js', `const source = "${TAG}"`, '```', `after ${TAG}`].join('\n')
    const view = mount(doc)
    try {
      const marks = painted(view)
      expect(marks.map((mark) => mark.text)).toEqual(['<%', ' tp.date.now("YYYY-MM-DD") ', '%>'])
      expect(marks[0]!.from).toBe(doc.lastIndexOf('<%'))
    }
    finally {
      view.destroy()
    }
  })

  it('reaches the DOM as a class on the text it painted, and as nothing else', () => {
    const doc = `first ${TAG}\nsecond line\nthird line`
    const view = mount(doc)
    try {
      expect(Array.from(view.contentDOM.querySelectorAll('.cm-templater-body')).map((span) => span.textContent))
        .toEqual([' tp.date.now("YYYY-MM-DD") '])
      expect(view.contentDOM.querySelectorAll('.cm-templater-delimiter')).toHaveLength(2)
      // One line per line of the note: a mark that replaced text, or a widget that added any, would show
      // up here as a different number of rendered blocks.
      expect(view.contentDOM.querySelectorAll('.cm-line')).toHaveLength(3)
      expect(view.state.doc.lines).toBe(3)
    }
    finally {
      view.destroy()
    }
  })

  it('scans only the text an edit reached, and the whole visible range only when a command opens or closes', () => {
    const doc = `first ${TAG}\nsecond line of prose\nthird line of prose`
    scans.texts.length = 0
    const view = mount(doc)
    try {
      // The build asks for the visible range whole.
      expect(scans.texts.join('')).toContain(TAG)
      // Then an edit in prose the parser was never asked about: the window it touched holds no tag.
      scans.texts.length = 0
      view.dispatch({ changes: { from: doc.indexOf('second'), to: doc.indexOf('second') + 6, insert: 'SECOND' } })
      expect(scans.texts).toEqual([])
      expect(painted(view).map((mark) => mark.text)).toEqual(['<%', ' tp.date.now("YYYY-MM-DD") ', '%>'])
      // Opening a command is the edit a window cannot answer for on its own, so the visible range is read
      // again — the one case the wider scan is worth paying for.
      scans.texts.length = 0
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n<%*\n' } })
      expect(scans.texts.join('')).toContain(TAG)
      // And closing it, on the far side of the note from where the reader is typing.
      scans.texts.length = 0
      view.dispatch({ changes: { from: view.state.doc.length, insert: 'tR += 1\n%>' } })
      expect(scans.texts.join('')).toContain('tR += 1')
      const marks = painted(view)
      expect(marks.map((mark) => mark.text)).toEqual([
        '<%', ' tp.date.now("YYYY-MM-DD") ', '%>', '<%*', '\ntR += 1\n', '%>',
      ])
      expect(marks[marks.length - 1]!.to).toBe(view.state.doc.length)
    }
    finally {
      view.destroy()
    }
  })

  it('keeps the marks it already has through a transaction that changes no text', () => {
    const view = mount(TAG)
    try {
      const before = painted(view)
      view.dispatch({ selection: { anchor: 1 } })
      expect(painted(view)).toEqual(before)
    }
    finally {
      view.destroy()
    }
  })
})
