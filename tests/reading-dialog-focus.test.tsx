// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useDialogFocus } from '../src/client/features/reading/reader/use-dialog-focus'
import { installTestGlobals } from '../src/client/lib/test-render'

let root: Root | null = null
let host: HTMLDivElement

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
})

describe('useDialogFocus', () => {
  it('moves focus into the dialog and returns it to the trigger', () => {
    installTestGlobals()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    let close = () => {}
    function Harness() {
      const [open, setOpen] = useState(false)
      close = () => setOpen(false)
      return createElement('div', null,
        createElement('button', { id: 'trigger', onClick: () => setOpen(true) }, 'open'),
        open ? createElement(Dialog) : null,
      )
    }
    function Dialog() {
      const ref = useDialogFocus<HTMLDivElement>()
      return createElement('div', { ref, role: 'dialog', tabIndex: -1 }, 'dialog')
    }
    act(() => root!.render(createElement(Harness)))
    const trigger = host.querySelector<HTMLButtonElement>('#trigger')!
    act(() => trigger.focus())
    act(() => trigger.click())
    expect(document.activeElement?.getAttribute('role')).toBe('dialog')
    act(() => close())
    expect(document.activeElement).toBe(trigger)
  })
})
