export function groupTabButtons(group: HTMLElement): HTMLButtonElement[] {
  return [...group.querySelectorAll<HTMLButtonElement>('[data-tab-button]')]
    .filter((button) => button.closest('[data-tabs]') === group)
}

export function groupTabPanels(group: HTMLElement): HTMLElement[] {
  return [...group.querySelectorAll<HTMLElement>('[data-tab-panel]')]
    .filter((panel) => panel.closest('[data-tabs]') === group)
}

export function selectMarkdownTab(button: HTMLButtonElement): void {
  const tabs = button.closest<HTMLElement>('[data-tabs]')
  if (!tabs) return
  const index = button.dataset.tabButton
  // A nested group numbers its own panels from zero, so an outer click that reached inside
  // would relabel the inner buttons and hide the panel the inner group has selected.
  groupTabButtons(tabs).forEach((candidate) => {
    const selected = candidate === button
    candidate.setAttribute('aria-selected', String(selected))
    candidate.tabIndex = selected ? 0 : -1
  })
  groupTabPanels(tabs).forEach((panel) => {
    panel.hidden = panel.dataset.tabPanel !== index
  })
}

export function moveMarkdownTabFocus(button: HTMLButtonElement, key: string): void {
  const buttons = [
    ...(button.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[data-tab-button]') ?? []),
  ]
  if (!buttons.length) return
  const current = Math.max(0, buttons.indexOf(button))
  const index =
    key === 'Home'
      ? 0
      : key === 'End'
        ? buttons.length - 1
        : (current + (key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
  const next = buttons[index]!
  selectMarkdownTab(next)
  next.focus()
}
