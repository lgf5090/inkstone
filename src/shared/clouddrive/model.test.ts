import { describe, expect, it } from 'vitest'
import {
  autoSuffixName,
  categoryFor,
  childPath,
  decodeCloudDriveCursor,
  encodeCloudDriveCursor,
  foldedName,
  normalizeCloudDrivePath,
  parseCloudDrivePrefs,
  parentPathOf,
  restoredName,
} from './model'

describe('cloud drive paths', () => {
  it('normalizes roots and repeated slashes', () => {
    expect(normalizeCloudDrivePath('/')).toBe('/')
    expect(normalizeCloudDrivePath('///docs//a.txt/')).toBe('/docs/a.txt')
    expect(normalizeCloudDrivePath('docs/a.txt')).toBe('/docs/a.txt')
  })

  it('refuses traversal, control characters and windows-hostile names', () => {
    for (const value of ['/../etc/passwd', '/a/../b', '/%2e%2e/x', '/a\\b', '/a/\u0000b', '/a.', '/a ', '/CON', '/com1.txt']) {
      expect(() => normalizeCloudDrivePath(value), value).toThrow('invalid_path')
    }
  })

  it('keeps unicode names and joins children', () => {
    expect(normalizeCloudDrivePath('/笔记/第一章.md')).toBe('/笔记/第一章.md')
    expect(parentPathOf('/笔记/第一章.md')).toBe('/笔记')
    expect(parentPathOf('/a')).toBe('/')
    expect(childPath('/', '笔记')).toBe('/笔记')
    expect(childPath('/笔记', 'a.md')).toBe('/笔记/a.md')
  })

  it('decodes cursors it encoded', () => {
    const cursor = encodeCloudDriveCursor({ v: 'alpha', id: '01abc' })
    expect(decodeCloudDriveCursor(cursor)).toEqual({ v: 'alpha', id: '01abc' })
  })
})

describe('cloud drive names and categories', () => {
  it('suggests copy and restore names without moving the extension', () => {
    expect(autoSuffixName('report.pdf', 0)).toBe('report.pdf')
    expect(autoSuffixName('report.pdf', 2)).toBe('report (2).pdf')
    expect(autoSuffixName('README', 1)).toBe('README (1)')
    expect(restoredName('report.pdf')).toBe('report (restored).pdf')
  })

  it('folds names for collision checks', () => {
    expect(foldedName('Report.PDF')).toBe(foldedName('report.pdf'))
  })

  it('maps extensions before mime fallbacks', () => {
    expect(categoryFor('a.MP4')).toBe('videos')
    expect(categoryFor('a.bin', 'image/png')).toBe('images')
    expect(categoryFor('a.bin', 'application/pdf')).toBe('documents')
    expect(categoryFor('a.bin')).toBe('other')
  })
})

describe('cloud drive preferences', () => {
  it('clamps every numeric preference and falls back on unknown values', () => {
    const prefs = parseCloudDrivePrefs({
      viewMode: 'gallery',
      iconSize: 999,
      density: -4,
      gap: 999,
      sortKey: 'nope',
      sortDir: 'desc',
      uploadConcurrency: 0,
      filenameDisplay: 'middle',
    })
    expect(prefs.viewMode).toBe('gallery')
    expect(prefs.iconSize).toBe(72)
    expect(prefs.density).toBe(50)
    expect(prefs.gap).toBe(8)
    expect(prefs.sortKey).toBe('name')
    expect(prefs.sortDir).toBe('desc')
    expect(prefs.uploadConcurrency).toBe(3)
    expect(prefs.filenameDisplay).toBe('middle')
  })
})
