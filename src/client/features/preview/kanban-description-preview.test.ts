/**
 * The preview pane is the only production caller that hands a board a description renderer, and it does
 * so through a hook. Nothing in the modal's own tests can tell whether that hand-off happened: a board
 * mounted without it still behaves perfectly in every unit test, it simply never offers the control.
 * So this drives the real hook over a real rendered fence.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act, createElement, type RefObject } from 'react'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement } from '../../lib/test-render'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { destroyKanbans } from '../../lib/markdown/kanban'
import { useKanbanBlocks } from './use-kanban-blocks'

const SCOPE = 'preview-description-wiring'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(async () => {
  await act(async () => {
    destroyKanbans(SCOPE)
  })
  document.body.replaceChildren()
})

function Board({ rendered, hostRef }: { rendered: ReturnType<typeof renderMarkdown>; hostRef: RefObject<HTMLDivElement | null> }) {
  useKanbanBlocks({ scope: SCOPE, noteId: 'note-1', hostRef, committedHtml: rendered.html, fences: rendered.fences })
  return createElement('div', {
    ref: hostRef,
    className: 'ink-prose',
    dangerouslySetInnerHTML: { __html: rendered.html },
  })
}

function renderedBoard(): ReturnType<typeof renderMarkdown> {
  return boardWith('**bold** claim')
}

function boardWith(content: string): ReturnType<typeof renderMarkdown> {
  const body = JSON.stringify({
    title: 'Sprint',
    items: [{ id: 'item-1', title: 'Ship the board', content, properties: { status: 'todo' } }],
  })
  return renderMarkdown(['# Title', '', '```kanban', body, '```'].join('\n'))
}

const HOSTILE_DESCRIPTION = [
  '<script>window.__kanbanPwned = 1</script>',
  '<img src=x onerror="window.__kanbanPwned = 2">',
  '<iframe src="https://evil.example.test/"></iframe>',
  '[click me](javascript:window.__kanbanPwned=3)',
  'still **readable** prose',
].join('\n\n')

/** Opens the one card this board holds and flips its description to the preview face. */
async function previewDescription(content: string): Promise<HTMLElement> {
  const hostRef: RefObject<HTMLDivElement | null> = { current: null }
  renderElement(createElement(Board, { rendered: boardWith(content), hostRef }))
  await act(async () => {})
  const card = document.querySelector<HTMLElement>('[data-item-id]')
  if (!card) throw new Error('the preview pane mounted no board to open')
  await act(async () => {
    card.querySelector<HTMLButtonElement>('h3 button')!.click()
  })
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${t('preview.kanban_preview_description')}"]`,
  )
  expect(trigger, 'the preview pane passed no description renderer').not.toBeNull()
  await act(async () => {
    trigger!.click()
  })
  const panel = document.querySelector<HTMLElement>('[data-kanban-desc-preview]')
  if (!panel) throw new Error('the description was never previewed, so nothing below proves anything')
  return panel
}

describe('the preview pane wiring a board to the markdown renderer', () => {
  it('lets a mounted card preview its description through the note pipeline', async () => {
    const hostRef: RefObject<HTMLDivElement | null> = { current: null }
    renderElement(createElement(Board, { rendered: renderedBoard(), hostRef }))
    await act(async () => {})

    const card = document.querySelector<HTMLElement>('[data-item-id]')
    if (!card) throw new Error('the preview pane mounted no board to open')
    await act(async () => {
      // The card is a container of controls (SH-107): its title button is what opens the detail.
      card.querySelector<HTMLButtonElement>('h3 button')!.click()
    })
    const trigger = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('preview.kanban_preview_description')}"]`,
    )
    expect(trigger, 'the preview pane passed no description renderer').not.toBeNull()
    await act(async () => {
      trigger!.click()
    })
    expect(document.querySelector<HTMLElement>('[data-kanban-desc-preview] strong')?.textContent).toBe('bold')
  })

  // A description is prose inside an untrusted document: a board can arrive by import, by share, or
  // pasted out of somebody else's note, so the card's `content` is not the reader's own writing. The
  // preview pane hands it to `dangerouslySetInnerHTML`, and the whole reason that is acceptable is the
  // one below — the string comes from the same pipeline the note body goes through, sanitizer and all.
  // Nothing else in the suite asks what a *hostile* description does, so this is what would fail if the
  // renderer were ever swapped for a bare `markdown-it` call or the sanitize step were dropped.
  it('sanitizes a hostile description before it reaches the panel', async () => {
    const panel = await previewDescription(HOSTILE_DESCRIPTION)
    expect(panel.querySelector('script'), 'a script tag survived the sanitizer').toBeNull()
    expect(panel.querySelector('iframe'), 'an iframe survived the sanitizer').toBeNull()
    const handlers = [...panel.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes].filter((attribute) => attribute.name.startsWith('on')).map((attribute) => attribute.name),
    )
    expect(handlers, 'an inline event handler survived the sanitizer').toEqual([])
    const links = [...panel.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href') ?? '')
    expect(links.filter((href) => href.toLowerCase().startsWith('javascript:')), 'a javascript: link survived').toEqual([])
    // The prose itself still renders: a sanitizer that dropped the whole description would pass every
    // assertion above while making the control useless.
    expect(panel.querySelector('strong')?.textContent).toBe('readable')
    expect((globalThis as { __kanbanPwned?: number }).__kanbanPwned).toBeUndefined()
  })
})
