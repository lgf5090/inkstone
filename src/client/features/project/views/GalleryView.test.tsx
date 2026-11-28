import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCard } from '@shared/project/model'
import { emptyProjectViewFields } from '@shared/project/model'
import { initI18n } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { GalleryView } from './GalleryView'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
let view: RenderedElement

beforeEach(async () => { await initI18n() })
afterEach(() => { view?.unmount() })

describe('large gallery rendering', () => {
  it('keeps tiles bounded and reveals the tail on scroll', async () => {
    const cards: ProjectCard[] = Array.from({ length: 240 }, (_, index) => ({
      id: `c${index}`, boardId: 'b1', parentId: '', title: `Card ${index}`, icon: '', isTemplate: false, contentOrder: [], values: {}, ...stamps,
    }))
    await act(async () => {
      view = renderElement(createElement(GalleryView, {
        cards, properties: [], chipProperties: [], fields: emptyProjectViewFields(), canEdit: false,
        badgesFor: () => ({ description: false, comments: 0, checked: 0, checkboxes: 0 }),
        onOpenCard: vi.fn(), onCardContextMenu: vi.fn(), onPatchFields: vi.fn(), onAddCard: vi.fn().mockResolvedValue(undefined),
      }))
    })
    expect(view.container.querySelectorAll('[data-gallery-tile]').length).toBeLessThan(20)
    expect(view.container.querySelector('[data-gallery-tile="c239"]')).toBeNull()
    const gallery = view.container.querySelector<HTMLElement>('.pv-gallery')!
    Object.defineProperty(gallery, 'clientHeight', { configurable: true, value: 600 })
    await act(async () => {
      Object.defineProperty(gallery, 'scrollTop', { configurable: true, writable: true, value: 100_000 })
      gallery.dispatchEvent(new Event('scroll'))
    })
    expect(view.container.querySelectorAll('[data-gallery-tile]').length).toBeLessThan(20)
    expect(view.container.querySelector('[data-gallery-tile="c239"]')).not.toBeNull()
  })
})
