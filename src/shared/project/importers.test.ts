import { describe, expect, it } from 'vitest'
import { parseProjectArchiveLines, serializeProjectArchiveLines } from './archive'
import { projectArchiveLinesToImport } from './archive-mapping'
import { importAsanaCsv, importDeck, importJiraCsv, importNotionCsv, importTodoistCsv, importTrello, parseCsv } from './importers'

function roundTrip(lines: ReturnType<typeof importTrello>) {
  return projectArchiveLinesToImport(parseProjectArchiveLines(serializeProjectArchiveLines(lines)))
}

describe('csv parsing', () => {
  it('handles quoted commas, escaped quotes and CRLF', () => {
    expect(parseCsv('a,"b,1","say ""hi"""\r\nc,d,e\r\n')).toEqual([['a', 'b,1', 'say "hi"'], ['c', 'd', 'e']])
  })
})

describe('the six importers produce importable archives', () => {
  it('trello maps lists to a status property and cards to it', () => {
    const imported = roundTrip(importTrello(JSON.stringify({
      name: 'T', lists: [{ id: 'l1', name: 'To do' }, { id: 'l2', name: 'Done' }],
      cards: [{ name: 'Task1', idList: 'l1', desc: 'hello' }, { name: 'Task2', idList: 'l2' }],
    })))
    expect(imported.board.title).toBe('T')
    expect(imported.cards.map((c) => c.title)).toEqual(['Task1', 'Task2'])
    expect(imported.properties[0]!.options.map((o) => o.value)).toEqual(['To do', 'Done'])
    expect(imported.contents[0]!.title).toBe('hello')
  })

  it('deck maps stacks to status', () => {
    const imported = roundTrip(importDeck(JSON.stringify({ title: 'D', stacks: [{ id: 1, title: 'A' }], cards: [{ title: 'C1', stackId: 1, description: 'x' }] })))
    expect(imported.board.title).toBe('D')
    expect(imported.cards[0]!.title).toBe('C1')
    expect(imported.properties[0]!.options[0]!.value).toBe('A')
  })

  it('asana csv', () => {
    const imported = roundTrip(importAsanaCsv('Name,Section/Column,Notes\nTask1,To do,note\n'))
    expect(imported.cards[0]!.title).toBe('Task1')
    expect(imported.properties[0]!.options[0]!.value).toBe('To do')
  })

  it('notion csv', () => {
    const imported = roundTrip(importNotionCsv('Name,Status\nN1,Open\n'))
    expect(imported.cards[0]!.title).toBe('N1')
    expect(imported.properties[0]!.options[0]!.value).toBe('Open')
  })

  it('jira csv', () => {
    const imported = roundTrip(importJiraCsv('Summary,Status,Description\nJ1,Open,desc\n'))
    expect(imported.cards[0]!.title).toBe('J1')
    expect(imported.contents[0]!.title).toBe('desc')
  })

  it('todoist csv', () => {
    const imported = roundTrip(importTodoistCsv('Content,Section,Description\nT1,Today,d\n'))
    expect(imported.cards[0]!.title).toBe('T1')
    expect(imported.properties[0]!.options[0]!.value).toBe('Today')
  })
})