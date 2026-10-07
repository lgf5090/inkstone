import { EditorState, EditorSelection } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { detectEditorContext } from './detect-editor'

function at(doc: string, marker: string) {
  const index = doc.indexOf(marker)
  if (index < 0) throw new Error(`fixture does not hold ${marker}`)
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(index) })
  return detectEditorContext(state, index)
}

function selectionOver(doc: string, from: number, to: number) {
  const state = EditorState.create({ doc, selection: EditorSelection.range(from, to) })
  return detectEditorContext(state, from)
}

describe('detectEditorContext fences', () => {
  const kanban = '```kanban\n- todo: a\n```\n'

  it('names a diagram fence by its family, not as a code block', () => {
    expect(at(kanban, '- todo').kind).toBe('kanban')
    expect(at(kanban, '- todo').fence).toMatchObject({ language: 'kanban', closed: true })
  })

  it('hands back the body without the fences around it', () => {
    expect(at(kanban, '- todo').fence?.body).toBe('- todo: a')
  })

  it('spans the whole block, opening marker line through closing line', () => {
    const fence = at(kanban, '- todo').fence!
    expect(kanban.slice(fence.from!, fence.to!)).toBe('```kanban\n- todo: a\n```')
  })

  it('keeps the fence options out of the language but records them', () => {
    const fence = at('```chart style=table\na|b\n--|--\n1|2\n```\n', 'a|b').fence!
    expect(fence.language).toBe('chart')
    expect(fence.info).toBe('chart style=table')
  })

  it('treats an example fence as its own family', () => {
    expect(at('~~~md-example title="x"\n```ts\nconst a = 1\n```\n~~~~\n', 'const a').kind).toBe('example')
  })

  it('reads the inner fence as the example body it is, the way the renderer does', () => {
    const fence = at('~~~md-example\n```ts\nconst a = 1\n```\n~~~~\n', 'const a').fence!
    expect(fence.language).toBe('md-example')
    expect(fence.body).toContain('```ts')
  })

  it('answers a plain language as a code block', () => {
    expect(at('```python\nx = 1\n```\n', 'x = 1').kind).toBe('codeblock')
  })

  it('reports an unclosed fence as open and lets it run to the end', () => {
    const fence = at('```ts\nconst a = 1\n', 'const a').fence!
    expect(fence.closed).toBe(false)
    expect(fence.body).toBe('const a = 1')
  })

  it('does not let a fence swallow the note when the marker carries a backtick in its info', () => {
    const doc = 'text `a` here\nplain line\n'
    expect(at(doc, 'plain').kind).not.toBe('codeblock')
  })
})

describe('detectEditorContext tables', () => {
  const doc = 'intro\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'

  it('parses the table and reports the column under the cursor', () => {
    const context = at(doc, '2 |')
    expect(context.kind).toBe('table')
    expect(context.table?.cursorColIndex).toBe(1)
    expect(context.table?.cursorRowIndex).toBe(0)
  })

  it('reports the header row as no row at all', () => {
    expect(at(doc, '| a |').table?.cursorRowIndex).toBe(-1)
  })

  it('ignores a pipe that is only a stray character in prose', () => {
    expect(at('a | b\nnext line\n', 'a | b').kind).toBe('empty')
  })
})

describe('detectEditorContext structure', () => {
  it('reads a heading and its level, dropping the closing hashes', () => {
    expect(at('## Title ##\nbody\n', 'Title')).toMatchObject({
      kind: 'heading',
      heading: { level: 2, text: 'Title' },
    })
  })

  it('reads the document front matter and nothing after it', () => {
    expect(at('---\ntitle: x\n---\nbody\n', 'title').kind).toBe('frontmatter')
    expect(at('---\ntitle: x\n---\nbody\n', 'body').kind).toBe('empty')
  })

  it('treats a rule with no closing pair as prose', () => {
    expect(at('---\njust a line\n', 'just').kind).toBe('empty')
  })

  it('reads a task line and whether it is done', () => {
    expect(at('- [x] done\n', 'done').task).toMatchObject({ checked: true, text: 'done' })
    expect(at('- [ ] open\n', 'open').task?.checked).toBe(false)
    expect(at('1. [x] numbered\n', 'numbered').kind).toBe('task')
  })

  it('finds the innermost container, not the one holding it', () => {
    const doc = '::: cols\n::: tabs\n@tab one\ninside\n:::\n:::\n'
    expect(at(doc, 'inside').container).toMatchObject({ directive: 'tabs' })
    expect(at(doc, '::: cols').container?.directive).toBe('cols')
  })

  it('ignores a colon fence written inside a code sample', () => {
    expect(at('```md\n::: tabs\n@tab a\n:::\n```\n', '@tab').kind).toBe('codeblock')
  })
})

describe('detectEditorContext inline spans', () => {
  it('prefers the image over the link that shares its brackets', () => {
    expect(at('see ![alt](/a.png) here\n', 'alt')).toMatchObject({
      kind: 'image',
      image: { alt: 'alt', url: '/a.png' },
    })
  })

  it('prefers the note embed over the wiki link inside it', () => {
    expect(at('![[Other Note]]\n', 'Other')).toMatchObject({ kind: 'embed', embed: { target: 'Other Note' } })
  })

  it('splits a wiki link alias', () => {
    expect(at('[[Note|shown]]\n', 'shown').wikiLink).toEqual({ target: 'Note', alias: 'shown', from: 0, to: 14 })
  })

  it('reads a link title as part of the span, not part of the url', () => {
    expect(at('[text](https://a.test "note")\n', 'text').link?.url).toBe('https://a.test')
  })

  it('reads inline math without swallowing a currency amount', () => {
    expect(at('cost $5 and $x^2$ here\n', 'x^2').math?.formula).toBe('x^2')
    expect(at('cost $5 and $x^2$ here\n', 'cost').kind).toBe('empty')
  })

  it('does not report a span the cursor is past', () => {
    expect(at('[[Note]] tail\n', 'tail').kind).toBe('empty')
  })

  it('keeps inline syntax inside a fence out of the way', () => {
    expect(at('```md\n# not a heading\n```\n', 'not a heading').kind).toBe('codeblock')
  })
})

describe('detectEditorContext display math', () => {
  const doc = 'lead\n\n$$\ny = x + 1\n$$\n\nafter\n'

  it('reads the formula body from a line inside the block', () => {
    expect(at(doc, 'y = x').math).toMatchObject({ formula: 'y = x + 1', block: true })
  })

  it('answers the opening rule as the same block', () => {
    expect(at(doc, '$$\ny').kind).toBe('math')
  })

  it('spans the two rules, so a delete takes the whole block', () => {
    const math = at(doc, 'y = x').math!
    expect(doc.slice(math.from, math.to)).toBe('$$\ny = x + 1\n$$')
  })

  it('leaves the lines outside the block alone', () => {
    expect(at(doc, 'after').kind).toBe('empty')
    expect(at(doc, 'lead').kind).toBe('empty')
  })

  it('runs an unclosed block to the end of the note', () => {
    const math = at('$$\nx = 1\n', 'x = 1').math!
    expect(math.block).toBe(true)
    expect(math.formula).toBe('x = 1')
  })

  it('does not treat a second block as part of the first', () => {
    const two = '$$\na\n$$\n\ntext\n\n$$\nb\n$$\n'
    expect(at(two, 'b').math?.formula).toBe('b')
    expect(at(two, 'text').kind).toBe('empty')
  })
})

describe('detectEditorContext selection', () => {
  it('wins over whatever the highlighted text happens to sit on', () => {
    const doc = '# Heading\n'
    const context = selectionOver(doc, 2, 9)
    expect(context.kind).toBe('selection')
    expect(context.selectedText).toBe('Heading')
  })

  it('steps aside when the cursor is outside the highlighted range', () => {
    const doc = '# Heading\n'
    const state = EditorState.create({ doc, selection: EditorSelection.range(2, 9) })
    expect(detectEditorContext(state, 0).kind).toBe('heading')
  })

  it('treats an empty selection as no selection', () => {
    expect(selectionOver('plain\n', 0, 0).kind).toBe('empty')
  })
})

describe('detectEditorContext container scan', () => {
  it('reports nothing for a note that never uses a colon fence', () => {
    expect(at('plain text\nmore text\n', 'plain').container).toBeUndefined()
  })
})
