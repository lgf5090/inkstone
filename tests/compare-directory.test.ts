import { describe, expect, it } from 'vitest'
import { compareDirectories, normalizePath } from '../src/shared/tools/compare/directory'
import type { DirManifest } from '../src/shared/tools/compare/types'

const manifest = (root: string, entries: Array<[string, string, number]>): DirManifest => ({
  root,
  entries: entries.map(([path, sha256, size]) => ({ path, sha256, size })),
})

describe('normalizePath', () => {
  it('folds backslashes, repeated slashes and dot segments', () => {
    expect(normalizePath('a\\b//c/./d')).toBe('a/b/c/d')
    expect(normalizePath('/a/b/')).toBe('a/b')
  })
})

describe('compareDirectories', () => {
  it('puts every path in one of the four buckets', () => {
    const left = manifest('left', [
      ['same.txt', 'h1', 10],
      ['changed.txt', 'h2', 10],
      ['left-only.txt', 'h3', 5],
      ['src/index.ts', 'h4', 20],
    ])
    const right = manifest('right', [
      ['same.txt', 'h1', 10],
      ['changed.txt', 'h9', 11],
      ['right-only.txt', 'h5', 7],
      ['src/index.ts', 'h4', 20],
    ])
    const result = compareDirectories(left, right)
    expect(result.counts).toEqual({ same: 2, different: 1, leftOnly: 1, rightOnly: 1 })
    expect(result.rows.find((row) => row.path === 'changed.txt')?.status).toBe('different')
    expect(result.rows.find((row) => row.path === 'left-only.txt')?.right).toBeNull()
  })

  it('builds one tree with directories first', () => {
    const left = manifest('left', [['src/a.ts', 'a', 1], ['README.md', 'r', 1]])
    const right = manifest('right', [['src/b.ts', 'b', 1], ['README.md', 'r', 1]])
    const result = compareDirectories(left, right)
    expect(result.tree.map((node) => node.name)).toEqual(['src', 'README.md'])
    const src = result.tree[0]!
    expect(src.isFile).toBe(false)
    expect(src.children.map((node) => node.name)).toEqual(['a.ts', 'b.ts'])
    expect(src.counts).toEqual({ same: 0, different: 0, leftOnly: 1, rightOnly: 1 })
    expect(src.status).toBe('different')
  })

  it('keeps a folder that only one side has out of the same bucket', () => {
    const result = compareDirectories(manifest('l', [['only/file.txt', 'x', 1]]), manifest('r', []))
    expect(result.counts.leftOnly).toBe(1)
    expect(result.tree[0]!.status).toBe('different')
    expect(result.tree[0]!.counts.leftOnly).toBe(1)
  })

  it('answers empty for two empty folders', () => {
    const result = compareDirectories(manifest('l', []), manifest('r', []))
    expect(result.rows).toHaveLength(0)
    expect(result.tree).toHaveLength(0)
  })
})
