/**
 * A card description is rendered by the host, not by this module — the markdown renderer already
 * imports the kanban, so importing it back would close a cycle, and the renderer therefore travels
 * down as a mount option. That makes four layers of pass-through no unit test of the detail modal can
 * see: if the option stopped at the board root, the modal would quietly offer nothing while every
 * modal test stayed green. These cases mount a real board through the registry and read the result.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act } from 'react'
import { initI18n, t } from '../../i18n'
import { installTestGlobals } from '../../test-render'
import { registerFenceBodies } from '../fence-bodies'
import { renderMarkdown } from '../renderer'
import { destroyKanbans, mountKanbans } from './index'

const SCOPE = 'kanban-renderer-injection-test'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(async () => {
  // The registry defers the root unmount by a microtask, and the detail modal lives in that root, so
  // the board is taken down inside `act` before its host nodes leave the document.
  await act(async () => {
    destroyKanbans(SCOPE)
  })
  document.body.replaceChildren()
})

async function mountBoard(renderDescription?: (source: string) => string): Promise<HTMLElement> {
  const body = JSON.stringify({
    title: 'Sprint',
    items: [{ id: 'item-1', title: 'Ship the board', content: '**bold** claim', properties: { status: 'todo' } }],
  })
  const host = document.createElement('div')
  host.className = 'ink-prose'
  const rendered = renderMarkdown(['# Title', '', '```kanban', body, '```'].join('\n'))
  host.innerHTML = rendered.html
  registerFenceBodies(host, rendered.fences)
  document.body.append(host)
  await act(async () => {
    await mountKanbans(host, { scope: SCOPE, noteId: 'note-1', editable: true, renderDescription })
  })
  return host
}

function hostRenderer(source: string): string {
  return renderMarkdown(source).html
}

async function openDetail(host: HTMLElement) {
  const card = host.querySelector<HTMLElement>('[data-item-id]')
  if (!card) throw new Error('the mounted board drew no card to open')
  await act(async () => {
    // The card is a container of controls (SH-107): its title button is what opens the detail.
    card.querySelector<HTMLButtonElement>('h3 button')!.click()
  })
}

async function togglePreview() {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${t('preview.kanban_preview_description')}"]`,
  )
  if (!trigger) return null
  await act(async () => {
    trigger.click()
  })
  return document.querySelector<HTMLElement>('[data-kanban-desc-preview]')
}

describe('the description renderer injected through the registry', () => {
  it('reaches the card detail, which then previews the stored description', async () => {
    const host = await mountBoard(hostRenderer)
    await openDetail(host)
    const preview = await togglePreview()
    expect(preview).not.toBeNull()
    expect(preview!.querySelector('strong')?.textContent).toBe('bold')
  })

  it('leaves the detail with no preview control when the host supplies no renderer', async () => {
    const host = await mountBoard()
    await openDetail(host)
    expect(await togglePreview()).toBeNull()
    const box = document.querySelector<HTMLTextAreaElement>(
      `textarea[placeholder="${t('preview.kanban_card_description_placeholder')}"]`,
    )
    expect(box?.value).toContain('**bold** claim')
  })
})
