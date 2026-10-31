import { describe, expect, it } from 'vitest'
import type { GistFile } from '@shared/development/github/types'
import {
  GistFileError,
  addGistFile,
  buildGistFilesPatch,
  chooseFence,
  inferGistLanguage,
  normalizeGistFiles,
  removeGistFile,
  updateGistFile,
} from '../src/client/features/development/github/lib/gist-files'

function file(filename: string, content = '', language: string | null = null): GistFile {
  return { filename, language, content, size: 0 }
}

describe('gist file drafts', () => {
  it('infers a language from the filename', () => {
    expect(inferGistLanguage('main.py')).toBe('Python')
    expect(inferGistLanguage('Dockerfile')).toBe('Dockerfile')
    expect(inferGistLanguage('unknown.zzz')).toBe('Text')
  })

  it('trims names and recomputes sizes', () => {
    const normalized = normalizeGistFiles([
      file('  a.ts  ', 'const x = 1'),
      file('b.md', 'hello', 'Markdown'),
    ])
    expect(normalized[0]).toEqual({ filename: 'a.ts', language: 'TypeScript', content: 'const x = 1', size: 11 })
    expect(normalized[1]!.size).toBe(5)
  })

  it('rejects empty, duplicate, oversized and missing files', () => {
    expect(() => normalizeGistFiles([])).toThrow(GistFileError)
    expect(() => normalizeGistFiles([file('   ')])).toThrow(/empty_filename/)
    expect(() => normalizeGistFiles([file('a.txt'), file(' a.txt ')])).toThrow(/duplicate_filename/)
    expect(() => normalizeGistFiles([file('a'.repeat(201))])).toThrow(/filename_too_long/)
    expect(() => normalizeGistFiles([file('big.txt', 'x'.repeat(512 * 1024 + 1))])).toThrow(/file_too_large/)
    const many = Array.from({ length: 51 }, (_, index) => file(`f${index}.txt`))
    expect(() => normalizeGistFiles(many)).toThrow(/too_many_files/)
  })

  it('rejects a batch whose contents exceed the total limit', () => {
    expect(() => normalizeGistFiles([
      file('a.txt', 'x'.repeat(400 * 1024)),
      file('b.txt', 'x'.repeat(400 * 1024)),
    ])).toThrow(/total_too_large/)
  })

  it('adds a uniquely named file and refuses past the limit', () => {
    const added = addGistFile([file('file.txt')])
    expect(added).toHaveLength(2)
    expect(added[1]!.filename).toBe('file-2.txt')
    expect(added[1]!.language).toBe('Text')
    const fifty = Array.from({ length: 50 }, (_, index) => file(`f${index}.txt`))
    expect(() => addGistFile(fifty)).toThrow(/too_many_files/)
  })

  it('removes a file while keeping at least one', () => {
    const files = [file('a.txt'), file('b.txt')]
    expect(removeGistFile(files, 0).map((entry) => entry.filename)).toEqual(['b.txt'])
    expect(removeGistFile([file('only.txt')], 0)).toHaveLength(1)
    expect(removeGistFile(files, 9)).toHaveLength(2)
  })

  it('updates content size and infers a new language', () => {
    const files = [file('a.txt', 'old', 'Text')]
    const contentUpdated = updateGistFile(files, 0, { content: 'new body' })
    expect(contentUpdated[0]).toMatchObject({ content: 'new body', size: 8, language: 'Text' })
    const renamed = updateGistFile(files, 0, { filename: 'main.rs' })
    expect(renamed[0]).toMatchObject({ filename: 'main.rs', language: 'Rust' })
    const cleared = updateGistFile(files, 0, { filename: ' ' })
    expect(cleared[0]!.language).toBeNull()
    expect(updateGistFile(files, 4, { content: 'x' })).toHaveLength(1)
  })

  it('chooses a fence longer than any run in the body', () => {
    expect(chooseFence('plain')).toBe('```')
    expect(chooseFence('a ``` b')).toBe('````')
    expect(chooseFence('``````')).toBe('```````')
  })

  it('builds a patch that deletes omitted files and only sends changes', () => {
    const original = [file('a.txt', 'keep'), file('b.txt', 'old'), file('c.txt', 'gone')]
    const edited = [file('a.txt', 'keep'), file('b.txt', 'new'), file('d.txt', 'added')]
    expect(buildGistFilesPatch(original, edited)).toEqual({
      'b.txt': { content: 'new' },
      'd.txt': { content: 'added' },
      'c.txt': null,
    })
  })

  it('builds a delete-and-add patch for renames', () => {
    expect(buildGistFilesPatch([file('old.ts', 'x')], [file('new.ts', 'x')])).toEqual({
      'old.ts': null,
      'new.ts': { content: 'x' },
    })
  })
})
