// @vitest-environment jsdom
/**
 * The chat file space on the assistant's Data tab.
 *
 * The uploads a reader makes in a chat are stored on their own account, outliving the conversation that
 * sent them, and until this section existed nothing in the interface could name them. What is pinned is
 * therefore the three states a reader has to be able to tell apart — a list still being read, a list that
 * came back empty, and a list that was refused — plus the arithmetic under the rows and the one destructive
 * action on them: a delete that asks first, and removes the row only when the answer was yes.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/assistant'
import { formatBytes } from '@shared/byte-format'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { ChatFileSpace } from './AssistantDataTab'
import { formatInZone } from './time-format'

const { chatFiles, deleteChatFile, confirmDialog, toast } = vi.hoisted(() => ({
  chatFiles: vi.fn(),
  deleteChatFile: vi.fn(),
  confirmDialog: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    assistant: {
      chatFiles: () => chatFiles(),
      deleteChatFile: (id: string) => deleteChatFile(id),
    },
  },
}))

vi.mock('../../components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/overlay')>()
  return { ...actual, confirm: (options: unknown) => confirmDialog(options) }
})

function file(over: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    id: 'f1',
    kind: 'file',
    filename: 'report.pdf',
    mime: 'application/pdf',
    size: 24_576,
    key: 'chat/files/report.pdf',
    createdAt: 1_700_000_000_000,
    ...over,
  }
}

let rendered: RenderedElement | null = null

const text = () => rendered!.container.textContent ?? ''
const buttons = () => [...rendered!.container.querySelectorAll<HTMLButtonElement>('button')]
const byAria = (name: string) => buttons().find((node) => node.getAttribute('aria-label') === name)
const status = () => rendered!.container.querySelector('[role="status"]')
const alert = () => rendered!.container.querySelector('[role="alert"]')

/** Lets the request's promise land and the state it writes render. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

async function mount(): Promise<void> {
  rendered?.unmount()
  rendered = renderElement(createElement(ChatFileSpace))
  await settle()
}

const originalToast = useUi.getState().toast

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useUi.setState({ toast })
  // Stated per case rather than carried over from the last one: a queued answer nobody consumed would
  // otherwise be spent on the next test's request.
  chatFiles.mockReset().mockResolvedValue({ files: [] })
  deleteChatFile.mockReset().mockResolvedValue({ deleted: true })
  confirmDialog.mockReset().mockResolvedValue(true)
  toast.mockReset()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  useUi.setState({ toast: originalToast })
})

describe('the file space', () => {
  it('says it is reading the list before it has the list', async () => {
    let release: ((value: { files: ChatAttachment[] }) => void) | null = null
    chatFiles.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    rendered = renderElement(createElement(ChatFileSpace))
    await act(async () => { await Promise.resolve() })
    expect(status(), 'the loading state is missing').toBeTruthy()
    expect(status()!.getAttribute('aria-label')).toBe(t('common.loading'))
    // A list still on its way is not a list that came back empty.
    expect(text()).not.toContain(t('assistant.settings.files_empty'))
    await act(async () => { release?.({ files: [] }) })
    expect(text()).toContain(t('assistant.settings.files_empty'))
  })

  it('names each stored file with its size and the moment it arrived', async () => {
    const row = file()
    chatFiles.mockResolvedValueOnce({ files: [row] })
    await mount()
    expect(text()).toContain(row.filename)
    expect(text()).toContain(formatBytes(row.size))
    expect(text()).toContain(formatInZone(row.createdAt))
    expect(text()).toContain(t('assistant.settings.files_summary', { count: 1, size: formatBytes(row.size) }))
  })

  it('tells an empty account apart from a refused read', async () => {
    await mount()
    expect(text()).toContain(t('assistant.settings.files_empty'))
    expect(alert()).toBeNull()

    chatFiles.mockRejectedValueOnce(new Error('the route is down'))
    await mount()
    // The failure is the settings screens' shared affordance, not a fourth shape drawn inline.
    expect(alert(), 'the refusal is not named').toBeTruthy()
    expect(alert()!.textContent).toContain(t('assistant.settings.files_failed'))
    expect(text()).not.toContain(t('assistant.settings.files_empty'))
    // A list that was refused does not go on spinning as though it were still on its way.
    expect(status()).toBeNull()
  })

  it('asks again when the reader presses retry', async () => {
    chatFiles.mockRejectedValueOnce(new Error('the route is down'))
    await mount()
    const retry = buttons().find((node) => node.textContent?.trim() === t('common.retry'))
    expect(retry, 'the refusal offers no retry').toBeTruthy()
    const asked = chatFiles.mock.calls.length
    chatFiles.mockResolvedValueOnce({ files: [file()] })
    await act(async () => { retry!.click() })
    await settle()
    expect(chatFiles.mock.calls.length).toBe(asked + 1)
    expect(alert()).toBeNull()
    expect(text()).toContain('report.pdf')
  })

  it('states the ceiling when the list is capped', async () => {
    // The route answers with its own default limit and no total, so a full page is the only sign a reader
    // has that anything was left out.
    const many = Array.from({ length: 60 }, (_unused, index) => file({ id: `f${index}`, filename: `file-${index}.pdf` }))
    chatFiles.mockResolvedValueOnce({ files: many })
    await mount()
    expect(text()).toContain(t('assistant.settings.files_capped', { limit: 60 }))
  })

  it('asks before deleting, and only takes the row away on a yes', async () => {
    chatFiles.mockResolvedValueOnce({ files: [file(), file({ id: 'f2', filename: 'photo.png', kind: 'image' })] })
    await mount()
    const label = t('assistant.settings.files_delete', { name: 'report.pdf' })
    expect(byAria(label), 'the delete action is missing').toBeTruthy()

    confirmDialog.mockResolvedValueOnce(false)
    await act(async () => { byAria(label)!.click() })
    await settle()
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger' }))
    expect(deleteChatFile).not.toHaveBeenCalled()
    expect(text()).toContain('report.pdf')

    confirmDialog.mockResolvedValueOnce(true)
    await act(async () => { byAria(label)!.click() })
    await settle()
    expect(deleteChatFile).toHaveBeenCalledWith('f1')
    expect(text()).not.toContain('report.pdf')
    // The other row is untouched: one delete removes one file.
    expect(text()).toContain('photo.png')
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: t('assistant.settings.files_deleted', { name: 'report.pdf' }),
      tone: 'success',
    }))
  })

  it('keeps the row when the delete itself was refused', async () => {
    chatFiles.mockResolvedValueOnce({ files: [file()] })
    await mount()
    deleteChatFile.mockRejectedValueOnce(new Error('the file would not go'))
    await act(async () => { byAria(t('assistant.settings.files_delete', { name: 'report.pdf' }))!.click() })
    await settle()
    expect(text()).toContain('report.pdf')
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger' }))
  })

  /**
   * What the toast says about the turns the file was quoted by.
   *
   * The route answers a delete with the number of message rows it had to take the reference out of, and a
   * file that was named by four turns is not the same fact as one that belonged to nothing — so the count
   * belongs in the sentence the reader is handed, not left in a response they never see.
   */
  it('says how many turns the deleted file was unlinked from', async () => {
    chatFiles.mockResolvedValueOnce({ files: [file()] })
    deleteChatFile.mockResolvedValueOnce({ deleted: true, referenced_by_turns: 4 })
    await mount()
    await act(async () => { byAria(t('assistant.settings.files_delete', { name: 'report.pdf' }))!.click() })
    await settle()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: t('assistant.settings.files_deleted_turns', { name: 'report.pdf', count: 4 }),
      tone: 'success',
    }))
  })

  it('claims a file was standalone only when the route said it was', async () => {
    chatFiles.mockResolvedValueOnce({ files: [file()] })
    deleteChatFile.mockResolvedValueOnce({ deleted: true, referenced_by_turns: 0 })
    await mount()
    await act(async () => { byAria(t('assistant.settings.files_delete', { name: 'report.pdf' }))!.click() })
    await settle()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: t('assistant.settings.files_deleted', { name: 'report.pdf' }),
    }))
  })
})
