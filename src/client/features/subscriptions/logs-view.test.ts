import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { LogsView } from './LogsView'

let host: HTMLDivElement
let root: Root
beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('log filters', () => {
  it('applies a changed filter immediately', async () => {
    const onLoad = vi.fn()
    act(() => root.render(createElement(LogsView, {
      logs: { notify: [], schedule: [], loading: false, error: null },
      items: [],
      onLoad,
    })))
    const select = host.querySelector<HTMLSelectElement>('select[aria-label]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(select, 'today')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onLoad).toHaveBeenCalledTimes(2)
    expect(onLoad.mock.calls[1]?.[0]).toMatchObject({ since: expect.any(String) })
  })
})
