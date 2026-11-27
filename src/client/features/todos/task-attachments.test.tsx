// @vitest-environment jsdom
/**
 * The saved task's attachment shelf.
 *
 * These cases drive the shelf at its HTTP and component boundaries: a read on mount, an explicit
 * loading/empty/error/retry sequence, the shared upload helper followed by a refresh, the project's
 * preview/download door, and an unlink whose failure leaves the row in place. The editor cases pin
 * the other half of the contract: a draft has no attachment shelf and asks for no task files.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import type { Attachment } from '@shared/types'
import type { TodoTask } from '@shared/todos/model'

vi.mock('../../lib/export-note', () => ({
  downloadTextFile: vi.fn(),
  downloadBlob: vi.fn(),
  safeFileName: (name: string) => name,
  exportNoteAsHtml: vi.fn(),
  exportNoteAsMarkdown: vi.fn(),
  exportNoteAsPdf: vi.fn(),
}))
vi.mock('katex/dist/katex.min.css?inline', () => ({ default: '' }))

const service = vi.hoisted(() => ({
  attachments: vi.fn(),
  uploadAttachment: vi.fn(),
  removeAttachment: vi.fn(),
  get: vi.fn(),
}))

vi.mock('../../lib/api', () => ({ api: { todos: service } }))
vi.mock('../file-preview', () => ({
  FilePreviewModal: ({ open, file }: { open: boolean; file: { filename: string; url: string } }) => open
    ? <div role="dialog" data-testid="file-preview" data-url={file.url}>{file.filename}</div>
    : null,
}))

import { TaskAttachments } from './TaskAttachments'
import { TaskEditor } from './TaskEditor'
import { useTodos } from './store'

const original = useTodos.getState()
let view: RenderedElement | null = null

function task(id: string, title = 'Saved task'): TodoTask {
  return {
    id,
    title,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    remindedAt: null,
    plannedFor: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: null,
    tags: [],
    parentId: null,
    dependsOn: [],
    blocks: [],
    starred: false,
    repeat: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
  }
}

function attachment(id = 'file-1', filename = 'notes.txt'): Attachment {
  return {
    id,
    noteId: null,
    filename,
    mime: filename.endsWith('.pdf') ? 'application/pdf' : 'text/plain',
    size: 2048,
    width: null,
    height: null,
    url: `/api/files/${id}`,
    createdAt: 0,
  }
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.attachments.mockReset().mockResolvedValue({ attachments: [] })
  service.uploadAttachment.mockReset().mockImplementation(async (_taskId: string, file: File) => ({
    attachment: attachment('uploaded', file.name),
  }))
  service.removeAttachment.mockReset().mockResolvedValue({ deleted: true })
  service.get.mockReset().mockImplementation(async (id: string) => ({ task: task(id), steps: [] }))
  useTodos.setState(original, true)
  useUi.setState({ toasts: [] })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  useUi.setState({ toasts: [] })
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

function section(): HTMLElement {
  const node = [...document.querySelectorAll<HTMLElement>('section')]
    .find((entry) => entry.getAttribute('aria-label') === t('attachments.all_files'))
  if (!node) throw new Error('the attachment shelf is not rendered')
  return node
}

function button(label: string): HTMLButtonElement {
  const node = [...section().querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => entry.getAttribute('aria-label') === label || (entry.textContent ?? '').trim() === label)
  if (!node) throw new Error(`the attachment shelf offers no ${label} button`)
  return node
}

async function mountAttachments(files: Attachment[] = []): Promise<void> {
  service.attachments.mockResolvedValue({ attachments: files })
  view = renderElement(createElement(TaskAttachments, { taskId: 't1' }))
  await settle()
}

function openEditor(draft: Record<string, unknown>, tasks: TodoTask[]): void {
  act(() => {
    useTodos.setState({
      status: 'ready',
      editorOpen: true,
      draft,
      tasks,
      completed: [],
      lists: [],
      tags: [],
      timezone: 'UTC',
      saving: false,
    })
  })
  view = renderElement(createElement(TaskEditor))
}

describe('a saved task’s attachments', () => {
  it('reads on mount and distinguishes loading from an empty list', async () => {
    let resolve!: (answer: { attachments: Attachment[] }) => void
    service.attachments.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    view = renderElement(createElement(TaskAttachments, { taskId: 't1' }))

    expect(service.attachments).toHaveBeenCalledWith('t1')
    expect(section().textContent).toContain(t('common.loading'))
    expect(section().textContent).not.toContain(t('attachments.empty_files'))

    await act(async () => { resolve({ attachments: [] }) })
    await settle()

    expect(section().textContent).toContain(t('attachments.empty_files'))
    expect(section().querySelector('[role="status"]')).toBeNull()
  })

  it('says a read failed and retries the same task', async () => {
    service.attachments.mockRejectedValueOnce(new Error('The connection went away'))
    view = renderElement(createElement(TaskAttachments, { taskId: 't1' }))
    await settle()

    const alert = section().querySelector('[role="alert"]')
    expect(alert?.textContent).toContain(t('attachments.load_failed'))
    expect(alert?.textContent).toContain('The connection went away')
    expect(section().textContent).not.toContain(t('attachments.empty_files'))

    await act(async () => { button(t('common.retry')).click() })
    await settle()

    expect(service.attachments).toHaveBeenCalledTimes(2)
    expect(section().textContent).toContain(t('attachments.empty_files'))
  })

  it('uploads through the shared helper and refreshes the list', async () => {
    service.attachments
      .mockResolvedValueOnce({ attachments: [] })
      .mockResolvedValueOnce({ attachments: [attachment('uploaded', 'new.txt')] })
    view = renderElement(createElement(TaskAttachments, { taskId: 't1' }))
    await settle()

    const file = new File(['contents'], 'new.txt', { type: 'text/plain' })
    const input = section().querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    const liveFiles = [file]
    Object.defineProperty(input, 'files', { configurable: true, get: () => liveFiles })
    Object.defineProperty(input, 'value', { configurable: true, set: () => { liveFiles.length = 0 } })
    await act(async () => { input!.dispatchEvent(new Event('change', { bubbles: true })) })
    await settle()

    expect(service.uploadAttachment).toHaveBeenCalledWith('t1', file)
    expect(service.attachments).toHaveBeenCalledTimes(2)
    expect(section().textContent).toContain('new.txt')
  })

  it('opens the shared preview and exposes the stored-file download URL', async () => {
    await mountAttachments([attachment('pdf-1', 'report.pdf')])

    const download = section().querySelector<HTMLAnchorElement>('a[download="report.pdf"]')
    expect(download?.getAttribute('href')).toBe('/api/files/pdf-1')
    expect(download?.getAttribute('aria-label')).toBe(`${t('common.download')}: report.pdf`)

    act(() => { button(`${t('common.preview')}: report.pdf`).click() })

    const preview = document.querySelector<HTMLElement>('[data-testid="file-preview"]')
    expect(preview?.textContent).toBe('report.pdf')
    expect(preview?.getAttribute('data-url')).toBe('/api/files/pdf-1')
  })

  it('removes the row only after the task link is gone', async () => {
    await mountAttachments([attachment()])

    await act(async () => { button(`${t('common.remove')}: notes.txt`).click() })
    await settle()

    expect(service.removeAttachment).toHaveBeenCalledWith('t1', 'file-1')
    expect(section().textContent).not.toContain('notes.txt')
    expect(section().textContent).toContain(t('attachments.empty_files'))
  })

  it('keeps the row and reports the reason when unlinking fails', async () => {
    service.removeAttachment.mockRejectedValueOnce(new Error('The link is still in use'))
    await mountAttachments([attachment()])

    await act(async () => { button(`${t('common.remove')}: notes.txt`).click() })
    await settle()

    expect(section().textContent).toContain('notes.txt')
    expect(useUi.getState().toasts.at(-1)).toMatchObject({
      title: t('common.action_failed'),
      description: 'The link is still in use',
      tone: 'danger',
    })
    expect(button(`${t('common.remove')}: notes.txt`).disabled).toBe(false)
  })
})

describe('the todos attachment API', () => {
  it('uses the task routes for upload, list and unlink', async () => {
    const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init })
      const body = init?.method === 'POST'
        ? { attachment: attachment('uploaded', 'new.txt') }
        : init?.method === 'DELETE'
          ? { deleted: true }
          : { attachments: [attachment()] }
      return new Response(JSON.stringify(body), {
        status: init?.method === 'POST' ? 201 : 200,
        headers: { 'content-type': 'application/json' },
      })
    }))

    const file = new File(['contents'], 'new.txt', { type: 'text/plain' })
    const uploaded = await actual.api.todos.uploadAttachment('task/1', file)
    const listed = await actual.api.todos.attachments('task/1')
    const removed = await actual.api.todos.removeAttachment('task/1', 'file/1')

    expect(uploaded.attachment.id).toBe('uploaded')
    expect(listed.attachments.map((entry) => entry.id)).toEqual(['file-1'])
    expect(removed).toEqual({ deleted: true })
    expect(calls.map((call) => call.path)).toEqual([
      '/api/todos/task%2F1/attachments',
      '/api/todos/task%2F1/attachments',
      '/api/todos/task%2F1/attachments/file%2F1',
    ])
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.body).toBeInstanceOf(FormData)
    expect((calls[0]!.init?.body as FormData).get('file')).toBe(file)
    expect(calls[2]!.init?.method).toBe('DELETE')
  })
})

describe('the editor’s attachment shelf', () => {
  it('mounts and reads the list for an existing task', async () => {
    service.attachments.mockResolvedValue({ attachments: [attachment()] })
    openEditor({ id: 't1' }, [task('t1')])
    await settle()

    expect(service.attachments).toHaveBeenCalledWith('t1')
    expect(section().textContent).toContain('notes.txt')
  })

  it('does not mount or read attachments for a new task', async () => {
    openEditor({ title: 'A draft' }, [])
    await settle()

    expect(service.attachments).not.toHaveBeenCalled()
    expect([...document.querySelectorAll<HTMLElement>('section')]
      .some((entry) => entry.getAttribute('aria-label') === t('attachments.all_files'))).toBe(false)
  })
})
