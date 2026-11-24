import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { FileOpenHandler } from './FileOpenHandler'

const mocks = vi.hoisted(() => ({
  userId: 'user-1' as string | null,
  toast: vi.fn(),
  pull: vi.fn(async () => undefined),
  reload: vi.fn(async () => undefined),
  import: vi.fn(),
  prepare: vi.fn(),
}))

vi.mock('../../lib/i18n', () => ({ t: (key: string) => key }))
vi.mock('../../lib/api', () => ({ api: { transfer: { import: mocks.import } } }))
vi.mock('../../store/session', () => ({ useSession: () => mocks.userId }))
vi.mock('../../store/ui', () => ({ useUi: () => mocks.toast }))
vi.mock('../../store/notes', () => ({ useNotes: () => mocks.pull }))
vi.mock('../../store/note-templates', () => ({ useNoteTemplates: { getState: () => ({ reloadFromAccount: mocks.reload }) } }))
vi.mock('../settings/note-importers', () => ({ prepareNoteImport: mocks.prepare }))

let consumer: ((params: { files?: Array<{ getFile: () => Promise<File> }> }) => void) | null
let rendered: RenderedElement | undefined

beforeEach(() => {
  mocks.userId = 'user-1'
  mocks.toast.mockReset()
  mocks.pull.mockClear()
  mocks.reload.mockClear()
  mocks.import.mockReset().mockResolvedValue({
    createdNotes: 1,
    updatedNotes: 0,
    skippedNotes: 0,
    createdFolders: 0,
    createdAttachments: 0,
    skippedAttachments: 0,
    warnings: [],
  })
  mocks.prepare.mockReset().mockImplementation(async (files: File[]) => ({ files, format: 'original', warnings: [] }))
  consumer = null
  Object.defineProperty(window, 'launchQueue', {
    configurable: true,
    value: { setConsumer: (next: typeof consumer) => { consumer = next } },
  })
})

afterEach(() => {
  rendered?.unmount()
  rendered = undefined
  Reflect.deleteProperty(window, 'launchQueue')
})

describe('PWA file open handler', () => {
  it('registers after authentication and routes launched files through the normal importer', async () => {
    rendered = renderElement(<FileOpenHandler />)
    expect(consumer).toBeTypeOf('function')
    const file = new File(['# Launched'], 'launched.md', { type: 'text/markdown' })
    await act(async () => {
      consumer?.({ files: [{ getFile: async () => file }] })
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(mocks.import).toHaveBeenCalledWith([file]))
    expect(mocks.prepare).toHaveBeenCalledWith([file])
    expect(mocks.pull).toHaveBeenCalledWith({ force: true })
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'settings.import_completed', tone: 'success' }))
  })

  it('does not register without a user and rejects a second concurrent launch visibly', async () => {
    mocks.userId = null
    rendered = renderElement(<FileOpenHandler />)
    expect(consumer).toBeNull()
    rendered.unmount()
    rendered = undefined
    mocks.userId = 'user-1'
    rendered = renderElement(<FileOpenHandler />)
    let release!: () => void
    mocks.import.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ createdNotes: 0, updatedNotes: 0, skippedNotes: 0, createdFolders: 0, createdAttachments: 0, skippedAttachments: 0, warnings: [] }) }))
    const file = new File(['# One'], 'one.md')
    await act(async () => {
      consumer?.({ files: [{ getFile: async () => file }] })
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(mocks.import).toHaveBeenCalledTimes(1))
    await act(async () => {
      consumer?.({ files: [{ getFile: async () => file }] })
      await Promise.resolve()
    })
    expect(mocks.import).toHaveBeenCalledTimes(1)
    expect(mocks.toast).toHaveBeenCalledWith({ title: 'settings.import_in_progress', tone: 'warning' })
    await act(async () => { release() })
  })
})
