import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { ImportDialog } from './ImportDialog'
import * as api from './api'
import * as appHistory from '../../lib/app-history'
import { useProjectStore } from './store'

let view: RenderedElement
beforeEach(async () => { await initI18n() })
afterEach(() => { view?.unmount() })

async function render(): Promise<void> {
  await act(async () => { view = renderElement(createElement(ImportDialog, { onClose: vi.fn() })) })
}

async function submitFile(name: string, contents = '{"name":"T","lists":[],"cards":[]}'): Promise<void> {
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
  const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')!
  const file = new File([contents], name, { type: 'application/zip' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1]).buffer, configurable: true })
  Object.defineProperty(file, 'text', { value: async () => contents, configurable: true })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  const button = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === t('project.import.submit'))!
  await act(async () => { button.click() })
}

describe('import dialog routes by file extension', () => {
  it('sends a .boardarchive to the single-board importer and opens the board', async () => {
    const addBoard = vi.spyOn(useProjectStore.getState(), 'addBoardFromArchive').mockResolvedValue({ id: 'b1' } as never)
    const account = vi.spyOn(api, 'importProjectAccountArchive').mockResolvedValue([])
    const navigate = vi.spyOn(appHistory, 'navigateToPath').mockImplementation(() => {})
    await render()
    await submitFile('board.boardarchive')
    expect(addBoard).toHaveBeenCalledWith(new Uint8Array([1]))
    expect(account).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/project/boards/b1')
    addBoard.mockRestore()
    account.mockRestore()
    navigate.mockRestore()
  })

  it('sends a .zip to the account importer and reloads the board list', async () => {
    const account = vi.spyOn(api, 'importProjectAccountArchive').mockResolvedValue([])
    const addBoard = vi.spyOn(useProjectStore.getState(), 'addBoardFromArchive').mockResolvedValue({ id: 'b1' } as never)
    const load = vi.spyOn(useProjectStore.getState(), 'loadBoards').mockResolvedValue(undefined)
    await render()
    await submitFile('account.zip')
    expect(account).toHaveBeenCalledWith(new Uint8Array([1]))
    expect(addBoard).not.toHaveBeenCalled()
    expect(load).toHaveBeenCalled()
    account.mockRestore()
    addBoard.mockRestore()
    load.mockRestore()
  })

  it('still runs an external format through its converter', async () => {
    const account = vi.spyOn(api, 'importProjectAccountArchive').mockResolvedValue([])
    const addBoard = vi.spyOn(useProjectStore.getState(), 'addBoardFromArchive').mockResolvedValue({ id: 'b1' } as never)
    const navigate = vi.spyOn(appHistory, 'navigateToPath').mockImplementation(() => {})
    await render()
    await submitFile('trello.json')
    expect(account).not.toHaveBeenCalled()
    expect(addBoard).toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/project/boards/b1')
    account.mockRestore()
    addBoard.mockRestore()
    navigate.mockRestore()
  })
})
