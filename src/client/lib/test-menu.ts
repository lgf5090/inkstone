/**
 * Driving a `SelectMenu` the way a reader does: press the trigger, then press the row.
 *
 * A test that sets `.value` on a `<select>` and fires `change` is testing the browser's control, not
 * this app's. The menu is a button plus a portalled list, so the same gesture is two clicks — and that
 * is what these helpers do, so a case reads the way the screen behaves.
 */
import { act } from 'react'

/** The trigger a select-menu draws, found by the accessible name it was given. */
export function selectTrigger(container: HTMLElement, label: string): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')]
    .find((node) => node.getAttribute('aria-label') === label) ?? null
}

/** The label a select-menu currently shows, or null when there is no such control. */
export function selectedLabel(container: HTMLElement, label: string): string | null {
  const trigger = selectTrigger(container, label)
  if (!trigger) return null
  return (trigger.textContent ?? '').trim()
}

/** Opens the menu and presses the row whose text is `option`. */
export async function chooseOption(container: HTMLElement, label: string, option: string): Promise<void> {
  const trigger = selectTrigger(container, label)
  if (!trigger) throw new Error(`no select named "${label}"`)
  await act(async () => {
    trigger.click()
    await Promise.resolve()
  })
  const row = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')]
    .find((node) => (node.textContent ?? '').trim() === option)
  if (!row) throw new Error(`no option "${option}" in "${label}"`)
  await act(async () => {
    row.click()
    await Promise.resolve()
  })
}
