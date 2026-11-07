import { describe, expect, it } from 'vitest'
import {
  PROJECT_ARCHIVE_VERSION,
  ProjectArchiveError,
  ProjectArchiveHeaderSchema,
  parseProjectArchiveLines,
  projectArchiveBlockIsBoard,
  serializeProjectArchiveLines,
  type ProjectArchiveLine,
} from './archive'

const BOARD_ID = 'b16fy9hw4p38a5mf8rq5ap6txoo'

function line(type: string, data: unknown): string {
  return JSON.stringify({ type, data })
}

describe('the archive header', () => {
  it('takes the two versions this port reads and refuses a newer one', () => {
    expect(ProjectArchiveHeaderSchema.safeParse({ version: 1, date: 0 }).success).toBe(true)
    expect(ProjectArchiveHeaderSchema.safeParse({ version: PROJECT_ARCHIVE_VERSION, date: 1 }).success).toBe(true)
    expect(ProjectArchiveHeaderSchema.safeParse({ version: 3, date: 0 }).success).toBe(false)
    expect(ProjectArchiveHeaderSchema.safeParse({ version: 2 }).success).toBe(false)
  })
})

describe('reading board.jsonl', () => {
  it('reads the three kinds a current export writes', () => {
    const text = [
      line('board', { id: BOARD_ID, title: 'Plan' }),
      line('block', { id: 'c16fy9hw4p38a5mf8rq5ap6txoo', type: 'card', parentId: BOARD_ID }),
      line('boardMember', { boardId: BOARD_ID, userId: 'u1', role: 'editor' }),
    ].join('\n')
    const lines = parseProjectArchiveLines(text)
    expect(lines.map((entry) => entry.type)).toEqual(['board', 'block', 'boardMember'])
  })

  it('reads the older board_block spelling as a block', () => {
    const lines = parseProjectArchiveLines(line('board_block', { id: 'a1', type: 'text' }))
    expect(lines[0]!.type).toBe('block')
  })

  it('finds the board inside a legacy block line, which is how the built-in templates carry it', () => {
    const lines = parseProjectArchiveLines([
      line('block', { id: BOARD_ID, type: 'board', parentId: '' }),
      line('block', { id: 'c1', type: 'card', parentId: BOARD_ID }),
    ].join('\n'))
    const blocks = lines.filter((entry) => entry.type === 'block')
    expect(blocks).toHaveLength(2)
    expect(blocks.map((entry) => projectArchiveBlockIsBoard(entry.data))).toEqual([true, false])
  })

  it('skips blank lines but counts them, so an error names the line a reader would open', () => {
    const text = `\n\n${line('board', { id: BOARD_ID })}\n\n${line('nonsense', {})}`
    expect(() => parseProjectArchiveLines(text)).toThrow(ProjectArchiveError)
    try {
      parseProjectArchiveLines(text)
    } catch (error) {
      expect((error as ProjectArchiveError).line).toBe(5)
    }
  })

  it('refuses a line that is not JSON, and one whose data is the wrong shape', () => {
    expect(() => parseProjectArchiveLines('{oops')).toThrow(/not JSON/)
    expect(() => parseProjectArchiveLines(line('block', { title: 'no id' }))).toThrow(/not a block/)
    expect(() => parseProjectArchiveLines(line('board', null))).toThrow(/no object/)
    expect(() => parseProjectArchiveLines(JSON.stringify({ type: 'board' }))).toThrow(/no type and data/)
  })

  it('round-trips what it read, byte for byte', () => {
    const lines: ProjectArchiveLine[] = [
      { type: 'board', data: { id: BOARD_ID, title: 'Plan' } },
      { type: 'boardMember', data: { boardId: BOARD_ID, userId: 'u1', role: 'editor' } },
    ]
    const text = serializeProjectArchiveLines(lines)
    expect(text.endsWith('\n')).toBe(true)
    expect(parseProjectArchiveLines(text)).toEqual(lines)
  })
})