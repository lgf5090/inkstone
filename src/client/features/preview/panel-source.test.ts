import { describe, expect, it } from 'vitest'
import { countColumns, setColumnCount, setColumnTracks, updateAlignHeader, updateColsHeader } from './panel-source'

describe('rewriting an alignment header', () => {
  it('changes only the header line', () => {
    expect(updateAlignHeader('::: center\nbody\nmore\n:::', 0, 'justify')).toBe('::: justify\nbody\nmore\n:::')
  })

  it('keeps the indentation the block sits at', () => {
    expect(updateAlignHeader('- item\n  ::: center\n  body\n  :::', 1, 'right')).toBe('- item\n  ::: right\n  body\n  :::')
  })

  it('normalizes the shorthand and the unspaced spelling to the full word', () => {
    expect(updateAlignHeader(':::c\nbody\n:::', 0, 'left')).toBe('::: left\nbody\n:::')
    expect(updateAlignHeader('::: left\nbody\n:::', 0, 'center')).toBe('::: center\nbody\n:::')
  })

  it('refuses a line that is not an alignment block', () => {
    expect(updateAlignHeader('::: cols\na\n::\nb\n:::', 0, 'center')).toBeNull()
    expect(updateAlignHeader('plain text', 0, 'center')).toBeNull()
    expect(updateAlignHeader('::: center\nbody', 0, 'right')).toBe('::: right\nbody')
  })
})

describe('rewriting a column header', () => {
  it('carries a gap, a divider and an alignment through the canonical spelling', () => {
    expect(updateColsHeader('::: cols\na\n::\nb\n:::', 0, (c) => ({ ...c, gap: 'wide' }))).toBe('::: cols gap=wide\na\n::\nb\n:::')
    expect(updateColsHeader('::: cols\na\n::\nb\n:::', 0, (c) => ({ ...c, divider: true }))).toBe('::: cols divider\na\n::\nb\n:::')
    expect(updateColsHeader('::: cols center\na\n::\nb\n:::', 0, (c) => ({ ...c, align: null }))).toBe('::: cols\na\n::\nb\n:::')
  })

  it('rewrites the legacy count spelling into the canonical one', () => {
    expect(updateColsHeader('::: 2cols\na\n::\nb\n:::', 0, (c) => ({ ...c, gap: 'narrow' }))).toBe('::: cols 2 gap=narrow\na\n::\nb\n:::')
  })

  it('keeps the marker length the author chose', () => {
    expect(updateColsHeader(':::: cols\na\n::\nb\n::::', 0, (c) => ({ ...c, divider: true }))).toBe(':::: cols divider\na\n::\nb\n::::')
  })
})

describe('counting the columns a body holds', () => {
  it('is one per separator plus the first', () => {
    expect(countColumns('::: cols\na\n::\nb\n:::', 0)).toBe(2)
    expect(countColumns('::: cols\na\n:::', 0)).toBe(1)
    expect(countColumns('::: cols\na\n::\nb\n::\nc\n:::', 0)).toBe(3)
  })

  it('leaves a separator inside a code fence out of the count', () => {
    expect(countColumns('::: cols\na\n```\n::\n```\n:::', 0)).toBe(1)
  })

  it('leaves a nested container’s own separators out of the count', () => {
    expect(countColumns('::: cols\na\n::\n::: cols\nx\n::\ny\n:::\n:::', 0)).toBe(2)
  })
})

describe('setting the column count', () => {
  it('opens a new column above the closer', () => {
    expect(setColumnCount('::: cols\na\n::\nb\n:::', 0, 3)).toBe('::: cols 3\na\n::\nb\n\n::\n\n:::')
  })

  it('never fuses the paragraphs a removed separator was dividing', () => {
    const tight = setColumnCount('::: cols 2\nA line\n::\nB line\n:::', 0, 1)
    expect(tight).toBe('::: cols\nA line\n\nB line\n:::')
    const blankAfter = setColumnCount('::: cols 2\nA line\n::\n\nB line\n:::', 0, 1)
    expect(blankAfter).toBe('::: cols\nA line\n\nB line\n:::')
    const blankBefore = setColumnCount('::: cols 2\nA line\n\n::\nB line\n:::', 0, 1)
    expect(blankBefore).toBe('::: cols\nA line\n\nB line\n:::')
  })

  it('keeps both neighbours’ content when it removes a separator', () => {
    const next = setColumnCount('::: cols 3\na\n::\nb\n::\nc\n:::', 0, 2)!
    expect(next).toContain('a')
    expect(next).toContain('b')
    expect(next).toContain('c')
    expect(countColumns(next, 0)).toBe(2)
  })

  it('stays inside the range the stylesheet draws', () => {
    expect(setColumnCount('::: cols\na\n:::', 0, 0)).toBe('::: cols\na\n:::')
    const widened = setColumnCount('::: cols\na\n:::', 0, 99)!
    expect(countColumns(widened, 0)).toBeLessThanOrEqual(6)
  })

  it('drops the explicit widths, which no longer describe the grid', () => {
    expect(setColumnCount('::: cols 1fr 2fr\na\n::\nb\n:::', 0, 3)).toContain('::: cols 3\n')
    expect(setColumnCount('::: cols 1fr 2fr\na\n::\nb\n:::', 0, 3)).not.toContain('1fr')
  })

  it('refuses a line that is not a column block', () => {
    expect(setColumnCount('::: center\na\n:::', 0, 2)).toBeNull()
    expect(setColumnCount('::: cols\na', 0, 2)).toBeNull()
  })
})

describe('setting the column widths', () => {
  it('states the count the track list implies', () => {
    expect(setColumnTracks('::: cols\na\n::\nb\n:::', 0, '1fr 2fr')).toBe('::: cols 2 1fr 2fr\na\n::\nb\n:::')
  })

  it('clears back to equal tracks', () => {
    expect(setColumnTracks('::: cols 1fr 2fr\na\n::\nb\n:::', 0, null)).toBe('::: cols\na\n::\nb\n:::')
  })
})

describe('a note that uses CRLF line endings', () => {
  const crlf = '::: cols\r\na\r\n::\r\nb\r\n:::'

  it('does not turn the document into mixed endings', () => {
    const next = setColumnCount(crlf, 0, 3)!
    expect(next).toContain('\r\n')
    expect(next.replace(/\r\n/g, '\n')).toBe(setColumnCount(crlf.replace(/\r\n/g, '\n'), 0, 3)!.replace(/\r\n/g, '\n'))
    expect(next.split('\n').slice(0, -1).every((line) => line.endsWith('\r'))).toBe(true)
  })

  it('keeps a trailing newline where the note had one', () => {
    expect(updateAlignHeader('::: center\nbody\n:::\n', 0, 'right')).toBe('::: right\nbody\n:::\n')
  })
})
