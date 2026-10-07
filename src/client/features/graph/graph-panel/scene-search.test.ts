import { describe, expect, it } from 'vitest'
import { graphSearchHits, matchesColorGroup } from './scene'
import { preloadPinyin } from '../../../lib/pinyin'
import type { GraphNode } from '@shared/types'

/**
 * The graph's own filter box, read through the matcher the panel shares with every other listing: a
 * reader who types the first letters of a Chinese note title has to land on that note, and the hit
 * count the panel prints is derived from exactly this set.
 */
function node(id: string, title: string, tags: string[] = []): GraphNode {
  return {
    id,
    title,
    kind: 'note',
    degree: 1,
    inDegree: 1,
    outDegree: 0,
    folderId: null,
    folderName: null,
    folderColor: null,
    tags: tags.map((name) => ({ name, color: null })),
  }
}

const SELECTED = '\u6b22\u8fce\u4f7f\u7528 Inkstone' // huan-ying-shi-yong
const SOURCED = '\u6570\u636e\u6765\u6e90' // shu-ju-lai-yuan
const DEEP = '\u6df1\u5ea6\u7814\u7a76' // shen-du-yan-jiu
const TODO_LIST = '\u5f85\u529e\u4e8b\u9879' // dai-ban-shi-xiang, dbsx

const nodes = [node('n1', SELECTED), node('n2', 'Welcome to Inkstone'), node('n3', SOURCED)]

describe('graph search reads Chinese titles', () => {
  it('finds a note by the first letters of its Chinese title', async () => {
    await preloadPinyin()
    expect(graphSearchHits(nodes, 'hysy')?.has('n1')).toBe(true)
    expect(graphSearchHits(nodes, 'hysyinkstone')?.has('n1')).toBe(true)
    expect(graphSearchHits(nodes, 'sjly')?.has('n3')).toBe(true)
    expect(graphSearchHits(nodes, 'shujulaiyuan')?.has('n3')).toBe(true)
    expect(graphSearchHits(nodes, 'zzqqww')).toBeNull()
  })

  it('keeps the literal and latin paths working beside it', async () => {
    await preloadPinyin()
    expect(graphSearchHits(nodes, 'inkstone')?.size).toBe(2)
    expect(graphSearchHits(nodes, 'WELCOME')?.has('n2')).toBe(true)
    expect(graphSearchHits(nodes, '   ')).toBeNull()
  })

  it('matches a node field by field, so two fields cannot each answer half a query', async () => {
    await preloadPinyin()
    const tagged = node('n4', DEEP, [TODO_LIST])
    expect(matchesColorGroup(tagged, 'sdyj')).toBe(true)
    expect(matchesColorGroup(tagged, 'dbsx')).toBe(true)
    expect(matchesColorGroup(tagged, 'sdyj dbsx')).toBe(true)
    expect(matchesColorGroup(tagged, 'sdyj qxzzww')).toBe(false)
    expect(matchesColorGroup(tagged, '')).toBe(false)
  })
})
