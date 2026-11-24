import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { api } from '../src/client/lib/api'
import { DataSettings } from '../src/client/features/settings/DataSettings'

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  pull: vi.fn(),
}))

vi.mock('../src/client/lib/api', () => ({
  api: {
    notes: { clipUrl: vi.fn(), create: vi.fn() },
    transfer: {},
    reindex: vi.fn(),
    files: {},
  },
}))
vi.mock('../src/client/features/settings/resource', () => ({
  useSettingsResource: () => [{
    notes: 0, folders: 0, tags: 0, links: 0, words: 0, versions: 0, attachments: 0, trashed: 0, attachmentBytes: 0,
  }, vi.fn()],
}))
vi.mock('../src/client/features/settings/resources', () => ({
  statsResource: { load: vi.fn(async () => undefined) },
}))
vi.mock('../src/client/store/ui', () => ({
  useUi: (selector: (state: { toast: typeof mocks.toast }) => unknown) => selector({ toast: mocks.toast }),
}))
vi.mock('../src/client/store/notes', () => ({
  useNotes: (selector: (state: { emptyTrash: () => Promise<number>; pull: typeof mocks.pull }) => unknown) =>
    selector({ emptyTrash: vi.fn(), pull: mocks.pull }),
}))
vi.mock('../src/client/store/note-templates', () => ({
  useNoteTemplates: { getState: () => ({ reloadFromAccount: vi.fn() }) },
}))
vi.mock('../src/client/store/session', () => ({
  useSession: { getState: () => ({ user: { id: 'user-clip' } }) },
}))
vi.mock('../src/client/lib/backup-import', () => ({ restoreMarkdownBackupFolder: vi.fn() }))
vi.mock('../src/client/components/overlay', () => ({ confirm: vi.fn() }))

let root: Root
let container: HTMLDivElement
const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  await initI18n()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function submitUrl(url: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="url"]')!
  await act(() => {
    setInputValue.call(input, url)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

describe('Settings URL clip', () => {
  it('resolves links against the final URL, creates a note, and pulls the refreshed list', async () => {
    vi.mocked(api.notes.clipUrl).mockResolvedValue({
      title: 'Example',
      url: 'https://example.com/final/article',
      html: '<h1>Example</h1><p><a href="../docs">Docs</a> <a href="/root">Root</a></p>',
    })
    vi.mocked(api.notes.create).mockResolvedValue({ id: 'note-1', title: 'Example' } as Awaited<ReturnType<typeof api.notes.create>>)
    mocks.pull.mockResolvedValue(undefined)

    await act(() => root.render(createElement(DataSettings)))
    await submitUrl('https://example.com/start')

    expect(api.notes.clipUrl).toHaveBeenCalledWith('https://example.com/start')
    expect(api.notes.create).toHaveBeenCalledWith({
      title: 'Example',
      content: '# Example\n\n[Docs](https://example.com/docs) [Root](https://example.com/root)',
    })
    expect(mocks.pull).toHaveBeenCalledWith({ force: true })
    expect(mocks.toast).toHaveBeenCalledWith({ title: t('settings.url_clip_success'), description: 'Example', tone: 'success' })
  })

  it('reports a clip failure without creating a note or pulling', async () => {
    vi.mocked(api.notes.clipUrl).mockRejectedValue(new Error('Blocked URL'))

    await act(() => root.render(createElement(DataSettings)))
    await submitUrl('https://example.com/blocked')

    expect(api.notes.create).not.toHaveBeenCalled()
    expect(mocks.pull).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith({ title: t('settings.url_clip_failed'), description: 'Blocked URL', tone: 'danger' })
  })
})
