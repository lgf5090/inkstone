/**
 * The view switcher's state, made visible to assistive technology.
 *
 * DayFlow's switcher buttons carry only `data-active` for the current view, which styles the tab and
 * tells a screen reader nothing: a reader hears five identical buttons and cannot tell which view they
 * are looking at. The buttons are the library's, so this mirrors the state into `aria-pressed` instead
 * of replacing the control — an attribute the library never reads, which keeps its own handlers intact.
 */
export const VIEW_SWITCHER_BUTTON = '.df-view-switcher-btn'
const VIEW_SWITCHER_BAR = '.df-view-switcher'

/** Mirror each button's `data-active` into `aria-pressed`; returns how many buttons were touched. */
export function syncViewSwitcherPressed(root: ParentNode): number {
  const buttons = root.querySelectorAll<HTMLElement>(VIEW_SWITCHER_BUTTON)
  for (const button of buttons) {
    button.setAttribute('aria-pressed', button.dataset.active === 'true' ? 'true' : 'false')
  }
  return buttons.length
}

/**
 * Keep the mirror current for as long as the calendar is mounted.
 *
 * The library re-renders the bar on every view change and rewrites `data-active`; observing the
 * attribute is what keeps the announced state from drifting away from the drawn one.
 */
export function observeViewSwitcher(root: Document): () => void {
  syncViewSwitcherPressed(root)
  const bar = root.querySelector(VIEW_SWITCHER_BAR)
  if (!bar) return () => {}
  const observer = new MutationObserver(() => { syncViewSwitcherPressed(root) })
  observer.observe(bar, { attributes: true, subtree: true, attributeFilter: ['data-active'] })
  return () => observer.disconnect()
}
