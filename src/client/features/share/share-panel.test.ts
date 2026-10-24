// @vitest-environment jsdom
/**
 * The single-note share panel's opening.
 *
 * The panel has no test at all today, and the one thing a panel like this gets wrong is the transition
 * out of "loading": if the answer that arrives is thrown away, the owner stares at a spinner forever and
 * the create button never exists. That is not hypothetical — the panel hangs on a real instance that
 * answers `200 {"share":null}` promptly, which is the shape of a note that has never been shared.
 *
 * So every case here asserts the same thing from a different angle: after the read settles, the panel
 * says something about the *link*, not about the wait.
 */
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary, ShareInfo } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { SharePanel } from './SharePanel'

const get = vi.hoisted(() => vi.fn())
const create = vi.hoisted(() => vi.fn())
const remove = vi.hoisted(() => vi.fn())

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    share: {
      get: (noteId: string, signal?: AbortSignal) => get(noteId, signal),
      create: (noteId: string, body: unknown) => create(noteId, body),
      remove: (noteId: string) => remove(noteId),
    },
  },
}))

let root: Root
let host: HTMLElement

const NOTE = { id: 'n1', title: 'Pond survey' }

function shareOf(over: Partial<ShareInfo> = {}): ShareInfo {
  return {
    slug: 'slug1',
    noteId: 'n1',
    url: 'https://notes.test/s/slug1',
    hasPassword: false,
    expiresAt: null,
    views: 0,
    createdAt: 1,
    isEnabled: true,
    lastViewedAt: null,
    folderId: null,
    tags: [],
    ...over,
  }
}

async function open(options: { strict?: boolean; viaStore?: boolean } = {}): Promise<void> {
  if (options.viaStore) {
    useUi.setState({ activeNoteId: 'n1' })
    useNotes.setState({ notes: { n1: NOTE as NoteSummary } })
  }
  const panel = createElement(SharePanel, {
    onClose: () => {},
    ...(options.viaStore ? {} : { targetNote: NOTE }),
  })
  await act(async () => {
    root.render(options.strict ? createElement(StrictMode, null, panel) : panel)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function settled(): string {
  const text = document.body.textContent ?? ''
  expect(text, 'the panel is still spinning after the read answered').not.toContain(t('share.loading_share_status'))
  return text
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  get.mockReset()
  create.mockReset()
  remove.mockReset()
  useUi.setState({ activeNoteId: null })
  useNotes.setState({ notes: {} })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('opening the panel', () => {
  it('leaves the loading state when the note has never been shared', async () => {
    get.mockResolvedValue({ share: null })
    await open()
    expect(settled()).toContain(t('share.generate_public_link'))
  })

  it('shows the existing link when there is one', async () => {
    get.mockResolvedValue({ share: shareOf() })
    await open()
    const link = document.querySelector('input[readonly]')
    expect(link, 'no link row rendered').toBeTruthy()
    expect((link as HTMLInputElement).value).toBe('https://notes.test/s/slug1')
  })

  it('reports a failed read instead of waiting forever', async () => {
    get.mockRejectedValue(new Error('offline'))
    await open()
    expect(document.body.textContent ?? '').toContain(t('share.could_not_load_sharing_status'))
  })
})

describe('how the shell actually mounts it', () => {
  // AppShell renders `<SharePanel onClose=... />` with no note prop, so the panel resolves the note
  // from the active-note store. And main.tsx wraps the app in StrictMode, which mounts every effect,
  // tears it down, and mounts it again without re-rendering in between — so anything the teardown
  // writes to a ref has to be repaired by the second setup, not by a render.
  it('reads the share of the active note', async () => {
    get.mockResolvedValue({ share: null })
    await open({ viaStore: true })
    expect(settled()).toContain(t('share.generate_public_link'))
    expect(get.mock.calls.map((call) => call[0])).toEqual(['n1'])
  })

  it('reads it once per mount under StrictMode', async () => {
    get.mockResolvedValue({ share: null })
    await open({ strict: true, viaStore: true })
    expect(settled()).toContain(t('share.generate_public_link'))
  })

  it('shows the existing link under StrictMode', async () => {
    get.mockResolvedValue({ share: shareOf() })
    await open({ strict: true, viaStore: true })
    settled()
    const link = document.querySelector('input[readonly]')
    expect(link, 'no link row rendered').toBeTruthy()
    expect((link as HTMLInputElement).value).toBe('https://notes.test/s/slug1')
  })
})
