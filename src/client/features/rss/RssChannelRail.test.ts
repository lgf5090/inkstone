/**
 * The channel rail's folder row: two controls in one box, and the pair has to stay two.
 *
 * The row used to be a `div` with a click handler wearing a chevron `span`, so a keyboard could not
 * reach either act and a screen reader read the folder as one unlabeled block. The row is a plain
 * container now, holding a disclosure button and a navigation button, and that split is exactly what
 * regresses quietly: a click that bubbles from the toggle into the row's own activation opens the
 * folder while trying to close it, and a toggle dropped out of the tab order leaves the children
 * unreachable. These cases hold the two acts apart, name both controls, and keep `aria-controls`
 * pointed at a region that exists even while the folder is shut.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { emptyLibrary, newFeed, newGroup } from '@shared/rss/model'
import { useRss } from './store'
import { RssChannelRail } from './RssChannelRail'

const GROUP = newGroup('folder-work', 'Work', 0)
const FEED = { ...newFeed('feed-example', 'https://example.com/feed.xml', 'Example', 0), groupId: GROUP.id }

let rendered: RenderedElement | null = null
const realOpen = useRss.getState().open

function rail(): HTMLElement {
  rendered = renderElement(createElement(RssChannelRail))
  return rendered.container
}

/** The folder's own row, which is the only thing holding its two buttons. */
function folderRow(container: HTMLElement): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-menu-target="group:${GROUP.id}"]`)
  if (!row) throw new Error('the folder row is not on the rail')
  return row
}

function toggleOf(row: HTMLElement): HTMLButtonElement {
  return row.querySelector<HTMLButtonElement>('button[aria-expanded]')!
}

function collapsedState(): boolean {
  return useRss.getState().library.groups.some(group => group.id === GROUP.id && group.collapsed)
}

function click(element: Element): void {
  act(() => {
    (element as HTMLElement).click()
  })
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  useRss.getState().reset()
  useRss.setState({
    library: { ...emptyLibrary(), groups: [{ ...GROUP, collapsed: true }], feeds: [FEED] },
    open: vi.fn(async () => {}),
  })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  useRss.setState({ open: realOpen })
  useRss.getState().reset()
})

describe('RssChannelRail folder row', () => {
  it('names the collapse toggle and points it at the region it opens', () => {
    const container = rail()
    const toggle = toggleOf(folderRow(container))

    expect(toggle.textContent?.trim()).toBe('')
    // The name is the act the button performs, the state is what `aria-expanded` carries.
    expect(toggle.getAttribute('aria-label')).toBe(`Expand ${GROUP.name}`)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    const regionId = toggle.getAttribute('aria-controls')
    expect(regionId).toBeTruthy()
    // A region the toggle controls has to be in the DOM while it holds nothing, or the relation dangles.
    const region = document.getElementById(regionId!)
    expect(region).not.toBeNull()
    expect(region!.contains(toggle)).toBe(false)
  })

  it('opens a collapsed folder without activating it', () => {
    const container = rail()
    const row = folderRow(container)
    const toggle = toggleOf(row)

    expect(collapsedState()).toBe(true)
    click(toggle)

    expect(useRss.getState().open).not.toHaveBeenCalled()
    expect(collapsedState()).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe(`Collapse ${GROUP.name}`)
    const region = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(region.querySelector(`[data-menu-target="feed:${FEED.id}"]`)).not.toBeNull()
  })

  it('opens the folder from its own button without collapsing it', () => {
    const container = rail()
    const row = folderRow(container)
    const buttons = [...row.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons).toHaveLength(2)
    const go = buttons[1]!

    expect(go.getAttribute('aria-label')).toBeNull()
    expect(go.textContent).toContain(GROUP.name)
    click(go)

    expect(useRss.getState().open).toHaveBeenCalledTimes(1)
    expect(useRss.getState().open).toHaveBeenCalledWith({ kind: 'group', groupId: GROUP.id })
    expect(collapsedState()).toBe(true)
  })

  it('keeps the collapse toggle in the tab order ahead of the folder itself', () => {
    const container = rail()
    const row = folderRow(container)
    const toggle = toggleOf(row)

    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle.disabled).toBe(false)
    expect(toggle.tabIndex).toBe(0)
    act(() => toggle.focus())
    expect(document.activeElement).toBe(toggle)

    // What Enter and Space do to a focused button in a browser is a click on that button.
    click(toggle)
    expect(collapsedState()).toBe(false)
    expect(useRss.getState().open).not.toHaveBeenCalled()
  })
})
