import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { applyMediaPanelStates, enhanceMediaLayouts, executeMediaAction, mediaPanelStates } from './media-layout'

// i18n is left uninitialised on purpose: `t()` then returns the key, so an assertion names the copy slot
// rather than a translation that may be reworded.

const GALLERY = '::: media wrap=left width=40%\n![[a.png]] ![[b.png]] {w=1:2 h=240}\n![[clip.mp4]]\n:::\n'

afterEach(() => {
  document.body.replaceChildren()
})

function withSource(markdown: string, mediaToolbar = true): HTMLElement {
  const root = document.createElement('div')
  root.className = 'ink-prose'
  root.innerHTML = renderMarkdown(markdown).html
  enhanceMediaLayouts(root, { chart: false, mediaToolbar })
  root.dataset.source = markdown
  // In the document, so a focused control really is the active element: jsdom will not focus a detached node.
  document.body.append(root)
  return root
}

/**
 * The press a reader makes: open the block's panel, then press the button in it.
 *
 * The panel's rows are built on first opening, exactly as they are in the app, so a test that reached
 * straight for a button would be asserting against DOM the reader has never been shown. Opening goes
 * through the same action the preview's click route dispatches, not a bare `click()`, because the click
 * delegation lives in the React host this unit does not mount.
 */
function press(root: HTMLElement, action: string, value?: string) {
  const editContent = vi.fn()
  const toast = vi.fn()
  const find = (): HTMLButtonElement | null => root.querySelector<HTMLButtonElement>(
    value === undefined ? `[data-media-action="${action}"]` : `[data-media-action="${action}"][data-media-val="${value}"]`,
  )
  let button = find()
  if (!button) {
    const toggle = root.querySelector<HTMLButtonElement>('[data-media-action="toggle-settings"]')
    if (toggle) executeMediaAction('toggle-settings', toggle, root.dataset.source ?? '', editContent, toast)
    button = find()
  }
  if (!button) throw new Error(`no [data-media-action="${action}"][data-media-val="${value ?? ''}"] in ${root.innerHTML}`)
  const handled = executeMediaAction(action, button, root.dataset.source ?? '', editContent, toast)
  return { handled, editContent, toast, button, next: () => String(editContent.mock.calls.at(-1)?.[0]), warned: () => toast.mock.calls.length > 0 }
}

function openPanel(root: HTMLElement): HTMLElement | null {
  press(root, 'toggle-settings')
  return root.querySelector('.markdown-media > .block-settings')
}

describe('the layout block’s chrome', () => {
  it('gives each block a head and the frame’s three edges', () => {
    const root = withSource(GALLERY)
    const block = root.querySelector<HTMLElement>('.markdown-media')!
    expect(block.querySelector(':scope > .block-head .block-head-title')?.textContent).toBe('workspace.media_layout')
    expect(block.querySelectorAll('.media-edge')).toHaveLength(3)
    expect(block.classList.contains('has-media-chrome')).toBe(true)
  })

  it('builds the settings rows only once the panel is opened', () => {
    const root = withSource(GALLERY)
    const panel = root.querySelector('.markdown-media > .block-settings')
    expect(panel?.childElementCount).toBe(0)
    expect(openPanel(root)?.querySelectorAll('[data-media-action]').length).toBeGreaterThan(10)
  })

  it('leaves the chrome off when the account asks for none, and still renders the block', () => {
    const root = withSource(GALLERY, false)
    expect(root.querySelector('.markdown-media')).not.toBeNull()
    expect(root.querySelector('.block-head')).toBeNull()
    expect(root.querySelector('.media-edge')).toBeNull()
  })

  it('does not put a second head on a block the preview re-rendered', () => {
    const root = withSource(GALLERY)
    enhanceMediaLayouts(root, { chart: false, mediaToolbar: true })
    expect(root.querySelectorAll('.markdown-media > .block-head')).toHaveLength(1)
  })

  it('marks a text frame as one and offers it only the settings it can act on', () => {
    const root = withSource('::: media wrap=right width=30%\nA side note.\n:::')
    expect(root.querySelector('.markdown-media')?.hasAttribute('data-media-text')).toBe(true)
    const panel = openPanel(root)!
    expect(panel.querySelector('[data-media-action="set-wrap"][data-media-val="right"]')).not.toBeNull()
    expect(panel.querySelector('[data-media-action="set-fit"]')).toBeNull()
    expect(panel.querySelector('.markdown-media-row')).toBeNull()
  })

  it('keeps only the edge a columned block can answer to', () => {
    const root = withSource('::: media cols=3\n![[a.png]] ![[b.png]] ![[c.png]] ![[d.png]]\n:::')
    const block = root.querySelector<HTMLElement>('.markdown-media')!
    expect(block.hasAttribute('data-media-columns')).toBe(true)
    expect([...block.querySelectorAll<HTMLElement>('.media-edge')].map((edge) => edge.dataset.mediaHandle)).toEqual(['width'])
  })

  it('offers a columned block the moves but not the sizes its rows have no box for', () => {
    const root = withSource('::: media cols=2\n![[a.png]] ![[b.png]]\n![[c.png]]\n:::')
    const panel = openPanel(root)!
    expect(panel.querySelector('[data-media-action="row-height"]')).toBeNull()
    expect(panel.querySelector('[data-media-action="row-widths"]')).toBeNull()
    expect(panel.querySelector('[data-media-action="row-align"]')).toBeNull()
    expect(panel.querySelectorAll('[data-media-action="cell-move"]')).toHaveLength(6)
    expect(panel.querySelector('[data-media-action="set-columns"][data-media-val="2"]')).not.toBeNull()
    expect(panel.querySelector('[data-media-action="set-gap"]')).not.toBeNull()
  })

  it('leaves a block without columns its full set of row sizes', () => {
    const root = withSource('::: media\n![[a.png]] ![[b.png]]\n![[c.png]]\n:::')
    const panel = openPanel(root)!
    const lines = [...panel.querySelectorAll<HTMLElement>('[data-media-action="row-height"]')].map((button) => button.dataset.mediaVal?.split(':')[0])
    expect(new Set(lines)).toEqual(new Set(['1', '2']))
    expect(panel.querySelectorAll('[data-media-action="row-widths"]')).toHaveLength(3)
    expect(panel.querySelectorAll('[data-media-action="row-align"]')).toHaveLength(6)
  })
})

describe('the layout block’s settings rows', () => {
  it('shows which choice is already in force', () => {
    const panel = openPanel(withSource(GALLERY))!
    expect(panel.querySelector('[data-media-action="set-wrap"][data-media-val="left"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(panel.querySelector('[data-media-action="set-wrap"][data-media-val="none"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(panel.querySelector('[data-media-action="set-width"][data-media-val="40"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('rewrites the header and leaves the pictures alone', () => {
    const root = withSource(GALLERY)
    const result = press(root, 'set-wrap', 'right')
    expect(result.handled).toBe(true)
    expect(result.next()).toBe('::: media wrap=right width=40%\n![[a.png]] ![[b.png]] {w=1:2 h=240}\n![[clip.mp4]]\n:::\n')
  })

  it('takes the block’s width off when the reader gives the line back to the text', () => {
    const result = press(withSource(GALLERY), 'set-width', 'full')
    expect(result.next()).toBe('::: media wrap=left\n![[a.png]] ![[b.png]] {w=1:2 h=240}\n![[clip.mp4]]\n:::\n')
  })

  it('writes a row setting onto the row that was clicked', () => {
    const result = press(withSource(GALLERY), 'row-height', '1:340')
    expect(result.next().split('\n')[1]).toBe('![[a.png]] ![[b.png]] {w=1:2 h=340}')
    expect(result.next().split('\n')[2]).toBe('![[clip.mp4]]')
  })

  it('clears a row’s width list from the equal-width button', () => {
    const result = press(withSource(GALLERY), 'row-widths', '1:equal')
    expect(result.next().split('\n')[1]).toBe('![[a.png]] ![[b.png]] {h=240}')
  })

  it('moves a picture out of the layout through its own button', () => {
    const result = press(withSource(GALLERY), 'cell-out', '1:0')
    expect(result.next().split('\n')[1]).toBe('![[b.png]] {h=240}')
  })

  it('sends a picture to the next row and back', () => {
    const down = press(withSource(GALLERY), 'cell-move', 'down:1:1')
    expect(down.next().split('\n')[1]).toBe('![[a.png]] {h=240}')
    expect(down.next().split('\n')[2]).toBe('![[clip.mp4]] ![[b.png]]')
    const up = press(withSource('::: media\n![[a.png]]\n![[b.png]] ![[c.png]]\n:::\n'), 'cell-move', 'up:2:0')
    expect(up.next().split('\n')[1]).toBe('![[a.png]] ![[b.png]]')
    expect(up.next().split('\n')[2]).toBe('![[c.png]]')
  })

  it('refuses the moves that would empty the block', () => {
    // The single picture of the last row has nowhere to go down to.
    const result = press(withSource(GALLERY), 'cell-move', 'down:2:0')
    expect(result.handled).toBe(true)
    expect(result.editContent).not.toHaveBeenCalled()
    const remove = press(withSource('::: media\n![[a.png]]\n:::\n'), 'row-remove', '1')
    expect(remove.editContent).not.toHaveBeenCalled()
  })

  it('adds a row under the last one', () => {
    const result = press(withSource(GALLERY), 'row-add', 'end')
    expect(result.next()).toBe('::: media wrap=left width=40%\n![[a.png]] ![[b.png]] {w=1:2 h=240}\n![[clip.mp4]]\n\n:::\n')
  })

  it('removes the layout and keeps every picture', () => {
    const result = press(withSource(GALLERY), 'unwrap')
    expect(result.next()).toBe('![[a.png]] ![[b.png]]\n![[clip.mp4]]\n')
    expect(result.toast).toHaveBeenCalledWith({ title: 'preview.media_unwrap_done', tone: 'success' })
  })

  it('resets the header to the defaults the note started with', () => {
    const result = press(withSource(GALLERY), 'reset')
    expect(result.next()).toBe('::: media\n![[a.png]] ![[b.png]] {w=1:2 h=240}\n![[clip.mp4]]\n:::\n')
  })

  it('says so when the block moved out from under the panel', () => {
    const root = withSource(GALLERY)
    // The page is showing a block whose header line is no longer a header in the note it was written to.
    root.dataset.source = 'edited somewhere else entirely\n'
    const result = press(root, 'set-wrap', 'right')
    expect(result.warned()).toBe(true)
    expect(result.editContent).not.toHaveBeenCalled()
  })

  it('keeps a frame with no closer from being edited into a half-written block', () => {
    const root = withSource('::: media\n![[a.png]]\n')
    const result = press(root, 'set-wrap', 'right')
    expect(result.warned()).toBe(true)
    expect(result.editContent).not.toHaveBeenCalled()
  })
})

describe('the layout panel across a re-render', () => {
  it('stays open, and keeps the pressed button focused', () => {
    const root = withSource(GALLERY)
    openPanel(root)
    const pressed = root.querySelector<HTMLButtonElement>('[data-media-action="set-gap"][data-media-val="wide"]')!
    pressed.focus()
    const state = mediaPanelStates(root)
    expect(state.open.get('0')).toBe(true)
    expect(state.focus.get('0')).toBe('set-gap|wide')

    const rebuilt = withSource(GALLERY)
    applyMediaPanelStates(rebuilt, state)
    const block = rebuilt.querySelector<HTMLElement>('.markdown-media')!
    expect(block.classList.contains('is-block-settings-open')).toBe(true)
    expect(block.querySelector(':scope > .block-settings')?.hasAttribute('hidden')).toBe(false)
    expect(document.activeElement).toBe(block.querySelector('[data-media-action="set-gap"][data-media-val="wide"]'))
  })

  it('leaves a closed panel closed', () => {
    const root = withSource(GALLERY)
    applyMediaPanelStates(root, mediaPanelStates(withSource(GALLERY)))
    expect(root.querySelector('.markdown-media')?.classList.contains('is-block-settings-open')).toBe(false)
  })
})
