// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NAV_SETTINGS, type NavBootstrap, type NavCategory, type NavLink } from '../src/shared/nav/model'
import { useNavStore } from '../src/client/features/nav/nav-store'
import { useSession } from '../src/client/store/session'
import { useUi } from '../src/client/store/ui'
import { navApi } from '../src/client/features/nav/api'
import { CategoryManagerModal, IconPicker, UnlockModal } from '../src/client/features/nav/NavCategories'
import { ConfirmHost } from '../src/client/components/overlay'
import { initI18n, t } from '../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../src/client/lib/test-render'

const ALPHA = makeCategory({ id: 'cat-alpha', name: 'Alpha', icon: 'folder', sortOrder: 0 })
const ALPHA_CHILD = makeCategory({
  id: 'cat-alpha-child',
  name: 'Alpha child',
  icon: 'star',
  parentId: 'cat-alpha',
  sortOrder: 0,
})
const BETA = makeCategory({
  id: 'cat-beta',
  name: 'Beta',
  icon: 'globe',
  sortOrder: 1,
  hasPassword: true,
  passwordMode: 'custom',
})
const GAMMA = makeCategory({ id: 'cat-gamma', name: 'Gamma', icon: 'bookmark', sortOrder: 0 })

const BOOTSTRAP: NavBootstrap = {
  categories: [],
  links: [],
  visits: {},
  settings: DEFAULT_NAV_SETTINGS,
  webdav: { url: '', username: '', hasPassword: false },
  counts: { total: 0, byCategory: {} },
  serverTime: 1,
}

function makeCategory(overrides: { id: string; name: string } & Partial<NavCategory>): NavCategory {
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

function makeLink(categoryId: string): NavLink {
  return {
    id: `link-${categoryId}`,
    title: `Link in ${categoryId}`,
    url: 'https://example.com/',
    icon: null,
    description: null,
    categoryId,
    pinned: false,
    pinnedOrder: 0,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 2,
  }
}

function seed(categories: NavCategory[], links: NavLink[] = []): void {
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

function installSpies() {
  return {
    create: vi.spyOn(navApi, 'createCategory').mockResolvedValue({
      category: makeCategory({ id: 'cat-created', name: 'Created' }),
    }),
    update: vi.spyOn(navApi, 'updateCategory').mockResolvedValue({
      category: makeCategory({ id: 'cat-updated', name: 'Updated' }),
    }),
    remove: vi.spyOn(navApi, 'deleteCategory').mockResolvedValue({ ok: true }),
    order: vi.spyOn(navApi, 'orderCategories').mockResolvedValue({ ok: true }),
    unlock: vi.spyOn(navApi, 'unlockCategory').mockResolvedValue({
      token: 'unlock-token',
      expiresAt: Date.now() + 60_000,
    }),
    bootstrap: vi.spyOn(navApi, 'bootstrap').mockResolvedValue(BOOTSTRAP),
  }
}

let spies: ReturnType<typeof installSpies>
let rendered: RenderedElement | null = null

function click(element: Element): void {
  act(() => {
    ;(element as HTMLElement).click()
  })
}

function fill(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function buttonByText(text: string, root: ParentNode = document): HTMLButtonElement {
  const match = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text,
  )
  if (!match) throw new Error(`No button labelled "${text}"`)
  return match
}

function buttonByLabel(label: string, root: ParentNode = document): HTMLButtonElement {
  const match = [...root.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find(
    (button) => button.getAttribute('aria-label') === label,
  )
  if (!match) throw new Error(`No button named "${label}"`)
  return match
}

function categoryRow(id: string): HTMLElement {
  const match = document.querySelector<HTMLElement>(`[data-nav-category-id="${id}"]`)
  if (!match) throw new Error(`No category row for ${id}`)
  return match
}

function lastDialog(): HTMLElement {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
  const dialog = dialogs.at(-1)
  if (!dialog) throw new Error('No dialog is open')
  return dialog
}

function mountManager(target: { initialEditId?: string | null; initialParentId?: string | null; initialDeleteId?: string | null } = {}): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn()
  rendered = renderElement(
    <>
      <CategoryManagerModal open onClose={onClose} initialEditId={target.initialEditId} initialParentId={target.initialParentId} initialDeleteId={target.initialDeleteId} />
      <ConfirmHost />
    </>,
  )
  return { onClose }
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.restoreAllMocks()
  spies = installSpies()
  sessionStorage.clear()
  useSession.setState({ user: null })
  useUi.setState({ toasts: [] })
  seed([ALPHA, ALPHA_CHILD, BETA], [makeLink(ALPHA.id), makeLink(ALPHA_CHILD.id)])
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  vi.restoreAllMocks()
})

describe('IconPicker', () => {
  it('picks a Lucide icon and an emoji', () => {
    const onChange = vi.fn()
    const view = renderElement(<IconPicker value="folder" onChange={onChange} />)
    rendered = view

    click(buttonByLabel('star', view.container as unknown as ParentNode))
    expect(onChange).toHaveBeenLastCalledWith('star')

    const emojiTab = [...(view.container as unknown as ParentNode).querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (radio) => radio.textContent?.trim() === t('nav.icon.emoji'),
    )
    if (!emojiTab) throw new Error('No emoji tab')
    click(emojiTab)
    click(buttonByLabel('📁', view.container as unknown as ParentNode))
    expect(onChange).toHaveBeenLastCalledWith('📁')
  })

  it('narrows the Lucide grid with the search box', () => {
    const onChange = vi.fn()
    const view = renderElement(<IconPicker value="folder" onChange={onChange} />)
    rendered = view
    const search = view.container.querySelector<HTMLInputElement>('input[type="search"]')
    if (!search) throw new Error('No icon search box')

    fill(search, 'castle')
    expect(view.container.querySelector('button[aria-label="castle"]')).not.toBeNull()
    expect(view.container.querySelector('button[aria-label="star"]')).toBeNull()
  })
})

describe('CategoryManagerModal', () => {
  it('shows roots with their children, link counts and lock state', () => {
    mountManager()

    expect(categoryRow(ALPHA.id).textContent).toContain('Alpha')
    expect(categoryRow(ALPHA_CHILD.id).textContent).toContain('Alpha child')
    expect(categoryRow(ALPHA.id).textContent).toContain('1')
    expect(categoryRow(ALPHA_CHILD.id).textContent).toContain('1')
    expect(categoryRow(BETA.id).querySelector(`[aria-label="${t('nav.locked')}"]`)).not.toBeNull()
  })

  it('creates a root and then a child under a root', async () => {
    mountManager()

    click(buttonByText(t('nav.category.add_root')))
    const name = document.querySelector<HTMLInputElement>('input[maxlength="60"]')
    if (!name) throw new Error('No category name field')
    fill(name, '  Tools  ')
    click(buttonByText(t('nav.save')))
    await flush()

    expect(spies.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Tools',
      icon: 'folder',
      parentId: null,
      passwordMode: 'none',
    }))

    click(buttonByLabel(t('nav.category.add_child', { name: 'Alpha' })))
    const childName = document.querySelector<HTMLInputElement>('input[maxlength="60"]')
    if (!childName) throw new Error('No child name field')
    fill(childName, 'Alpha two')
    click(buttonByText(t('nav.save')))
    await flush()

    expect(spies.create).toHaveBeenLastCalledWith(expect.objectContaining({
      name: 'Alpha two',
      parentId: ALPHA.id,
    }))
  })

  it('requires eight characters before saving a new custom password', async () => {
    mountManager()

    click(buttonByLabel(`${t('nav.edit')} Alpha`))
    const custom = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (radio) => radio.textContent?.trim() === t('nav.category.password_custom'),
    )
    if (!custom) throw new Error('No custom password mode')
    click(custom)

    const save = buttonByText(t('nav.save'))
    expect(save.disabled).toBe(true)

    const password = document.querySelector<HTMLInputElement>('input[type="password"]')
    if (!password) throw new Error('No password field')
    fill(password, 'short')
    expect(save.disabled).toBe(true)

    fill(password, '12345678')
    expect(save.disabled).toBe(false)
    click(save)
    await flush()

    expect(spies.update).toHaveBeenCalledWith(ALPHA.id, expect.objectContaining({
      name: 'Alpha',
      icon: 'folder',
      passwordMode: 'custom',
      password: '12345678',
    }))
  })

  it('keeps an existing custom password when the field is left blank', async () => {
    mountManager()

    click(buttonByLabel(`${t('nav.edit')} Beta`))
    const save = buttonByText(t('nav.save'))
    expect(save.disabled).toBe(false)
    click(save)
    await flush()

    expect(spies.update).toHaveBeenCalledWith(BETA.id, expect.objectContaining({
      name: 'Beta',
      passwordMode: 'custom',
    }))
    const body = spies.update.mock.calls.at(-1)?.[1] as Record<string, unknown>
    expect(body).not.toHaveProperty('password')
  })

  it('opens the edit form directly for a category named by the caller', () => {
    mountManager({ initialEditId: ALPHA.id })

    const name = document.querySelector<HTMLInputElement>('input[maxlength="60"]')
    expect(name?.value).toBe('Alpha')
    expect(buttonByText(t('nav.save'))).not.toBeNull()
  })

  it('opens the delete panel for a category named by the caller', () => {
    mountManager({ initialDeleteId: ALPHA.id })

    expect(document.body.textContent).toContain(`${t('nav.category.delete_title')}: Alpha`)
    expect(document.querySelector('select')).not.toBeNull()
  })

  it('opens a prefilled child form when the caller names a parent', async () => {
    mountManager({ initialParentId: ALPHA.id })

    const name = document.querySelector<HTMLInputElement>('input[maxlength="60"]')
    expect(name?.value).toBe('')
    fill(name!, 'From menu')
    click(buttonByText(t('nav.save')))
    await flush()

    expect(spies.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'From menu', parentId: ALPHA.id }))
  })

  it('moves a category with the up/down buttons', async () => {
    mountManager()

    click(buttonByLabel(`${t('nav.move_down')} Alpha`))
    await flush()

    expect(spies.order).toHaveBeenCalledWith(null, [BETA.id, ALPHA.id])
  })

  it('deletes into the chosen fallback after confirmation', async () => {
    mountManager()

    click(buttonByLabel(`${t('nav.delete')} Alpha`))
    const fallback = document.querySelector('select') as HTMLSelectElement | null
    if (!fallback) throw new Error('No fallback select')
    expect(fallback.value).toBe(BETA.id)

    click(buttonByText(t('nav.delete')))
    click(buttonByText(t('nav.delete'), lastDialog() as unknown as ParentNode))
    await flush()

    expect(spies.remove).toHaveBeenCalledWith(ALPHA.id, BETA.id)
  })

  it('creates an uncategorized fallback before deleting the last category', async () => {
    seed([GAMMA], [])
    spies.create.mockResolvedValue({
      category: makeCategory({ id: 'cat-fallback', name: t('nav.category.create_fallback') }),
    })
    mountManager()

    click(buttonByLabel(`${t('nav.delete')} Gamma`))
    expect(document.querySelector('select')).toBeNull()

    click(buttonByText(t('nav.category.create_fallback')))
    click(buttonByText(t('nav.delete'), lastDialog() as unknown as ParentNode))
    await flush()

    expect(spies.create).toHaveBeenCalledWith(expect.objectContaining({
      name: t('nav.category.create_fallback'),
      icon: 'folder',
      parentId: null,
      passwordMode: 'none',
    }))
    expect(spies.remove).toHaveBeenCalledWith(GAMMA.id, 'cat-fallback')
  })
})

describe('UnlockModal', () => {
  it('reports a refused password and closes after a successful unlock', async () => {
    useSession.setState({ user: { id: 'user-1' } as never })
    spies.unlock.mockRejectedValueOnce(new Error(t('nav.error.wrong_password')))
    const onClose = vi.fn()
    rendered = renderElement(<UnlockModal category={BETA} onClose={onClose} />)

    const password = document.querySelector<HTMLInputElement>('input[type="password"]')
    if (!password) throw new Error('No password field')
    fill(password, 'wrong-pass')
    click(buttonByText(t('nav.unlock.action')))
    await flush()

    expect(spies.unlock).toHaveBeenCalledWith(BETA.id, 'wrong-pass')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(t('nav.error.wrong_password'))
    expect(onClose).not.toHaveBeenCalled()

    spies.unlock.mockResolvedValueOnce({ token: 'second-token', expiresAt: Date.now() + 60_000 })
    fill(password, 'right-pass')
    click(buttonByText(t('nav.unlock.action')))
    await flush()

    expect(spies.unlock).toHaveBeenLastCalledWith(BETA.id, 'right-pass')
    expect(spies.bootstrap).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
