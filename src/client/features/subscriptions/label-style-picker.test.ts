// @vitest-environment jsdom
/**
 * The caret promise the label's icon and colour board makes.
 *
 * The panel is portalled to the end of the body on purpose — inside the dialog it was clipped, and the
 * last three of the sixteen colours sat below the clip. Portalling is also what makes the Tab order wrong:
 * with focus left on the trigger, the first Tab goes to whatever follows the trigger in the dialog, and the
 * tiles the reader can see are nowhere near it. So the panel takes the caret when it opens and hands the
 * trigger back when it closes, which is what these two cases pin.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { LabelStylePicker } from './label-identity'

let host: HTMLDivElement
let root: Root | null = null

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

function mount(): HTMLButtonElement {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => {
    root!.render(createElement(LabelStylePicker, { kind: 'type', name: 'Streaming', onPick: () => {} }))
  })
  const trigger = host.querySelector<HTMLButtonElement>(`button[aria-label="${t('subscriptions.picker.icon')}"]`)
  expect(trigger, 'the picker trigger is not drawn').toBeTruthy()
  return trigger!
}

async function press(node: Element | null | undefined, what: string): Promise<void> {
  expect(node, `${what} is not rendered`).toBeTruthy()
  await act(async () => { node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

/**
 * The floating board itself, found through the one tile every reading of it has.
 *
 * The panel is a child of the body rather than of the trigger's subtree, so the reset tile is what tells
 * an open board from a closed one — and it is the same tile whether the reader is on the icon half or the
 * colour half.
 */
function board(): HTMLElement | null {
  const tile = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => !host.contains(node) && node.getAttribute('aria-label') === t('subscriptions.picker.reset'))
  return tile?.closest<HTMLElement>('div.fixed') ?? null
}

describe('the label style panel', () => {
  it('moves the caret into the tiles it just showed', async () => {
    const trigger = mount()
    await press(trigger, 'the picker trigger')

    const open = board()
    expect(open, 'the board did not open').toBeTruthy()
    expect(open!.contains(document.activeElement), 'the caret is outside the board the reader is looking at').toBe(true)
    expect(document.activeElement).not.toBe(trigger)
  })

  it('gives the caret back to the trigger when Escape closes it', async () => {
    const trigger = mount()
    await press(trigger, 'the picker trigger')
    expect(board()).toBeTruthy()

    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(board(), 'Escape left the board on screen').toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
