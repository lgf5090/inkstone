import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement } from '../../lib/test-render'
import { presentationKeyReference } from './presentation-keys'
import { PresentationKeyGuide } from './presentation-key-guide'

installTestGlobals()

beforeAll(async () => {
  await initI18n()
})

afterEach(() => {
  document.body.innerHTML = ''
})

const card = () => document.querySelector('[data-presentation-key-guide]')

describe('PresentationKeyGuide', () => {
  it('draws nothing until the show is asked for it', () => {
    renderElement(createElement(PresentationKeyGuide, { open: false, onClose: vi.fn() }))
    expect(card()).toBeNull()
  })

  it('prints one row per binding the map answers with', () => {
    const { container } = renderElement(createElement(PresentationKeyGuide, { open: true, onClose: vi.fn() }))
    const rows = container.querySelectorAll('li')
    expect(rows.length).toBe(presentationKeyReference().length)
    expect(container.textContent).toContain(t('workspace.presentation_next'))
    expect(container.textContent).toContain(t('workspace.presentation_exit'))
  })

  it('hangs the keys of a binding on the row that names it', () => {
    const { container } = renderElement(createElement(PresentationKeyGuide, { open: true, onClose: vi.fn() }))
    const next = presentationKeyReference().find((row) => row.command === 'next')
    if (!next) throw new Error('the reference stopped documenting the turn')
    const row = [...container.querySelectorAll('li')].find((item) => item.textContent?.includes(next.description))
    const caps = [...(row?.querySelectorAll('kbd') ?? [])].map((kbd) => kbd.textContent?.trim())
    expect(caps).toEqual(next.caps)
  })

  it('is a named region the reader can be sent to, with a button that puts it away', () => {
    const onClose = vi.fn()
    const { container } = renderElement(createElement(PresentationKeyGuide, { open: true, onClose }))
    expect(card()?.tagName).toBe('SECTION')
    expect(card()?.getAttribute('aria-label')).toBe(t('workspace.presentation_keys'))
    const close = container.querySelector<HTMLButtonElement>('button')
    expect(close?.type).toBe('button')
    expect(close?.getAttribute('aria-label')).toBe(t('common.close'))
    act(() => {
      close?.click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
