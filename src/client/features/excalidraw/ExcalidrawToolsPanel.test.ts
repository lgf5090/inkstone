import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../components/overlay', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../components/overlay')>(),
  prompt: vi.fn(),
}))

import { prompt } from '../../components/overlay'
import { initI18n, setLocale, t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { ExcalidrawToolsPanel } from './ExcalidrawToolsPanel'

let root: Root
let host: HTMLElement

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  await initI18n()
  await setLocale('zh-CN', false)
  vi.mocked(prompt).mockResolvedValue('%% no diagram here')
  vi.spyOn(useUi.getState(), 'toast').mockImplementation(() => 'toast')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ExcalidrawToolsPanel', () => {
  it('localizes the warning when Mermaid yields no elements', async () => {
    const api = {
      getAppState: () => ({}),
      getSceneElements: () => [],
      updateScene: vi.fn(),
    }
    act(() => {
      root.render(createElement(ExcalidrawToolsPanel, {
        open: true,
        onClose: vi.fn(),
        api,
        lib: {} as never,
        title: 'drawing.excalidraw',
        dark: false,
      }))
    })

    const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${t('excalidraw.mermaid_to_excalidraw')}"]`)
    expect(button).not.toBeNull()
    await act(async () => button!.click())

    expect(useUi.getState().toast).toHaveBeenCalledWith({
      title: t('excalidraw.mermaid_to_excalidraw'),
      description: t('excalidraw.no_elements_parsed'),
      tone: 'warning',
    })
    expect(t('excalidraw.no_elements_parsed')).toBe('未解析出任何元素')
    expect(api.updateScene).not.toHaveBeenCalled()
  })
})
