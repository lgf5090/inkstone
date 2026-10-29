import { describe, expect, it } from 'vitest'
import { isNavId } from '../src/shared/nav/model'
import { cloudNavIcon, parseCloudNavBackup } from '../src/shared/nav/cloudnav'

function idFactory(): () => string {
  let next = 0
  return () => String((next += 1)).padStart(26, '0')
}

const NOW = 1_700_000_000_000

describe('CloudNav backup conversion', () => {
  const fixture = {
    categories: [
      { id: '1', name: 'Root', icon: 'Star', password: null, parentId: null, sortOrder: 0, createdAt: 1_700_000_000 },
      { id: '2', name: ' Child  ', icon: 'FolderLock', password: '12345', parentId: '1', sortOrder: 0, createdAt: 1_700_000_000 },
      { id: '3', name: 'Orphan parent', icon: 'NotAnIcon', parentId: '999', sortOrder: 2, createdAt: 1_700_000_000 },
      { id: '4', name: 'Grand', icon: 'Github', parentId: '2', sortOrder: 0, createdAt: 1_700_000_000 },
    ],
    links: [
      { id: '10', title: 'Alpha', url: 'https://a.example.com/', icon: 'https://a.example.com/f.png', description: 'first', categoryId: '2', pinned: true, pinnedOrder: 3, sortOrder: 1, createdAt: 1_700_000_000 },
      { id: '11', title: 'Duplicate URL', url: 'https://a.example.com/', icon: null, description: null, categoryId: '1', pinned: false, pinnedOrder: 0, sortOrder: 2, createdAt: 1_700_000_000_000 },
      { id: '12', title: 'Bad', url: 'javascript:alert(1)', icon: null, description: null, categoryId: '1', pinned: false, pinnedOrder: 0, sortOrder: 3, createdAt: 1_700_000_000 },
      { id: '12', title: 'Duplicate id', url: 'https://x.example.com/', icon: null, description: null, categoryId: '1', pinned: false, pinnedOrder: 0, sortOrder: 4, createdAt: 1_700_000_000 },
      { id: '13', title: 'Orphan', url: 'https://orphan.example.com/', icon: '', description: '', categoryId: '99', pinned: false, pinnedOrder: 0, sortOrder: 5, createdAt: 1_700_000_000 },
      { id: '14', title: '', url: 'https://fallback.example.com/', icon: null, description: '', categoryId: '1', pinned: false, pinnedOrder: 0, sortOrder: 6, createdAt: 1_700_000_000 },
    ],
  }

  it('remaps ids, parents and icons and reports every dropped row', () => {
    const result = parseCloudNavBackup(fixture, { newId: idFactory(), uncategorizedName: 'Uncategorized', now: NOW })
    expect(result.stats).toMatchObject({
      sourceCategories: 4,
      sourceLinks: 6,
      categories: 5,
      links: 4,
      invalidUrls: 1,
      duplicateLinkIds: 1,
      duplicateUrls: 1,
      orphanCategories: 1,
      orphanLinks: 1,
      flattenedCategories: 1,
      passwordsSkipped: 1,
      iconFallbacks: 1,
    })
    const root = result.categories.find((category) => category.name === 'Root')!
    const child = result.categories.find((category) => category.name === 'Child')!
    const grand = result.categories.find((category) => category.name === 'Grand')!
    const orphan = result.categories.find((category) => category.name === 'Orphan parent')!
    expect(root.icon).toBe('star')
    expect(child.icon).toBe('folder-lock')
    expect(orphan.icon).toBe('folder')
    expect(grand.icon).toBe('git-branch')
    expect(grand.parentId).toBeNull()
    expect(child.parentId).toBe(root.id)
    expect(root.createdAt).toBe(1_700_000_000_000)
    expect(result.categories.every((category) => isNavId(category.id))).toBe(true)

    const alpha = result.links.find((link) => link.title === 'Alpha')!
    expect(alpha.categoryId).toBe(child.id)
    expect(alpha.pinned).toBe(true)
    expect(alpha.pinnedOrder).toBe(3)
    expect(alpha.createdAt).toBe(1_700_000_000_000)
    expect(alpha.icon).toBe('https://a.example.com/f.png')
    expect(alpha.description).toBe('first')

    const fallback = result.links.find((link) => link.url === 'https://fallback.example.com/')!
    expect(fallback.title).toBe('https://fallback.example.com/')
    expect(fallback.description).toBeNull()

    const uncategorized = result.categories.find((category) => category.name === 'Uncategorized')!
    expect(result.links.find((link) => link.title === 'Orphan')!.categoryId).toBe(uncategorized.id)
    expect(result.links.every((link) => result.categories.some((category) => category.id === link.categoryId))).toBe(true)
  })

  it('handles a full-size backup without losing rows or emitting invalid ids', () => {
    const categories = Array.from({ length: 96 }, (_, index) => ({
      id: String(1_700_000_000_000 + index),
      name: `Category ${index}`,
      icon: index % 2 ? 'Folder' : 'Star',
      password: null,
      parentId: index < 15 || index % 5 === 0 ? null : String(1_700_000_000_000 + (index % 15)),
      sortOrder: index,
      createdAt: 1_700_000_000,
    }))
    const links = Array.from({ length: 414 }, (_, index) => ({
      id: String(1_800_000_000_000 + index),
      title: `Link ${index}`,
      url: `https://example.com/${index}`,
      icon: index % 3 ? `https://example.com/${index}.png` : null,
      description: `Description ${index}`,
      categoryId: categories[index % categories.length]!.id,
      pinned: index < 62,
      pinnedOrder: index < 62 ? index : 0,
      sortOrder: index,
      createdAt: 1_700_000_000_000 + index,
    }))
    const result = parseCloudNavBackup({ links, categories }, { newId: idFactory(), now: NOW })
    expect(result.categories).toHaveLength(96)
    expect(result.links).toHaveLength(414)
    expect(result.stats.skippedLinks).toBe(0)
    expect(result.stats.duplicateUrls).toBe(0)
    expect(result.stats.iconFallbacks).toBe(0)
    expect(result.categories.every((category) => isNavId(category.id))).toBe(true)
    expect(result.links.every((link) => isNavId(link.id))).toBe(true)
    expect(result.links.filter((link) => link.pinned)).toHaveLength(62)
    expect(new Set(result.links.map((link) => link.id)).size).toBe(414)
    expect(result.links.every((link) => result.categories.some((category) => category.id === link.categoryId))).toBe(true)
  })

  it('repairs a URL with a stray scheme prefix', () => {
    const result = parseCloudNavBackup({
      categories: [{ id: '1', name: 'Root', icon: 'Folder', parentId: null, sortOrder: 0, createdAt: 1 }],
      links: [{ id: '2', title: 'Repairable', url: 'https:// https://example.com/path', categoryId: '1', icon: null, description: null, pinned: false, pinnedOrder: 0, sortOrder: 0, createdAt: 1 }],
    }, { newId: idFactory(), now: NOW })
    expect(result.stats.repairedUrls).toBe(1)
    expect(result.links[0]!.url).toBe('https://example.com/path')
  })

  it('refuses a document that is not a CloudNav backup', () => {
    expect(() => parseCloudNavBackup({ links: [] })).toThrow('Not a CloudNav backup')
    expect(() => parseCloudNavBackup(null)).toThrow('Not a CloudNav backup')
  })

  it('maps known icons, aliases github and falls back for unknown names', () => {
    expect(cloudNavIcon('Star')).toBe('star')
    expect(cloudNavIcon('FolderLock')).toBe('folder-lock')
    expect(cloudNavIcon('Github')).toBe('git-branch')
    expect(cloudNavIcon('NotAnIcon')).toBe('folder')
    expect(cloudNavIcon('📁')).toBe('📁')
  })
})
