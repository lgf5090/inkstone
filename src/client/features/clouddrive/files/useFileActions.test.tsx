// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import type { FileActions, FileListChange } from './useFileActions'

const api = vi.hoisted(() => ({ move: vi.fn(), restore: vi.fn(), copy: vi.fn() }))
const toast = vi.hoisted(() => vi.fn())

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, clouddriveApi: { ...actual.clouddriveApi, ...api } }
})
vi.mock('../../../store/ui', () => ({ useUi: { getState: () => ({ toast }) } }))
vi.mock('../store', () => ({
  useCloudDriveStore: (selector: (state: { prefs: { uploadConflict: string } }) => unknown) =>
    selector({ prefs: { uploadConflict: 'rename' } }),
}))

import { useFileActions } from './useFileActions'

let view: RenderedElement | null = null
let actions: FileActions | null = null

function Harness({ changes, refresh }: { changes: FileListChange[]; refresh: () => void }) {
  actions = useFileActions({ mountId: 'primary', refresh, onLocalChange: (change) => changes.push(change) })
  return null
}

beforeEach(async () => {
  await initI18n()
  api.move.mockReset()
  api.copy.mockReset()
  api.restore.mockReset()
  toast.mockReset()
})

afterEach(() => {
  act(() => view?.unmount())
  view = null
  actions = null
})

describe('useFileActions partial transfers', () => {
  it('removes only successfully moved rows from a 207 response', async () => {
    api.move.mockResolvedValue({ results: [{ id: 'ok', ok: true }, { id: 'bad', ok: false, error: 'conflict' }] })
    const changes: FileListChange[] = []
    const refresh = vi.fn()
    view = renderElement(createElement(Harness, { changes, refresh }))
    await act(async () => { await actions!.move(['ok', 'bad'], '/target') })
    expect(changes).toEqual([{ type: 'remove', ids: ['ok'] }])
    expect(refresh).toHaveBeenCalledOnce()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger' }))
  })

  it('forwards the selected destination mount for cross-mount copy', async () => {
    api.copy.mockResolvedValue({ results: [{ id: 'ok', ok: true, toPath: '/ok.txt' }] })
    view = renderElement(createElement(Harness, { changes: [], refresh: vi.fn() }))
    await act(async () => { await actions!.copy(['ok'], '/', 'archive') })
    expect(api.copy).toHaveBeenCalledWith({ ids: ['ok'], mountId: 'primary', toMountId: 'archive', toPath: '/', conflict: 'rename' })
  })

  it('reports restored count rather than requesting count after partial restore', async () => {
    api.restore.mockResolvedValue({ results: [{ id: 'ok', ok: true }, { id: 'bad', ok: false, error: 'not_found' }] })
    view = renderElement(createElement(Harness, { changes: [], refresh: vi.fn() }))
    await act(async () => { await actions!.restore(['ok', 'bad']) })
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger' }))
  })
})
