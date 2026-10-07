import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '@shared/constants'
import { initI18n, t } from '../../../../lib/i18n'
import { deleteKanbanFile, uploadKanbanFile } from '../upload'
import { installTestGlobals } from '../../../test-render'
import { KanbanFilesCell, KanbanFilesScope } from './kanban-files-cell'
import type { KanbanFile } from '../types'

const mocks = vi.hoisted(() => ({ toast: vi.fn(), confirm: vi.fn(async () => true) }))

vi.mock('../../../../components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../components/overlay')>()
  return { ...actual, confirm: mocks.confirm }
})

vi.mock('../upload', () => ({
  uploadKanbanFile: vi.fn(async (): Promise<KanbanFile> => ({
    id: 'up-1', name: 'a.txt', size: 1, mime: 'text/plain', url: '/api/files/up-1',
  })),
  deleteKanbanFile: vi.fn(async () => ({ ok: true })),
}))

vi.mock('../../../../store/ui', () => ({
  useUi: { getState: () => ({ toast: mocks.toast }) },
}))

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.mocked(uploadKanbanFile).mockClear()
  vi.mocked(deleteKanbanFile).mockClear()
  mocks.toast.mockClear()
  mocks.confirm.mockReset()
  mocks.confirm.mockResolvedValue(true)
})

const savedFile: KanbanFile = {
  id: 'f-1',
  name: 'report.pdf',
  size: 2048,
  mime: 'application/pdf',
  url: '/api/files/att-7',
}

function renderCell(files: KanbanFile[], wrapperValue?: string) {
  installTestGlobals()
  const onChangeFiles = vi.fn()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const cell = createElement(KanbanFilesCell, { files, onChangeFiles })
  act(() => {
    root.render(wrapperValue
      ? createElement(KanbanFilesScope.Provider, { value: wrapperValue }, cell)
      : cell)
  })
  return { container, root, onChangeFiles }
}

function deleteButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`button[title="${t('preview.kanban_delete_file')}"]`)!
}

describe('kanban file delete wiring', () => {
  it('asks the store to delete a file it holds, by the id its url carries', async () => {
    vi.mocked(deleteKanbanFile).mockClear()
    const { container, root, onChangeFiles } = renderCell([savedFile])
    await act(async () => { deleteButton(container).click() })
    expect(onChangeFiles).toHaveBeenNthCalledWith(1, [])
    expect(deleteKanbanFile).toHaveBeenCalledWith(savedFile)
    act(() => root.unmount())
    container.remove()
  })

  it('drops the reference only for a file hosted outside this app', async () => {
    vi.mocked(deleteKanbanFile).mockClear()
    const remote = { ...savedFile, url: 'https://cdn.example.com/a.png' }
    const { container, root, onChangeFiles } = renderCell([remote])
    await act(async () => { deleteButton(container).click() })
    expect(onChangeFiles).toHaveBeenCalledTimes(1)
    expect(deleteKanbanFile).not.toHaveBeenCalled()
    // Nothing is stored here, so there is no permanent delete to warn about.
    expect(mocks.confirm).not.toHaveBeenCalled()
    act(() => root.unmount())
    container.remove()
  })

  it('restores the reference and toasts when the server refuses the delete', async () => {
    vi.mocked(deleteKanbanFile).mockRejectedValueOnce(new Error('offline'))
    const { container, root, onChangeFiles } = renderCell([savedFile])
    await act(async () => { deleteButton(container).click() })
    expect(onChangeFiles).toHaveBeenNthCalledWith(2, [savedFile])
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
    container.remove()
  })
})

describe('kanban file delete confirmation', () => {
  it('spells out the permanent delete before the object is touched', async () => {
    const { container, root } = renderCell([savedFile])
    await act(async () => { deleteButton(container).click() })
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: t('preview.kanban_delete_file_value0', { value0: 'report.pdf' }),
      description: t('preview.kanban_delete_file_confirm_description'),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    expect(deleteKanbanFile).toHaveBeenCalledWith(savedFile)
    act(() => root.unmount())
    container.remove()
  })

  it('keeps both the reference and the stored object when the user cancels', async () => {
    mocks.confirm.mockResolvedValueOnce(false)
    const { container, root, onChangeFiles } = renderCell([savedFile])
    await act(async () => { deleteButton(container).click() })
    expect(onChangeFiles).not.toHaveBeenCalled()
    expect(deleteKanbanFile).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
    act(() => root.unmount())
    container.remove()
  })

  it('reports the delete once the object is gone', async () => {
    const { container, root } = renderCell([savedFile])
    await act(async () => { deleteButton(container).click() })
    expect(mocks.toast).toHaveBeenCalledWith({ title: t('preview.kanban_file_deleted'), tone: 'success' })
    act(() => root.unmount())
    container.remove()
  })
})

/** A file whose declared size is the point of the case, without allocating the bytes for it. */
function fileSized(name: string, size: number): File {
  const file = new File(['hi'], name, { type: 'application/octet-stream' })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

async function chooseFiles(container: HTMLElement, files: File[]): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
}

const imageFile: KanbanFile = {
  id: 'f-2',
  name: 'shot.png',
  size: 4096,
  mime: 'image/png',
  url: '/api/kanban/file/default/8-shot.png',
}

function coverButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === label,
  )
}

describe('kanban cover actions', () => {
  it('offers the cover action only where a cover can come from, and reports the url chosen', async () => {
    installTestGlobals()
    const onChangeCover = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => {
      root.render(createElement(KanbanFilesCell, {
        files: [savedFile, imageFile],
        onChangeFiles: vi.fn(),
        onChangeCover,
      }))
    })
    try {
      const setCover = coverButton(container, t('preview.kanban_set_cover', { value0: 'shot.png' }))
      expect(setCover, 'an image offered no way to become the cover').toBeDefined()
      expect(coverButton(container, t('preview.kanban_set_cover', { value0: 'report.pdf' }))).toBeUndefined()
      await act(async () => { setCover!.click() })
      expect(onChangeCover).toHaveBeenCalledWith(imageFile.url)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

})

describe('kanban cover actions on the row that holds the cover', () => {
  it('is marked as pressed and clears it from there', async () => {
    installTestGlobals()
    const onChangeCover = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => {
      root.render(createElement(KanbanFilesCell, {
        files: [imageFile],
        onChangeFiles: vi.fn(),
        cover: imageFile.url,
        onChangeCover,
      }))
    })
    try {
      const remove = coverButton(container, t('preview.kanban_remove_cover', { value0: 'shot.png' }))
      expect(remove, 'the cover could not be removed from the row that holds it').toBeDefined()
      expect(remove!.getAttribute('aria-pressed')).toBe('true')
      await act(async () => { remove!.click() })
      expect(onChangeCover).toHaveBeenCalledWith(undefined)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('shows no cover action to a host that cannot store one', () => {
    const { container } = renderCell([imageFile])
    expect(coverButton(container, t('preview.kanban_set_cover', { value0: 'shot.png' }))).toBeUndefined()
  })
})

describe('kanban file upload size guard', () => {
  it('does not send a file the server is going to refuse, and names the limit', async () => {
    const { container, root } = renderCell([])
    await chooseFiles(container, [fileSized('huge.bin', LIMITS.attachmentMaxBytes + 1)])
    expect(uploadKanbanFile, 'an over-limit file was uploaded anyway').not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith({
      title: t('preview.kanban_file_too_large', { value1: String(LIMITS.attachmentMaxBytes / (1024 * 1024)) }),
      description: 'huge.bin',
      tone: 'danger',
    })
    act(() => root.unmount())
    container.remove()
  })

  it('uploads what fits and reports only the file that does not', async () => {
    const { container, root, onChangeFiles } = renderCell([])
    await chooseFiles(container, [fileSized('ok.txt', 1024), fileSized('huge.bin', LIMITS.attachmentMaxBytes + 1)])
    expect(vi.mocked(uploadKanbanFile)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(uploadKanbanFile).mock.calls[0][0].name).toBe('ok.txt')
    expect(onChangeFiles).toHaveBeenCalledTimes(1)
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
    container.remove()
  })

  it('keeps quiet about a file that is exactly at the limit', async () => {
    const { container, root } = renderCell([])
    await chooseFiles(container, [fileSized('edge.bin', LIMITS.attachmentMaxBytes)])
    expect(vi.mocked(uploadKanbanFile)).toHaveBeenCalledTimes(1)
    expect(mocks.toast).not.toHaveBeenCalled()
    act(() => root.unmount())
    container.remove()
  })
})

describe('kanban file upload namespace', () => {
  it('uploads into the board namespace from context', async () => {
    const { container, root } = renderCell([], 'note-9')
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', {
      value: [new File(['hi'], 'a.txt', { type: 'text/plain' })],
      configurable: true,
    })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(vi.mocked(uploadKanbanFile).mock.calls[0][1]).toBe('note-9')
    act(() => root.unmount())
    container.remove()
  })

  it('falls back to default when no board namespace is provided', async () => {
    const { container, root } = renderCell([])
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', {
      value: [new File(['hi'], 'a.txt', { type: 'text/plain' })],
      configurable: true,
    })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(vi.mocked(uploadKanbanFile).mock.calls[0][1]).toBe('default')
    act(() => root.unmount())
    container.remove()
  })
})
