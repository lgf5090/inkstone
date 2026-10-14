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

/** The arrow key a reader presses: a bubbling keydown on the focused row, as a browser sends it. */
function press(element: HTMLElement, key: string): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function focus(element: HTMLElement): void {
  act(() => {
    element.focus()
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

/**
 * The shelf as a tree. The rail draws the same geometry it always drew, but a reader that cannot see
 * the indentation only has what the roles say: the nesting level of each row, whether a branch is
 * open, and — since the rows are `<button>`s inside a `role="treeitem"` rather than the tree items
 * themselves — an arrow key that walks the visible rows instead of leaving the list entirely.
 */
describe('RssChannelRail tree', () => {
  function tree(container: HTMLElement): HTMLElement {
    const element = container.querySelector<HTMLElement>('[role="tree"]')
    if (!element) throw new Error('the shelf has no tree')
    return element
  }

  function folderItem(container: HTMLElement): HTMLElement {
    const element = container.querySelector<HTMLElement>(`[role="treeitem"][aria-level="1"]`)
    if (!element) throw new Error('the folder is not a tree item')
    return element
  }

  function feedRowOf(container: HTMLElement): HTMLElement {
    const element = container.querySelector<HTMLElement>(`[data-tree-row][data-menu-target="feed:${FEED.id}"]`)
    if (!element) throw new Error('the feed is not on the rail')
    return element
  }

  function nameButton(container: HTMLElement): HTMLElement {
    const element = folderItem(container).querySelector<HTMLElement>('[data-tree-row]')
    if (!element) throw new Error('the folder row has no keyboard-navigable button')
    return element
  }

  it('states the level of every row and opens a group only while it holds one', () => {
    const container = rail()
    expect(tree(container).getAttribute('aria-label')).toBeTruthy()

    const item = folderItem(container)
    expect(item.getAttribute('aria-expanded')).toBe('false')
    expect(item.getAttribute('aria-posinset')).toBe('1')
    expect(item.getAttribute('aria-setsize')).toBe('1')
    // The region the toggle names is the branch, and a shut branch states no group.
    const region = document.getElementById(`${GROUP.id}-children`)!
    expect(region.hasAttribute('role')).toBe(false)

    click(toggleOf(folderRow(container)))

    expect(region.getAttribute('role')).toBe('group')
    const feed = feedRowOf(container)
    expect(feed.getAttribute('role')).toBe('treeitem')
    expect(feed.getAttribute('aria-level')).toBe('2')
    // A feed has nothing to fold, so it must not claim an expansion state.
    expect(feed.hasAttribute('aria-expanded')).toBe(false)
    expect(item.getAttribute('aria-level')).toBe('1')

    // Indent is the shared `treeIndent` step and nothing else: a depth-0 folder is `6 + 0 * 13`,
    // and the feed under it is one level deeper plus the rail's own extra step, `6 + 13 + 13`.
    expect(folderRow(container).style.paddingLeft).toBe('6px')
    expect(feed.style.paddingLeft).toBe('32px')
    // The fold glyph is one icon that turns, not a pair that swaps — the convention every tree draws.
    expect(toggleOf(folderRow(container)).querySelector('svg')!.getAttribute('class')).toContain('rotate-90')
  })

  it('walks the visible rows with the arrow keys and folds the branch back from the child', () => {
    const container = rail()
    click(toggleOf(folderRow(container)))
    const go = nameButton(container)
    const feed = feedRowOf(container)

    focus(go)
    press(go, 'ArrowDown')
    expect(document.activeElement).toBe(feed)

    press(feed, 'ArrowUp')
    expect(document.activeElement).toBe(go)

    // ArrowRight on an open branch steps into its first child rather than toggling it shut.
    press(go, 'ArrowRight')
    expect(document.activeElement).toBe(feed)
    expect(collapsedState()).toBe(false)

    // ArrowLeft on a leaf returns to the parent row; it is the parent that folds, not the leaf.
    press(feed, 'ArrowLeft')
    expect(document.activeElement).toBe(go)
    expect(collapsedState()).toBe(false)

    press(go, 'ArrowLeft')
    expect(collapsedState()).toBe(true)
  })

  it('keeps Home and End inside the tree', () => {
    const container = rail()
    click(toggleOf(folderRow(container)))
    const go = nameButton(container)

    focus(feedRowOf(container))
    press(feedRowOf(container), 'Home')
    expect(document.activeElement).toBe(go)

    press(go, 'End')
    expect(document.activeElement).toBe(feedRowOf(container))
  })
})
