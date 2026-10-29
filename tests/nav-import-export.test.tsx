// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportBookmarkHtml, parseBookmarkHtml } from '../src/shared/nav/bookmark'
import {
  DEFAULT_NAV_SETTINGS,
  type NavBootstrap,
  type NavCategory,
  type NavLink,
} from '../src/shared/nav/model'
import { useNavStore } from '../src/client/features/nav/nav-store'
import { useSession } from '../src/client/store/session'
import { useUi } from '../src/client/store/ui'
import { navApi } from '../src/client/features/nav/api'
import { ImportExportModal, QrModal } from '../src/client/features/nav/NavImport'
import { ConfirmHost } from '../src/client/components/overlay'
import { initI18n, t } from '../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../src/client/lib/test-render'

const BOOTSTRAP: NavBootstrap = {
  categories: [],
  links: [],
  visits: {},
  settings: DEFAULT_NAV_SETTINGS,
  webdav: { url: '', username: '', hasPassword: false },
  counts: { total: 0, byCategory: {} },
  serverTime: 1,
}

function makeCategory(overrides: Partial<NavCategory> & Pick<NavCategory, 'id' | 'name'>): NavCategory {
  return {
    icon: 'folder',
    parentId: null,
    hasPassword: false,
    passwordMode: 'none',
    sortOrder: 0,
    createdAt: 1,
    ...overrides,
  }
}

function makeLink(overrides: Partial<NavLink> & Pick<NavLink, 'id' | 'title' | 'url' | 'categoryId'>): NavLink {
  return {
    icon: null,
    description: null,
    pinned: false,
    pinnedOrder: 0,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function seed(categories: NavCategory[], links: NavLink[]): void {
  useNavStore.setState({
    status: 'ready',
    error: null,
    categories,
    links,
    visits: {},
    counts: { total: links.length, byCategory: {} },
    settings: DEFAULT_NAV_SETTINGS,
    webdav: { url: '', username: '', hasPassword: false },
    sync: 'idle',
    unlockTokens: {},
    selectedCategory: null,
    selectedSubcategory: null,
    query: '',
  })
}

let rendered: RenderedElement | null = null

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
  sessionStorage.clear()
  useSession.setState({ user: { id: 'user-1' } as never })
  useUi.setState({ toasts: [] })
  vi.spyOn(navApi, 'bootstrap').mockResolvedValue(BOOTSTRAP)
  seed([], [])
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  vi.restoreAllMocks()
})

describe('bookmark HTML round trip', () => {
  it('keeps nesting, escaped text and URLs readable by the parser', () => {
    const tools = makeCategory({ id: 'cat-tools', name: 'Tools & <Utils>' })
    const nested = makeCategory({ id: 'cat-nested', name: 'Nested "quoted"', parentId: tools.id, sortOrder: 1 })
    const links = [
      makeLink({
        id: 'link-1',
        title: `A & B <C> "D" 'E'`,
        url: 'https://example.com/?a=1&b=2',
        categoryId: tools.id,
      }),
      makeLink({
        id: 'link-2',
        title: 'Nested link',
        url: 'https://nested.example.com/path?q=x&y=z',
        categoryId: nested.id,
      }),
      makeLink({
        id: 'link-3',
        title: 'Loose',
        url: 'mailto:person@example.com',
        categoryId: 'missing',
      }),
    ]

    const html = exportBookmarkHtml(links, [tools, nested], {
      origin: 'https://nav.example',
      uncategorizedName: t('nav.uncategorized'),
    })
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true)
    expect(html).toContain('A &amp; B &lt;C&gt; &quot;D&quot; &#039;E&#039;')

    const parsed = parseBookmarkHtml(html, { uncategorizedName: t('nav.uncategorized') })
    expect(parsed.skipped).toBe(0)
    expect(parsed.categories.map((category) => category.name)).toEqual([
      'Tools & <Utils>',
      'Nested "quoted"',
      t('nav.uncategorized'),
    ])
    const parsedTools = parsed.categories.find((category) => category.name === 'Tools & <Utils>')
    const parsedNested = parsed.categories.find((category) => category.name === 'Nested "quoted"')
    expect(parsedNested?.parentId).toBe(parsedTools?.id)
    const parsedLink = parsed.links.find((link) => link.url === 'https://example.com/?a=1&b=2')
    expect(parsedLink?.title).toBe(`A & B <C> "D" 'E'`)
    expect(parsedLink?.categoryId).toBe(parsedTools?.id)
    expect(parsed.links.find((link) => link.url === 'mailto:person@example.com')?.categoryId).toBe(
      parsed.categories.find((category) => category.name === t('nav.uncategorized'))?.id,
    )
  })
})

describe('QrModal', () => {
  it('renders the link, its title and a code without a download action', () => {
    const onClose = vi.fn()
    rendered = renderElement(
      <QrModal open onClose={onClose} url="https://example.com/a?b=1" title="Example mark" />,
    )

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('https://example.com/a?b=1')
    expect(dialog?.textContent).toContain('Example mark')
    expect(dialog?.querySelector('svg')).not.toBeNull()
    expect(dialog?.querySelector('a[download]')).toBeNull()
  })
})

describe('ImportExportModal', () => {
  it('imports a file in chunks of 200 links and sends the categories once', async () => {
    const tools = makeCategory({ id: 'cat-tools', name: 'Tools' })
    const links = Array.from({ length: 201 }, (_, index) => makeLink({
      id: `link-${index}`,
      title: `Bookmark ${index}`,
      url: `https://example.com/${index}`,
      categoryId: tools.id,
      sortOrder: index,
    }))
    const html = exportBookmarkHtml(links, [tools])
    const importSpy = vi.spyOn(navApi, 'importBookmarks').mockImplementation(async (body) => ({
      imported: body.links.length,
      skipped: 0,
    }))

    rendered = renderElement(<ImportExportModal open onClose={vi.fn()} />)
    const input = document.querySelector<HTMLInputElement>('input[accept*=".html"]')
    if (!input) throw new Error('No file input')
    expect(input.accept).toContain('.html')
    expect(input.accept).toContain('.htm')
    expect(document.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true')

    const file = new File([html], 'bookmarks.html', { type: 'text/html' })
    Object.defineProperty(file, 'text', { value: async () => html })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    await flush()
    await flush()

    expect(importSpy).toHaveBeenCalledTimes(2)
    const first = importSpy.mock.calls[0]?.[0]
    expect(first?.categories).toHaveLength(1)
    expect(first?.links).toHaveLength(200)
    expect(first?.skipExisting).toBe(true)
    const second = importSpy.mock.calls[1]?.[0]
    expect(second?.categories).toHaveLength(0)
    expect(second?.links).toHaveLength(1)
    expect(useUi.getState().toasts.at(-1)?.title).toBe(t('nav.import.done'))
    expect(document.body.textContent).toContain(t('nav.import.progress', { imported: 201, skipped: 0 }))
  })

  it('warns when locked categories are left out of the export', () => {
    seed([
      makeCategory({ id: 'cat-locked', name: 'Locked', hasPassword: true, passwordMode: 'custom' }),
      makeCategory({ id: 'cat-open', name: 'Open', sortOrder: 1 }),
    ], [])

    rendered = renderElement(<ImportExportModal open onClose={vi.fn()} />)

    expect(document.body.textContent).toContain(t('nav.import.locked_hint', { count: 1 }))
    expect(document.body.textContent).toContain(t('nav.export'))
  })
})

describe('JSON backup import', () => {
  const categoryId = 'a'.repeat(26)
  const linkId = 'b'.repeat(26)
  const backup = {
    format: 'inkstone-nav-backup',
    version: 1,
    createdAt: 1,
    categories: [{
      id: categoryId,
      name: 'Restored',
      icon: 'folder',
      parentId: null,
      sortOrder: 0,
      createdAt: 1,
      hasPassword: false,
      passwordMode: 'none',
    }],
    links: [{
      id: linkId,
      title: 'Restored link',
      url: 'https://restored.example.com/',
      icon: null,
      description: null,
      categoryId,
      pinned: false,
      pinnedOrder: 0,
      sortOrder: 0,
      createdAt: 1,
    }],
    visits: {},
    settings: DEFAULT_NAV_SETTINGS,
  }

  function jsonInput(): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>('input[accept*=".json"]')
    if (!input) throw new Error('No JSON file input')
    return input
  }

  async function feed(input: HTMLInputElement, name: string, value: unknown): Promise<void> {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    const file = new File([text], name, { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: async () => text })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
  }

  it('previews and replaces with a complete Inkstone backup after confirmation', async () => {
    const restore = vi.spyOn(navApi, 'restoreBackup').mockResolvedValue({
      restoredLinks: 1,
      restoredCategories: 1,
      restoredVisits: 0,
      unlockedCategoryNames: [],
    })
    rendered = renderElement(
      <>
        <ImportExportModal open onClose={vi.fn()} />
        <ConfirmHost />
      </>,
    )
    await feed(jsonInput(), 'backup.json', backup)

    expect(document.body.textContent).toContain(t('nav.json.preview_inkstone', { categories: 1, links: 1, visits: 0 }))
    const replace = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === t('nav.json.replace'))
    if (!replace) throw new Error('No replace button')
    act(() => replace.click())
    await flush()
    const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)
    const confirmButton = dialog ? [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === t('nav.json.replace')) : null
    if (!confirmButton) throw new Error('No confirm button')
    act(() => confirmButton.click())
    await flush()
    await flush()

    expect(restore).toHaveBeenCalledWith(backup)
    expect(useUi.getState().toasts.at(-1)?.title).toBe(t('nav.json.restore_done'))
  })

  it('merges a CloudNav backup with its warnings and keeps duplicate URLs by default', async () => {
    const importSpy = vi.spyOn(navApi, 'importBookmarks').mockImplementation(async (body) => ({
      imported: body.links.length,
      skipped: 0,
    }))
    rendered = renderElement(<ImportExportModal open onClose={vi.fn()} />)
    await feed(jsonInput(), 'cloudnav_backup.json', {
      categories: [
        { id: '1', name: 'Root', icon: 'Star', password: null, parentId: null, sortOrder: 0, createdAt: 1_700_000_000 },
        { id: '2', name: 'Secret', icon: 'Folder', password: '12345', parentId: '1', sortOrder: 0, createdAt: 1_700_000_000 },
      ],
      links: [
        { id: '10', title: 'One', url: 'https://one.example.com/', icon: null, description: 'd', categoryId: '2', pinned: true, pinnedOrder: 0, sortOrder: 0, createdAt: 1_700_000_000 },
        { id: '11', title: 'Bad', url: 'javascript:alert(1)', icon: null, description: null, categoryId: '2', pinned: false, pinnedOrder: 0, sortOrder: 1, createdAt: 1_700_000_000 },
      ],
    })

    expect(document.body.textContent).toContain(t('nav.json.preview_cloudnav', { categories: 2, links: 1 }))
    expect(document.body.textContent).toContain(t('nav.json.warn_passwords', { count: 1 }))
    expect(document.body.textContent).toContain(t('nav.json.warn_invalid', { count: 1 }))
    const merge = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === t('nav.json.merge'))
    if (!merge) throw new Error('No merge button')
    act(() => merge.click())
    await flush()
    await flush()

    expect(importSpy).toHaveBeenCalledTimes(1)
    expect(importSpy.mock.calls[0]?.[0].categories).toHaveLength(2)
    expect(importSpy.mock.calls[0]?.[0].links).toHaveLength(1)
    expect(importSpy.mock.calls[0]?.[0].skipExisting).toBe(false)
    expect(useUi.getState().toasts.at(-1)?.title).toBe(t('nav.import.done'))
  })

  it('reports an unsupported JSON document without calling the API', async () => {
    const restore = vi.spyOn(navApi, 'restoreBackup')
    rendered = renderElement(<ImportExportModal open onClose={vi.fn()} />)
    await feed(jsonInput(), 'other.json', { hello: 'world' })
    expect(document.body.textContent).toContain(t('nav.json.invalid'))
    expect(restore).not.toHaveBeenCalled()
  })
})
