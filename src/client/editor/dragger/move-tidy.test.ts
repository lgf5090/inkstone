import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { tidyChanges } from './move-tidy'

const TAB = 2

function fixture(lines: string[]) {
  return EditorState.create({ doc: lines.join('\n') }).doc
}

function apply(doc: ReturnType<typeof fixture>, changes: readonly { from: number, to: number, insert: string }[]) {
  let text = doc.toString()
  for (const change of [...changes].sort((a, b) => b.from - a.from)) {
    text = text.slice(0, change.from) + change.insert + text.slice(change.to)
  }
  return text
}

describe('the drop tidy pass', () => {
  it('eats the empty line a cut leaves behind', () => {
    const doc = fixture(['# T', '', 'Para.', '', '## Next', ''])
    const line = doc.line(3)
    const changes = tidyChanges(doc, [
      { from: doc.line(5).from, to: doc.line(5).from, insert: 'Para.\n' },
      { from: line.from, to: line.to + 1, insert: '' },
    ], TAB)
    const result = apply(doc, changes)
    expect(result.split('\n').filter((text, index, all) => text === '' && all[index - 1] === '')).toHaveLength(0)
    expect(result).toBe('# T\n\nPara.\n\n## Next\n')
  })

  it('separates a block dropped onto another line so the pair still parses', () => {
    const doc = fixture(['Para.', '## Heading'])
    const changes = tidyChanges(doc, [
      { from: 6, to: 6, insert: '' },
      { from: 0, to: 0, insert: 'Moved.\n' },
    ], TAB)
    const inserted = changes.find((change) => change.insert.length > 0)
    expect(inserted?.insert).toBe('Moved.\n\n')
  })

  it('leaves a list item glued to its list, where a blank line would split the run', () => {
    const doc = fixture(['- one', '- two'])
    const changes = tidyChanges(doc, [{ from: 0, to: 0, insert: '- moved\n' }], TAB)
    expect(changes[0].insert).toBe('- moved\n')
  })

  it('does not touch a cut whose neighbour is real text', () => {
    const doc = fixture(['# T', 'Para.', '## Next'])
    const line = doc.line(2)
    const changes = tidyChanges(doc, [{ from: line.from, to: line.to + 1, insert: '' }], TAB)
    expect(changes[0]).toEqual({ from: line.from, to: line.to + 1, insert: '' })
  })

  it('keeps a cut that ends mid-line, and a change that reaches the document end', () => {
    const doc = fixture(['# T', '', 'Para.'])
    const midLine = tidyChanges(doc, [{ from: 20, to: 23, insert: '' }], TAB)
    expect(midLine[0].to).toBe(23)
    const atEnd = tidyChanges(doc, [{ from: doc.line(1).from, to: doc.length, insert: '' }], TAB)
    expect(atEnd[0].to).toBe(doc.length)
  })

  it('never reaches past a change that follows it', () => {
    const doc = fixture(['# T', '', 'Para.', '', 'Tail.'])
    const cut = { from: doc.line(3).from, to: doc.line(5).from, insert: '' }
    const changes = tidyChanges(doc, [cut], TAB)
    expect(changes[0].to).toBeLessThanOrEqual(doc.length)
    expect(apply(doc, changes).split('\n')).toEqual(['# T', '', 'Tail.'])
  })
})
