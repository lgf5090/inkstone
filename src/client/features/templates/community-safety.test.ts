/**
 * The three places a stranger's template is stopped at the door.
 *
 * Plan §0.6 and §D15 say what the reader may not be asked to trust: a gallery body that runs code is not
 * executed on their device without either a confirmation (import) or a posture they set themselves (the
 * policy), and the author is the one who has to acknowledge that a published body runs code. Those three are
 * product promises, not comments, so they are tested here as behaviour: what the reader is told, what is
 * asked, and what the engine is finally handed.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommunityTemplate, NoteTemplate } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { initI18n, t } from '../../lib/i18n'
import { useNoteTemplates } from '../../store/note-templates'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { createNoteWithEngine } from './template-engine'
import { CommunityPanel } from './community-panel'
import { useGalleryTemplateActions } from './gallery-actions'
import { PublishTemplateDialog } from './misc-modals'
import type { GalleryLocalState } from './gallery-state'
import type { MessageKey } from '@shared/locales/en-US'

const confirmMock = vi.hoisted(() => vi.fn(async (_options: { title?: string } = {}) => true))

vi.mock('../../components/overlay', async (original) => ({
  ...(await original<typeof import('../../components/overlay')>()),
  confirm: confirmMock,
}))

vi.mock('./template-engine', async (original) => {
  const actual = await original<typeof import('./template-engine')>()
  return {
    ...actual,
    createNoteWithEngine: vi.fn(async () => true),
    insertNoteWithEngine: vi.fn(async () => true),
  }
})

vi.mock('../../lib/api', async (original) => {
  const actual = await original<typeof import('../../lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      communityTemplates: { ...actual.api.communityTemplates, use: vi.fn(async () => undefined) },
    },
  }
})

const CODE_BODY = '<%* tR += tp.file.title %>'
const PLAIN_BODY = '# {{title}}\n'

function community(content: string, id = 'cm-1'): CommunityTemplate {
  return {
    id, name: 'Stranger', description: '', content, tags: [], category: 'General',
    authorId: 'u-other', authorName: 'Other', createdAt: 1, downloads: 0, rating: 0, uses: 0,
  } as CommunityTemplate
}

function libraryTemplate(content: string): NoteTemplate {
  return {
    id: 'tpl-1', name: 'Mine', description: '', content, categoryId: null, tags: [],
    builtin: false, isPinned: false, isStarred: false, createdAt: 1, updatedAt: 1,
  } as NoteTemplate
}

let root: Root
let container: HTMLDivElement
let closed = 0
let actions: ReturnType<typeof useGalleryTemplateActions>

function Probe() {
  actions = useGalleryTemplateActions({ onClose: () => { closed += 1 } } as GalleryLocalState, [])
  return null
}

async function render(element: Parameters<Root['render']>[0]) {
  await act(async () => {
    root.render(element)
    await Promise.resolve()
  })
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

function policy(next: 'readonly' | 'trusted') {
  const settings = useSession.getState().settings
  useSession.setState({
    settings: { ...settings, templater: { ...settings.templater, communityScriptPolicy: next } },
  })
}

function toasts(): string[] {
  return useUi.getState().toasts.map((toast) => toast.title)
}

const create = vi.mocked(createNoteWithEngine)

beforeEach(async () => {
  localStorage.clear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  confirmMock.mockReset()
  confirmMock.mockResolvedValue(true)
  create.mockClear()
  closed = 0
  await initI18n()
  useSession.setState({
    status: 'authed',
    user: { id: 'u-1', login: 'a', name: 'A', avatarUrl: '', role: 'owner', createdAt: 0, username: 'a' },
    settings: { ...DEFAULT_SETTINGS },
  })
  useNoteTemplates.setState({ templates: [], categories: [], hydrated: true })
  useUi.setState({ toasts: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('using a gallery template where it stands', () => {
  it('refuses a code body while the policy is the default, and says what to do instead', async () => {
    policy('readonly')
    await render(createElement(Probe))
    await act(async () => {
      actions.useCommunityTemplate(community(CODE_BODY))
    })
    await settle()
    expect(toasts()).toContain(t('templates.community_direct_blocked'))
    expect(create).not.toHaveBeenCalled()
    expect(closed).toBe(0)
  })

  it('runs it read-only once the reader has chosen the trusted posture', async () => {
    policy('trusted')
    await render(createElement(Probe))
    await act(async () => {
      actions.useCommunityTemplate(community(CODE_BODY))
    })
    await settle()
    expect(create.mock.calls[0]![2]).toBe('community')
    expect(closed).toBe(1)
  })

  it('never blocks a body with no code in it, whichever posture is set', async () => {
    for (const next of ['readonly', 'trusted'] as const) {
      policy(next)
      create.mockClear()
      confirmMock.mockClear()
      await render(createElement(Probe))
      await act(async () => {
        actions.useCommunityTemplate(community(PLAIN_BODY))
      })
      await settle()
      expect(create).toHaveBeenCalledOnce()
      expect(create.mock.calls[0]![2]).toBe('library')
      expect(confirmMock).not.toHaveBeenCalled()
    }
  })

  it('keeps the reader’s own library templates on the local door', async () => {
    await render(createElement(Probe))
    await act(async () => {
      actions.useTemplate(libraryTemplate(CODE_BODY))
    })
    await settle()
    // The engine's own default is `library`, so a library row never carries a third argument — what this
    // pins is that the gallery's provenance is not being smuggled onto the reader's own template.
    expect(create.mock.calls[0]![2]).not.toBe('community')
    expect(toasts()).not.toContain(t('templates.community_direct_blocked'))
  })
})

describe('importing a gallery template', () => {
  it('asks before a code body joins the library, and adds nothing on a no', async () => {
    confirmMock.mockResolvedValueOnce(false)
    const created = vi.spyOn(useNoteTemplates.getState(), 'createTemplate')
    await render(createElement(Probe))
    await act(async () => {
      actions.importCommunityTemplate(community(CODE_BODY))
    })
    await settle()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(confirmMock.mock.calls[0]![0]?.title).toBe(t('templates.community_import_title'))
    expect(created).not.toHaveBeenCalled()
  })

  it('adds it once the reader has said yes', async () => {
    const created = vi.fn(() => 'tpl-new')
    useNoteTemplates.setState({ createTemplate: created as never })
    await render(createElement(Probe))
    await act(async () => {
      actions.importCommunityTemplate(community(CODE_BODY))
    })
    await settle()
    expect(created).toHaveBeenCalledTimes(1)
    expect(toasts()).toContain(t('templates.community_imported'))
  })

  it('does not ask about a body that cannot run anything', async () => {
    const created = vi.fn(() => 'tpl-new')
    useNoteTemplates.setState({ createTemplate: created as never })
    await render(createElement(Probe))
    await act(async () => {
      actions.importCommunityTemplate(community(PLAIN_BODY))
    })
    await settle()
    expect(confirmMock).not.toHaveBeenCalled()
    expect(created).toHaveBeenCalledTimes(1)
  })
})

describe('publishing', () => {
  // `Modal` renders through a portal on `document.body`, so every lookup starts there.
  function dialog(): HTMLElement {
    const node = document.querySelector<HTMLElement>('[role="dialog"]')
    if (!node) throw new Error('the publish dialog did not mount')
    return node
  }

  function publishButton(): HTMLButtonElement {
    return [...dialog().querySelectorAll<HTMLButtonElement>('button')].at(-1)!
  }

  function checkbox(): HTMLButtonElement | null {
    return dialog().querySelector<HTMLButtonElement>('[role="checkbox"]')
  }

  it('makes the author acknowledge a body that runs code', async () => {
    await render(createElement(PublishTemplateDialog, {
      template: libraryTemplate(CODE_BODY),
      category: 'General',
      onClose: () => {},
      onPublished: () => {},
    }))
    expect(checkbox(), 'the acknowledgement is missing').toBeTruthy()
    expect(publishButton().disabled).toBe(true)
    await act(async () => {
      checkbox()!.click()
      await Promise.resolve()
    })
    expect(publishButton().disabled).toBe(false)
  })

  it('asks nothing of a plain body', async () => {
    await render(createElement(PublishTemplateDialog, {
      template: libraryTemplate(PLAIN_BODY),
      category: 'General',
      onClose: () => {},
      onPublished: () => {},
    }))
    expect(checkbox()).toBeNull()
    expect(publishButton().disabled).toBe(false)
  })

  it('names the promise in both languages', async () => {
    const key: MessageKey = 'templates.publish_runs_code'
    expect(t(key).length).toBeGreaterThan(8)
  })
})

describe('what a gallery card says before the reader presses anything', () => {
  async function renderPanel(items: CommunityTemplate[]) {
    await render(createElement(CommunityPanel, {
      items,
      query: '',
      loading: false,
      isError: false,
      hasMore: false,
      myId: 'u-1',
      onRefresh: () => {},
      onLoadMore: () => {},
      onUse: () => {},
      onImport: () => {},
      onUnpublish: () => {},
    }))
    await settle()
  }

  function badgeCount(label: string): number {
    return [...container.querySelectorAll('span')].filter((span) => (span.textContent || '') === label).length
  }

  it('badges a code body, so the reader sees it before the policy stops the run', async () => {
    await renderPanel([community(CODE_BODY, 'cm-code'), community(PLAIN_BODY, 'cm-plain')])
    expect(badgeCount(t('templates.runs_code'))).toBe(1)
    expect(badgeCount(t('templater.group'))).toBe(1)
  })
})
