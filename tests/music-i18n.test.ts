// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function walk(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) files.push(...walk(path))
    else if (/\.(ts|tsx)$/.test(name)) files.push(path)
  }
  return files
}

function literalMusicKeys(): string[] {
  const keys = new Set<string>()
  for (const file of walk('src/client/features/music')) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:musicText|t)\(\s*'(music\.[a-z0-9_.]+)'/g)) keys.add(match[1]!)
  }
  return [...keys]
}

function definedKeys(): Set<string> {
  const source = readFileSync('src/shared/locales/en-US-music.ts', 'utf8')
  return new Set([...source.matchAll(/'((?:music|api\.error\.music)[a-z0-9_.]*)'\s*:/g)].map((match) => match[1]!))
}

describe('music message catalog completeness', () => {
  it('defines every literal musicText/t key used by the music app', () => {
    const defined = definedKeys()
    const missing = literalMusicKeys().filter((key) => !defined.has(key))
    expect(missing).toEqual([])
  })

  it('uses at least one key from every major surface', () => {
    const defined = definedKeys()
    for (const prefix of ['music.home', 'music.search', 'music.upload', 'music.downloads', 'music.lyrics']) {
      expect([...defined].some((key) => key.startsWith(prefix)), prefix).toBe(true)
    }
  })
})
