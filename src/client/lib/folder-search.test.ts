import { describe, expect, it } from 'vitest'
import { searchFolders } from './folder-search'

interface Node {
  id: string
  name: string
  children: Node[]
}

const node = (id: string, name: string, children: Node[] = []): Node => ({ id, name, children })
const ids = (nodes: Node[]): string[] => nodes.flatMap((one) => [one.id, ...ids(one.children)])

const tree: Node[] = [
  node('work', 'Work', [node('meet', 'Weekly meeting'), node('research', 'Deep Research')]),
  node('play', 'Games', [node('chess', 'Chess')]),
]

describe('filtering the folder tree', () => {
  it('hands the tree back untouched when there is nothing to filter by', () => {
    for (const query of ['', '   ']) {
      const result = searchFolders(tree, query)
      expect(result.nodes).toEqual(tree)
      expect(result.shown).toBe(5)
      expect([...result.matched]).toEqual([])
    }
  })

  it('keeps a matching folder and everything under it', () => {
    const result = searchFolders(tree, 'work')
    expect(ids(result.nodes)).toEqual(['work', 'meet', 'research'])
    expect(result.shown).toBe(3)
    expect([...result.matched]).toEqual(['work'])
    expect(result.matched.has('work')).toBe(true)
  })

  it('keeps the road to a match without marking it as one', () => {
    const result = searchFolders(tree, 'chess')
    expect(ids(result.nodes)).toEqual(['play', 'chess'])
    expect([...result.matched]).toEqual(['chess'])
    expect(result.shown).toBe(2)
  })

  it('drops a branch that holds no match', () => {
    expect(ids(searchFolders(tree, 'research').nodes)).toEqual(['work', 'research'])
  })

  it('ignores case and lets letters stand apart', () => {
    expect(ids(searchFolders(tree, 'CHESS').nodes)).toEqual(['play', 'chess'])
    expect(ids(searchFolders(tree, 'wrk').nodes)).toContain('work')
  })

  it('counts what is on screen, which is more than what the query hit', () => {
    const result = searchFolders([node('a', 'Notes', [node('b', 'Note list')]), node('c', 'Nothing')], 'note')
    expect(result.shown).toBe(2)
    expect([...result.matched]).toEqual(['a'])
  })

  it('answers with nothing when no folder is named that way', () => {
    const result = searchFolders(tree, 'zzqx')
    expect(result.nodes).toEqual([])
    expect(result.shown).toBe(0)
  })
})
