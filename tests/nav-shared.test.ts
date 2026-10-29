// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  NAV_ID_PATTERN,
  buildSearchUrl,
  isNavId,
  isSafeIconValue,
  linkMatchesQuery,
  newNavId,
  normalizeIconName,
  normalizeLinkUrl,
  normalizeSearchSource,
  type NavCategory,
  type NavLink,
} from '../src/shared/nav/model'
import { parseSearchSettings } from '../src/shared/nav/validation'
import { exportBookmarkHtml, parseBookmarkHtml } from '../src/shared/nav/bookmark'

function idFactory(): () => string {
  let next = 0
  return () => String((next += 1)).padStart(26, '0')
}

function categoryByName(categories: ReturnType<typeof parseBookmarkHtml>['categories'], name: string) {
  const category = categories.find((entry) => entry.name === name)
  expect(category, `category ${name}`).toBeDefined()
  return category!
}

function linkByTitle(links: ReturnType<typeof parseBookmarkHtml>['links'], title: string) {
  const link = links.find((entry) => entry.title === title)
  expect(link, `link ${title}`).toBeDefined()
  return link!
}

const INTERNAL_ICON = `/api/nav/icons/${'a'.repeat(26)}`

function navLink(overrides: Partial<NavLink> & Pick<NavLink, 'id' | 'title' | 'url' | 'categoryId'>): NavLink {
  return {
    icon: null,
    description: null,
    pinned: false,
    pinnedOrder: 0,
    sortOrder: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function navCategory(overrides: Partial<NavCategory> & Pick<NavCategory, 'id' | 'name'>): NavCategory {
  return {
    icon: 'folder',
    parentId: null,
    hasPassword: false,
    passwordMode: 'none',
    sortOrder: 0,
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('link URL normalization', () => {
  it('accepts http, https, mailto and tel and rejects every other scheme', () => {
    const cases: Array<[string, string | null]> = [
      ['example.com', 'https://example.com/'],
      ['example.com:8080', 'https://example.com:8080/'],
      ['localhost:3000', 'https://localhost:3000/'],
      ['  https://example.com/path  ', 'https://example.com/path'],
      ['https://example.com/a b', 'https://example.com/a%20b'],
      ['HTTP://EXAMPLE.COM/Path', 'http://example.com/Path'],
      ['http:example.com', 'http://example.com/'],
      ['mailto:user@example.com', 'mailto:user@example.com'],
      ['tel:+1-555-0100', 'tel:+1-555-0100'],
      ['javascript:alert(1)', null],
      ['javascript://example.com/%0aalert(1)', null],
      ['data:text/html,<script>alert(1)</script>', null],
      ['file:///etc/passwd', null],
      ['vbscript:msgbox(1)', null],
      ['ftp://example.com/file', null],
      ['http://user:password@example.com/', null],
      ['https://user@example.com/', null],
      ['https://', null],
      ['', null],
      ['   ', null],
    ]
    for (const [input, expected] of cases) {
      expect(normalizeLinkUrl(input), input).toBe(expected)
    }
  })

  it('keeps mail and phone links as typed instead of re-serializing them', () => {
    expect(normalizeLinkUrl('  MAILTO:User@Example.com  ')).toBe('MAILTO:User@Example.com')
    expect(normalizeLinkUrl('TEL:+8613800000000')).toBe('TEL:+8613800000000')
  })
})

describe('icon values and names', () => {
  it('accepts internal icon paths and credential-free http(s) URLs only', () => {
    expect(isSafeIconValue(INTERNAL_ICON)).toBe(true)
    expect(isSafeIconValue('https://cdn.example.com/icon.png')).toBe(true)
    expect(isSafeIconValue('HTTP://cdn.example.com/icon.png')).toBe(true)
    expect(isSafeIconValue('')).toBe(true)
    expect(isSafeIconValue('   ')).toBe(true)
    expect(isSafeIconValue(`/api/nav/icons/${'a'.repeat(25)}i`)).toBe(false)
    expect(isSafeIconValue('/api/nav/icons/short')).toBe(false)
    expect(isSafeIconValue('folder')).toBe(false)
    expect(isSafeIconValue('//cdn.example.com/icon.png')).toBe(false)
    expect(isSafeIconValue('https://user:pass@cdn.example.com/icon.png')).toBe(false)
    expect(isSafeIconValue('https://user@cdn.example.com/icon.png')).toBe(false)
    expect(isSafeIconValue('javascript:alert(1)')).toBe(false)
    expect(isSafeIconValue('data:image/png;base64,AAAA')).toBe(false)
    expect(isSafeIconValue(null)).toBe(false)
    expect(isSafeIconValue(42)).toBe(false)
  })

  it('normalizes PascalCase, lucide prefixes and underscores to kebab-case', () => {
    expect(normalizeIconName('')).toBe('folder')
    expect(normalizeIconName('   ')).toBe('folder')
    expect(normalizeIconName('FolderOpen')).toBe('folder-open')
    expect(normalizeIconName('lucide:FolderOpen')).toBe('folder-open')
    expect(normalizeIconName('Lucide:Arrow_Up')).toBe('arrow-up')
    expect(normalizeIconName('folder')).toBe('folder')
    expect(normalizeIconName('\u{1F4C1}')).toBe('\u{1F4C1}')
  })
})

describe('nav identifiers', () => {
  it('generates 26-character ids from the nav alphabet and validates them', () => {
    const ids = new Set<string>()
    for (let index = 0; index < 500; index += 1) {
      const id = newNavId()
      expect(id).toHaveLength(26)
      expect(NAV_ID_PATTERN.test(id)).toBe(true)
      expect(isNavId(id)).toBe(true)
      expect(/[ilou]/.test(id)).toBe(false)
      ids.add(id)
    }
    expect(ids.size).toBe(500)
  })

  it('rejects wrong lengths, uppercase, disallowed letters and non-strings', () => {
    expect(isNavId('a'.repeat(26))).toBe(true)
    expect(isNavId('0'.repeat(26))).toBe(true)
    expect(isNavId('a'.repeat(25))).toBe(false)
    expect(isNavId('a'.repeat(27))).toBe(false)
    expect(isNavId('A'.repeat(26))).toBe(false)
    expect(isNavId(`a${'b'.repeat(24)}i`)).toBe(false)
    expect(isNavId(`a${'b'.repeat(24)}l`)).toBe(false)
    expect(isNavId(`a${'b'.repeat(24)}o`)).toBe(false)
    expect(isNavId(`a${'b'.repeat(24)}u`)).toBe(false)
    expect(isNavId(null)).toBe(false)
    expect(isNavId(123)).toBe(false)
  })
})

describe('Netscape bookmark parsing', () => {
  const bookmarkHtml = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
  <DT><H3 ADD_DATE="1700000000">Bookmarks Bar</H3>
  <DL><p>
    <DT><H3>Tools</H3>
    <DL><p>
      <DT><A HREF="https://example.com/a?x=1&amp;y=2" ICON="https://example.com/fav.ico">Example &amp; Co</A>
      <DT><H3>Nested</H3>
      <DL><p>
        <DT><A HREF="https://nested.example.com/">Nested</A>
      </DL><p>
    </DL><p>
    <DT><A HREF="https://loose.example.com/">Loose</A>
  </DL><p>
  <DT><H3>Other Bookmarks</H3>
  <DL><p>
    <DT><A HREF="javascript:alert(1)">Bad Script</A>
    <DT><A HREF="chrome://bookmarks">Chrome</A>
    <DT><A HREF="file:///etc/passwd">Local File</A>
    <DT><A HREF="">Empty</A>
    <DT><A HREF="mailto:test@example.com">Mail</A>
  </DL><p>
</DL><p>`

  it('maps root containers, keeps nesting and skips unsupported links', () => {
    const parsed = parseBookmarkHtml(bookmarkHtml, { now: 1_700_000_000_000, newId: idFactory() })

    expect(parsed.categories.map((category) => category.name)).toEqual(['Tools', 'Nested', 'Uncategorized'])
    const tools = categoryByName(parsed.categories, 'Tools')
    const nested = categoryByName(parsed.categories, 'Nested')
    const uncategorized = categoryByName(parsed.categories, 'Uncategorized')
    expect(tools.parentId).toBeNull()
    expect(nested.parentId).toBe(tools.id)
    expect(uncategorized.parentId).toBeNull()
    expect(nested.sortOrder).toBe(0)
    expect(parsed.categories.some((category) => category.name === 'Bookmarks Bar')).toBe(false)
    expect(parsed.categories.some((category) => category.name === 'Other Bookmarks')).toBe(false)

    expect(parsed.links).toHaveLength(4)
    const example = linkByTitle(parsed.links, 'Example & Co')
    expect(example.url).toBe('https://example.com/a?x=1&y=2')
    expect(example.icon).toBe('https://example.com/fav.ico')
    expect(example.categoryId).toBe(tools.id)
    expect(linkByTitle(parsed.links, 'Nested').categoryId).toBe(nested.id)
    expect(linkByTitle(parsed.links, 'Loose').categoryId).toBe(uncategorized.id)
    const mail = linkByTitle(parsed.links, 'Mail')
    expect(mail.url).toBe('mailto:test@example.com')
    expect(mail.icon).toBeNull()
    expect(parsed.skipped).toBe(4)
  })

  it('treats a localized root label as a container, not a folder', () => {
    const label = '\u4e66\u7b7e\u680f'
    const html = `<DL><p>
      <DT><H3>${label}</H3>
      <DL><p>
        <DT><H3>Dev</H3>
        <DL><p><DT><A HREF="https://dev.example.com/">Dev</A></DL><p>
      </DL><p>
    </DL><p>`
    const parsed = parseBookmarkHtml(html, { newId: idFactory() })
    expect(parsed.categories).toHaveLength(1)
    expect(parsed.categories[0]!.name).toBe('Dev')
    expect(parsed.categories[0]!.parentId).toBeNull()
    expect(parsed.links).toHaveLength(1)
    expect(parsed.skipped).toBe(0)
  })

  it('flattens folders deeper than two levels into the second level', () => {
    const html = `<DL><p>
      <DT><H3>One</H3>
      <DL><p>
        <DT><H3>Two</H3>
        <DL><p>
          <DT><H3>Three</H3>
          <DL><p><DT><A HREF="https://deep.example.com/">Deep</A></DL><p>
        </DL><p>
      </DL><p>
    </DL><p>`
    const parsed = parseBookmarkHtml(html, { newId: idFactory() })
    expect(parsed.categories.map((category) => category.name)).toEqual(['One', 'Two'])
    const two = categoryByName(parsed.categories, 'Two')
    expect(linkByTitle(parsed.links, 'Deep').categoryId).toBe(two.id)
  })

  it('puts links outside any folder into the supplied uncategorized folder', () => {
    const html = `<DL><p>
      <DT><A HREF="https://one.example.com/">One</A>
      <DT><A HREF="https://two.example.com/">Two</A>
    </DL><p>`
    const parsed = parseBookmarkHtml(html, { newId: idFactory(), uncategorizedName: 'Inbox', now: 1234 })
    expect(parsed.categories).toHaveLength(1)
    const inbox = categoryByName(parsed.categories, 'Inbox')
    expect(inbox.parentId).toBeNull()
    expect(inbox.createdAt).toBe(1234)
    expect(parsed.links.map((link) => link.categoryId)).toEqual([inbox.id, inbox.id])
    expect(parsed.links.map((link) => link.sortOrder)).toEqual([0, 1])
  })

  it('falls back to the URL for an empty anchor and truncates long titles', () => {
    const longTitle = 'T'.repeat(250)
    const html = `<DL><p>
      <DT><A HREF="https://empty-title.example.com/"></A>
      <DT><A HREF="https://long-title.example.com/">${longTitle}</A>
    </DL><p>`
    const parsed = parseBookmarkHtml(html, { newId: idFactory() })
    expect(parsed.links).toHaveLength(2)
    expect(parsed.links[0]!.title).toBe('https://empty-title.example.com/')
    expect(parsed.links[1]!.title).toHaveLength(200)
  })
})

describe('Netscape bookmark export and roundtrip', () => {
  it('escapes text and attributes and preserves nesting, icons and loose links', () => {
    const tools = navCategory({ id: 'c1', name: 'Tools & <Utils>' })
    const nested = navCategory({ id: 'c2', name: 'Nested "quoted"', parentId: 'c1', sortOrder: 0 })
    const categories = [tools, nested]
    const links = [
      navLink({
        id: 'l1',
        title: `A & B <C> "D" 'E'`,
        url: 'https://example.com/?a=1&b=2',
        icon: INTERNAL_ICON,
        categoryId: 'c1',
      }),
      navLink({
        id: 'l2',
        title: 'Nested link',
        url: 'https://nested.example.com/path?q=x&y=z',
        icon: 'https://cdn.example.com/i.png',
        categoryId: 'c2',
      }),
      navLink({
        id: 'l3',
        title: 'Loose',
        url: 'mailto:x@y.z',
        categoryId: 'missing',
      }),
    ]

    const html = exportBookmarkHtml(links, categories, {
      origin: 'https://notes.example.com/',
      uncategorizedName: 'Unsorted',
    })
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true)
    expect(html).toContain('A &amp; B &lt;C&gt; &quot;D&quot; &#039;E&#039;')
    expect(html).toContain('HREF="https://example.com/?a=1&amp;b=2"')
    expect(html).toContain(`ICON="https://notes.example.com${INTERNAL_ICON}"`)
    expect(html).toContain('Nested &quot;quoted&quot;')

    const parsed = parseBookmarkHtml(html, { newId: idFactory(), now: 1_700_000_000_000 })
    expect(parsed.skipped).toBe(0)
    expect(parsed.categories.map((category) => category.name)).toEqual([
      'Tools & <Utils>',
      'Nested "quoted"',
      'Unsorted',
    ])
    const parsedTools = categoryByName(parsed.categories, 'Tools & <Utils>')
    const parsedNested = categoryByName(parsed.categories, 'Nested "quoted"')
    expect(parsedNested.parentId).toBe(parsedTools.id)

    const parsedExample = linkByTitle(parsed.links, `A & B <C> "D" 'E'`)
    expect(parsedExample.url).toBe('https://example.com/?a=1&b=2')
    expect(parsedExample.icon).toBe(`https://notes.example.com${INTERNAL_ICON}`)
    expect(parsedExample.categoryId).toBe(parsedTools.id)

    const parsedNestedLink = linkByTitle(parsed.links, 'Nested link')
    expect(parsedNestedLink.url).toBe('https://nested.example.com/path?q=x&y=z')
    expect(parsedNestedLink.icon).toBe('https://cdn.example.com/i.png')
    expect(parsedNestedLink.categoryId).toBe(parsedNested.id)

    const parsedLoose = linkByTitle(parsed.links, 'Loose')
    expect(parsedLoose.url).toBe('mailto:x@y.z')
    expect(parsedLoose.categoryId).toBe(categoryByName(parsed.categories, 'Unsorted').id)
  })

  it('omits an ICON attribute for icons that cannot be absolute', () => {
    const html = exportBookmarkHtml(
      [navLink({ id: 'l1', title: 'Odd icon', url: 'https://odd.example.com/', icon: 'folder', categoryId: 'c1' })],
      [navCategory({ id: 'c1', name: 'Root' })],
      { origin: 'https://notes.example.com' },
    )
    expect(html).not.toContain('ICON=')
  })
})

describe('search source normalization', () => {
  it('trims fields, keeps safe icons and treats only explicit false as disabled', () => {
    const source = normalizeSearchSource({
      id: 'custom_1',
      name: '  DuckDuckGo  ',
      url: '  https://duckduckgo.com/?q={query}  ',
      icon: '  https://duckduckgo.com/favicon.ico  ',
      enabled: false,
      createdAt: 123,
    })
    expect(source).not.toBeNull()
    expect(source).toEqual({
      id: 'custom_1',
      name: 'DuckDuckGo',
      url: 'https://duckduckgo.com/?q={query}',
      icon: 'https://duckduckgo.com/favicon.ico',
      enabled: false,
      createdAt: 123,
    })
    expect(normalizeSearchSource({ name: 'On', url: 'https://on.example.com/?q={query}' })?.enabled).toBe(true)
  })

  it('rejects missing names, bad placeholders, unsafe icons and non-http URLs', () => {
    expect(normalizeSearchSource({ name: '', url: 'https://x.example.com/?q={query}' })).toBeNull()
    expect(normalizeSearchSource({ name: 'x'.repeat(41), url: 'https://x.example.com/?q={query}' })).toBeNull()
    expect(normalizeSearchSource({ name: 'No placeholder', url: 'https://x.example.com/' })).toBeNull()
    expect(normalizeSearchSource({ name: 'Ftp', url: 'ftp://x.example.com/?q={query}' })).toBeNull()
    expect(normalizeSearchSource({ name: 'Script', url: 'javascript:alert("{query}")' })).toBeNull()

    const unsafe = normalizeSearchSource({
      name: 'Unsafe icon',
      url: 'https://x.example.com/?q={query}',
      icon: 'javascript:alert(1)',
    })
    expect(unsafe?.icon).toBeNull()
    const internal = normalizeSearchSource({
      name: 'Internal icon',
      url: 'https://x.example.com/?q={query}',
      icon: INTERNAL_ICON,
    })
    expect(internal?.icon).toBe(INTERNAL_ICON)
  })

  it('keeps a valid id and replaces an invalid one with a fresh nav id', () => {
    const kept = normalizeSearchSource({ id: 'engine-1', name: 'Keep', url: 'https://k.example.com/?q={query}' })
    expect(kept?.id).toBe('engine-1')
    const replaced = normalizeSearchSource({ id: 'not valid!', name: 'Replace', url: 'https://r.example.com/?q={query}' })
    expect(replaced?.id).not.toBe('not valid!')
    expect(isNavId(replaced?.id)).toBe(true)
    const missingTimestamp = normalizeSearchSource({ name: 'Now', url: 'https://n.example.com/?q={query}', createdAt: Number.NaN })
    expect(typeof missingTimestamp?.createdAt).toBe('number')
    expect(missingTimestamp!.createdAt).toBeGreaterThan(0)
  })

  it('parses a stored search group with defaults and a valid selected source', () => {
    const stored = {
      mode: 'external',
      sources: [
        { id: 'ok', name: 'OK', url: 'https://ok.example.com/?q={query}', enabled: true },
        { id: 'bad', name: '', url: 'https://bad.example.com/?q={query}' },
        { id: 'no-query', name: 'No query', url: 'https://no.example.com/' },
      ],
      selectedSourceId: 'ok',
    }
    const parsed = parseSearchSettings(stored)
    expect(parsed.mode).toBe('external')
    expect(parsed.sources).toHaveLength(1)
    expect(parsed.sources[0]!.id).toBe('ok')
    expect(parsed.selectedSourceId).toBe('ok')

    const fallback = parseSearchSettings({ mode: 'nonsense', sources: [], selectedSourceId: 'gone' })
    expect(fallback.mode).toBe('internal')
    expect(fallback.sources).toHaveLength(10)
    expect(fallback.selectedSourceId).toBeNull()
    expect(parseSearchSettings(null).sources).toHaveLength(10)
    expect(parseSearchSettings({ mode: 'external', sources: stored.sources, selectedSourceId: 'missing' }).selectedSourceId).toBeNull()
  })

  it('builds external search URLs and refuses blank queries', () => {
    expect(buildSearchUrl({ url: 'https://search.example.com/?q={query}&lang=en' }, 'a b&c')).toBe(
      'https://search.example.com/?q=a%20b%26c&lang=en',
    )
    expect(buildSearchUrl({ url: 'https://search.example.com/{query}/{query}' }, 'x')).toBe(
      'https://search.example.com/x/x',
    )
    expect(buildSearchUrl({ url: 'https://search.example.com/?q={query}' }, '   ')).toBeNull()
  })
})

describe('local link filtering', () => {
  it('matches title, description and URL case-insensitively', () => {
    const link = { title: 'Example Site', description: 'A reference', url: 'https://docs.example.com/Guide' }
    expect(linkMatchesQuery(link, '')).toBe(true)
    expect(linkMatchesQuery(link, 'EXAMPLE')).toBe(true)
    expect(linkMatchesQuery(link, 'reference')).toBe(true)
    expect(linkMatchesQuery(link, '/guide')).toBe(true)
    expect(linkMatchesQuery(link, 'missing')).toBe(false)
  })
})
