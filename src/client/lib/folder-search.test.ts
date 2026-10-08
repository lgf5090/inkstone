import { describe, expect, it } from 'vitest'
import { searchFolders } from './folder-search'
import { compileQuery } from './query-match'

interface Node {
  id: string
  name: string
  children: Node[]
}

interface Note {
  id: string
  title: string
}

const node = (id: string, name: string, children: Node[] = []): Node => ({ id, name, children })
const ids = (nodes: Node[]): string[] => nodes.flatMap((one) => [one.id, ...ids(one.children)])

const tree: Node[] = [
  node('work', 'Work', [node('meet', 'Weekly meeting'), node('research', 'Deep Research')]),
  node('play', 'Games', [node('chess', 'Chess')]),
  node('\u65e5\u5e38', '\u65e5\u5e38'),
]

const NOTES: Record<string, Note[]> = {
  work: [{ id: 'n-report', title: 'Quarterly report' }],
  meet: [{ id: 'n-min', title: 'Meeting minutes' }],
  research: [{ id: 'n-reading', title: 'Reading list' }],
  chess: [{ id: 'n-rules', title: 'Tournament rules' }],
  '\u65e5\u5e38': [{ id: 'n-diary', title: '\u65e5\u8bb0 Daily' }],
}

const notesOf = (folderId: string): Note[] => NOTES[folderId] ?? []
const search = (query: string, nodes: Node[] = tree) => searchFolders(nodes, compileQuery(query), notesOf)

describe('filtering the folder tree by folder name', () => {
  it('hands the tree back untouched when there is nothing to filter by', () => {
    for (const query of ['', '   ']) {
      const result = search(query)
      expect(result.nodes).toEqual(tree)
      expect(result.shown).toBe(6)
      expect([...result.matched]).toEqual([])
      expect(result.noteShown).toBe(0)
    }
  })

  it('keeps a matching folder and everything under it', () => {
    const result = search('work')
    expect(ids(result.nodes)).toEqual(['work', 'meet', 'research'])
    expect(result.shown).toBe(3)
    expect([...result.matched]).toEqual(['work'])
    expect(result.matched.has('work')).toBe(true)
  })

  it('keeps the road to a match without marking it as one', () => {
    const result = search('chess')
    expect(ids(result.nodes)).toEqual(['play', 'chess'])
    expect([...result.matched]).toEqual(['chess'])
    expect(result.shown).toBe(2)
  })

  it('drops a branch that holds no match', () => {
    expect(ids(search('research').nodes)).toEqual(['work', 'research'])
  })

  it('ignores case and lets letters stand apart', () => {
    expect(ids(search('CHESS').nodes)).toEqual(['play', 'chess'])
    expect(ids(search('wrk').nodes)).toContain('work')
  })

  it('counts what is on screen, which is more than what the query hit', () => {
    const result = search('note', [node('a', 'Notes', [node('b', 'Note list')]), node('c', 'Nothing')])
    expect(result.shown).toBe(2)
    expect([...result.matched]).toEqual(['a'])
  })

  it('answers with nothing when no folder is named that way', () => {
    const result = search('zzqx')
    expect(result.nodes).toEqual([])
    expect(result.shown).toBe(0)
  })

  it('matches a folder written in Chinese', () => {
    const result = search('\u65e5\u5e38')
    expect(ids(result.nodes)).toEqual(['\u65e5\u5e38'])
    expect([...result.matched]).toEqual(['\u65e5\u5e38'])
  })
})

describe('filtering the folder tree by note title', () => {
  it('keeps the folder a matching note lives in, and the note alone', () => {
    const result = search('report')
    expect(ids(result.nodes)).toEqual(['work'])
    expect([...result.matched]).toEqual([])
    expect([...result.notes]).toEqual(['n-report'])
    expect(result.noteShown).toBe(1)
    expect(result.shown).toBe(1)
  })

  it('reveals the ancestors of a note buried in a subfolder', () => {
    const result = search('rules')
    expect(ids(result.nodes)).toEqual(['play', 'chess'])
    expect([...result.notes]).toEqual(['n-rules'])
    expect([...result.whole]).toEqual([])
  })

  it('hands a folder named by the query everything it holds, notes included', () => {
    const result = search('work')
    expect([...result.whole]).toEqual(['work', 'meet', 'research'])
    expect(result.noteShown).toBe(3)
    expect([...result.notes]).toEqual([])
  })

  it('hides the notes of a folder the query only walks through', () => {
    const result = search('meeting')
    // `meet` is named, so its own note shows; `work` is only the road to it, so its report does not.
    expect([...result.whole]).toEqual(['meet'])
    expect(result.noteShown).toBe(1)
    expect(result.notes.has('n-report')).toBe(false)
  })

  it('counts folders and notes apart', () => {
    const result = search('reading')
    expect(result.shown).toBe(2)
    expect(result.noteShown).toBe(1)
  })

  it('finds a note by the shape of its title, not only its spelling', () => {
    expect([...search('minu').notes]).toContain('n-min')
    expect([...search('quarterly report').notes]).toEqual(['n-report'])
  })

  it('matches a note whose title is written in Chinese', () => {
    const result = search('\u65e5\u8bb0')
    expect(ids(result.nodes)).toEqual(['\u65e5\u5e38'])
    expect([...result.notes]).toEqual(['n-diary'])
  })
})

describe('filtering the folder tree with an expression', () => {
  it('uses /body/ as a regular expression over folders and notes alike', () => {
    const anchored = search('/^Work$/')
    expect(ids(anchored.nodes)).toEqual(['work', 'meet', 'research'])
    const alternatives = search('/report|min/')
    expect([...alternatives.notes].sort()).toEqual(['n-min', 'n-report'])
  })

  it('underlines what the expression reached', () => {
    const result = search('/deep (\\w+)/')
    expect(result.matched.has('research')).toBe(true)
  })

  it('answers with nothing, and a reason, when the expression is refused', () => {
    const refused = ['/(a+)+b/', '/unbalanced(/', '/' + 'a'.repeat(200) + '/']
    for (const query of refused) {
      const compiled = compileQuery(query)
      expect(compiled.error, query).not.toBeNull()
      const result = search(query)
      expect(result.nodes, query).toEqual([])
      expect(result.shown, query).toBe(0)
    }
  })
})
