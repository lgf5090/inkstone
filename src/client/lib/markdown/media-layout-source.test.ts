import { describe, expect, it } from 'vitest'
import { MEDIA_BLOCK_DEFAULTS, parseMediaRow } from './media-layout'
import {
  applyMediaEdit,
  editAddRow,
  editBlockGeometry,
  editBlockOptions,
  editBlockWidth,
  editMoveCell,
  editRemoveRow,
  editRowOptions,
  editTakeCellOut,
  editUnwrapBlock,
  editWrapLines,
  findMediaBlockAt,
  locateMediaBlock,
} from './media-layout-source'

const GALLERY = '::: media wrap=left width=40%\n![[a.png]] ![[b.png]] {w=1:2 h=240}\n![[clip.mp4]]\n:::\n'
const TEXT_FRAME = '::: media wrap=left\nA side note.\n:::\n'

describe('reading a layout block back out of the note', () => {
  it('finds the block, its rows and its closer', () => {
    const block = locateMediaBlock(GALLERY, 0)
    expect(block?.closeLine).toBe(3)
    expect(block?.rowLines).toEqual([1, 2])
    expect(block?.options.wrap).toBe('left')
    expect(block?.isTextFrame).toBe(false)
  })

  it('reads a body of prose as a frame with no rows to size', () => {
    const block = locateMediaBlock(TEXT_FRAME, 0)
    expect(block?.isTextFrame).toBe(true)
    expect(block?.rowLines).toEqual([])
  })

  it('refuses a line that is no longer a layout header', () => {
    expect(locateMediaBlock('::: cols\na\n:::\n', 0)).toBeNull()
    expect(locateMediaBlock('plain text\n', 0)).toBeNull()
    expect(locateMediaBlock(GALLERY, 1)).toBeNull()
  })

  it('refuses a block whose body mixes prose with pictures, the way the renderer does', () => {
    expect(locateMediaBlock('::: media\n![[a.png]]\nwords\n:::\n', 0)).toBeNull()
  })

  it('finds the block a row line belongs to, and none for ordinary prose', () => {
    const source = `intro\n\n${GALLERY}\ntail\n`
    expect(findMediaBlockAt(source, 4)?.headerLine).toBe(2)
    expect(findMediaBlockAt(source, 1)).toBeNull()
    expect(findMediaBlockAt(source, 0)).toBeNull()
    // An unclosed header does not draft the lines below it into its block.
    expect(findMediaBlockAt('::: media\n![[a.png]]\n\nwords\n', 3)).toBeNull()
  })
})

describe('rewriting a layout block', () => {
  it('changes the header and leaves every other line byte for byte', () => {
    const edit = editBlockOptions(GALLERY, 0, (current) => ({ ...current, gap: 'wide' }))
    expect(edit).not.toBeNull()
    const next = applyMediaEdit(GALLERY, edit!)
    expect(next.split('\n')[0]).toBe('::: media wrap=left width=40% gap=wide')
    expect(next.split('\n').slice(1)).toEqual(GALLERY.split('\n').slice(1))
  })

  it('writes a row line with its embeds untouched', () => {
    const edit = editRowOptions(GALLERY, 0, 1, (current) => ({ ...current, weights: [3, 1], align: 'right' }))
    const next = applyMediaEdit(GALLERY, edit!)
    const line = next.split('\n')[1]!
    expect(line.startsWith('![[a.png]] ![[b.png]]')).toBe(true)
    expect(line).toContain('w=3:1')
    expect(line).toContain('h=240')
    expect(line).toContain('align=right')
  })

  it('keeps a row indentation the author chose', () => {
    const source = '::: media\n  ![[a.png]] ![[b.png]]\n:::\n'
    const next = applyMediaEdit(source, editRowOptions(source, 0, 1, (current) => ({ ...current, height: 200 }))!)
    expect(next.split('\n')[1]).toBe('  ![[a.png]] ![[b.png]] {h=200}')
  })

  it('clears a row setting when the reader asks for the default back', () => {
    const next = applyMediaEdit(GALLERY, editRowOptions(GALLERY, 0, 1, (current) => ({ ...current, weights: [], height: null }))!)
    expect(next.split('\n')[1]).toBe('![[a.png]] ![[b.png]]')
  })

  it('writes a width list onto a row that never had one', () => {
    const source = '::: media\n![[a.png]] ![[b.png]]\n:::\n'
    const next = applyMediaEdit(source, editRowOptions(source, 0, 1, (current) => ({ ...current, weights: [1, 1.9] }))!)
    expect(next).toBe('::: media\n![[a.png]] ![[b.png]] {w=1:1.9}\n:::\n')
  })

  it('sets the block width, and hands the line back to the text', () => {
    expect(applyMediaEdit(GALLERY, editBlockWidth(GALLERY, 0, 65)!).split('\n')[0]).toBe('::: media wrap=left width=65%')
    expect(applyMediaEdit(GALLERY, editBlockWidth(GALLERY, 0, null)!).split('\n')[0]).toBe('::: media wrap=left')
    expect(applyMediaEdit(GALLERY, editBlockWidth(GALLERY, 0, 4)!).split('\n')[0]).toBe('::: media wrap=left width=20%')
  })

  it('writes a width and row heights as one edit, for the frame corner', () => {
    const edit = editBlockGeometry(GALLERY, 0, { width: 50, heights: [{ line: 1, height: 200 }, { line: 2, height: 120 }] })
    expect(edit?.start).toBe(0)
    expect(edit?.end).toBe(2)
    const next = applyMediaEdit(GALLERY, edit!)
    expect(next).toBe('::: media wrap=left width=50%\n![[a.png]] ![[b.png]] {w=1:2 h=200}\n![[clip.mp4]] {h=120}\n:::\n')
  })

  it('refuses a geometry edit that would write onto a line the block does not have', () => {
    expect(editBlockGeometry(GALLERY, 0, { heights: [{ line: 9, height: 200 }] })).toBeNull()
    expect(editRowOptions(GALLERY, 0, 3, (current) => ({ ...current, height: 200 }))).toBeNull()
    expect(editRowOptions(GALLERY, 0, 9, (current) => ({ ...current, height: 200 }))).toBeNull()
  })

  it('adds a row and removes one, but never the last', () => {
    const added = applyMediaEdit(GALLERY, editAddRow(GALLERY, 0, 1)!)
    expect(added.split('\n')[2]).toBe('')
    expect(locateMediaBlock(added, 0)?.rowLines).toEqual([1, 3])
    const removed = applyMediaEdit(GALLERY, editRemoveRow(GALLERY, 0, 2)!)
    expect(removed).toBe('::: media wrap=left width=40%\n![[a.png]] ![[b.png]] {w=1:2 h=240}\n:::\n')
    // With one row left, removing it would leave a block with nothing in it.
    expect(editRemoveRow(removed, 0, 1)).toBeNull()
  })

  it('moves a picture within its row and keeps the row’s width list trimmed', () => {
    const moved = applyMediaEdit(GALLERY, editMoveCell(GALLERY, 0, { line: 1, index: 0 }, { line: 1, index: 1 })!)
    expect(moved.split('\n')[1]).toBe('![[b.png]] ![[a.png]] {w=2:1 h=240}')
  })

  it('moves a picture into another row, verbatim', () => {
    const moved = applyMediaEdit(GALLERY, editMoveCell(GALLERY, 0, { line: 1, index: 1 }, { line: 2, index: 1 })!)
    const lines = moved.split('\n')
    expect(lines[1]).toBe('![[a.png]] {h=240}')
    expect(lines[2]).toBe('![[clip.mp4]] ![[b.png]]')
  })

  it('refuses a move that would put a thirteenth picture on a row', () => {
    const pictures = Array.from({ length: 12 }, (_unused, index) => `![[p${index}.png]]`)
    const source = `::: media\n![[a.png]]\n${pictures.join(' ')}\n:::\n`
    expect(editMoveCell(source, 0, { line: 1, index: 0 }, { line: 2, index: 0 })).toBeNull()
    // A row already at the cap can still trade places inside itself.
    const moved = [...pictures.slice(1), pictures[0]!]
    const within = applyMediaEdit(source, editMoveCell(source, 0, { line: 2, index: 0 }, { line: 2, index: 11 })!)
    expect(within.split('\n')[2]).toBe(moved.join(' '))
  })

  it('takes a picture out, leaving the row’s remaining pictures configured', () => {
    const out = applyMediaEdit(GALLERY, editTakeCellOut(GALLERY, 0, 1, 0)!)
    expect(out.split('\n')[1]).toBe('![[b.png]] {h=240}')
    const onlyRow = applyMediaEdit(GALLERY, editTakeCellOut(GALLERY, 0, 2, 0)!)
    expect(onlyRow.split('\n')[2]).toBe('![[clip.mp4]]')
  })

  it('unwraps a block into the lines it was made from', () => {
    const source = '::: media\n![[a.png]] ![[b.png]] {w=1:2 h=240}\n![[c.png]]\n:::\n'
    expect(editUnwrapBlock(source, 0)).toEqual({ start: 0, end: 3, lines: ['![[a.png]] ![[b.png]]', '![[c.png]]'] })
    const next = applyMediaEdit(GALLERY, editUnwrapBlock(GALLERY, 0)!)
    expect(next).toBe('![[a.png]] ![[b.png]]\n![[clip.mp4]]\n')
  })

  it('wraps whole rows of embeds and refuses a line of prose', () => {
    const source = '![[a.png]] ![[b.png]]\n![[c.png]]\n'
    const wrapped = applyMediaEdit(source, editWrapLines(source, 0, 1, MEDIA_BLOCK_DEFAULTS)!)
    expect(wrapped).toBe('::: media\n![[a.png]] ![[b.png]]\n![[c.png]]\n:::\n')
    expect(editWrapLines('hello\n![[a.png]]\n', 0, 1, MEDIA_BLOCK_DEFAULTS)).toBeNull()
    expect(editWrapLines('\n\n', 0, 1, MEDIA_BLOCK_DEFAULTS)).toBeNull()
  })

  it('round-trips a block through an edit without losing a picture', () => {
    const source = '::: media\n![[a.png|600]] ![设计草图](attachments/sketch.png "v2"){#fig:sketch}\n:::\n'
    const next = applyMediaEdit(source, editRowOptions(source, 0, 1, (current) => ({ ...current, height: 300 }))!)
    expect(parseMediaRow(next.split('\n')[1]!)?.cells.map((cell) => cell.raw)).toEqual(parseMediaRow(source.split('\n')[1]!)?.cells.map((cell) => cell.raw))
    expect(next.split('\n')[1]).toContain('{#fig:sketch}')
  })

  it('keeps the note’s own line endings and trailing newline', () => {
    const crlf = '::: media\r\n![[a.png]] ![[b.png]]\r\n:::\r\n'
    const next = applyMediaEdit(crlf, editBlockWidth(crlf, 0, 30)!)
    expect(next).toBe('::: media width=30%\r\n![[a.png]] ![[b.png]]\r\n:::\r\n')
    const noFinalNewline = '::: media\n![[a.png]]\n:::'
    expect(applyMediaEdit(noFinalNewline, editBlockWidth(noFinalNewline, 0, 30)!).endsWith(':::')).toBe(true)
  })

  it('refuses to edit a block that is not there any more', () => {
    expect(editBlockOptions('::: media\n![[a.png]]\n', 0, (current) => current)).toBeNull()
    expect(editRowOptions('plain\n', 0, 1, (current) => current)).toBeNull()
  })
})
