// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_ID_PHOTO_SPECS } from '../src/shared/tools/id-photo/specs'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { IdPhotoApp } from '../src/client/features/tools/id-photo/IdPhotoApp'
import { IdPhotoCompareView } from '../src/client/features/tools/id-photo/compare/IdPhotoCompareView'
import { useIdPhotoStore } from '../src/client/features/tools/id-photo/store'
import { useToolsStore } from '../src/client/features/tools/store'

const PHOTO = { width: 1200, height: 1600 } as unknown as HTMLCanvasElement

function byText(root: Element, text: string): HTMLElement | undefined {
  return [...root.querySelectorAll('button')].find((button) => button.textContent?.includes(text))
}

async function click(button: HTMLElement | undefined): Promise<void> {
  expect(button).toBeDefined()
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

describe('ID photo compare strip', () => {
  beforeEach(async () => {
    installTestGlobals()
    await initI18n()
    window.innerWidth = 1280
    window.innerHeight = 800
    useToolsStore.setState({ activeSubmodule: 'id_photo', idPhotoModuleExpanded: true, activeIdPhotoView: 'compare' })
    useIdPhotoStore.setState({
      selectedSpecId: BUILTIN_ID_PHOTO_SPECS[0].id,
      customSpecs: [],
      compareSpecIds: null,
      imageSrc: null,
      originalImageSrc: null,
      imageElement: null,
      workingSize: null,
      headBox: null,
      adjustOptions: { ...useIdPhotoStore.getState().adjustOptions, cropX: undefined, cropY: undefined, cropWidth: undefined, cropHeight: undefined },
    })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, data: [] })))
  })

  it('waits for a photo before framing anything', async () => {
    const view = await renderElement(<IdPhotoCompareView />)
    expect(view.container.textContent).toContain(t('tools.id_photo.compare.need_photo'))
    expect(view.container.querySelectorAll('[data-compare-card]')).toHaveLength(0)
    view.unmount()
  })

  it('frames the working specification plus one neighbour', async () => {
    useIdPhotoStore.setState({ imageSrc: 'blob:compare', imageElement: PHOTO, sourceSize: PHOTO })
    const view = await renderElement(<IdPhotoCompareView />)

    const cards = view.container.querySelectorAll('[data-compare-card]')
    expect(cards).toHaveLength(2)
    expect(cards[0].getAttribute('data-compare-card')).toBe(BUILTIN_ID_PHOTO_SPECS[0].id)
    expect(cards[0].textContent).toContain(t('tools.id_photo.compare.main'))
    expect(cards[1].textContent).toContain(t('tools.id_photo.compare.use_as_main'))
    expect(view.container.textContent).toContain(t('tools.id_photo.compare.count', { count: 2, max: 4 }))
    view.unmount()
  })

  it('promotes a card to the working specification', async () => {
    useIdPhotoStore.setState({ imageSrc: 'blob:compare', imageElement: PHOTO, sourceSize: PHOTO })
    const view = await renderElement(<IdPhotoCompareView />)

    const second = view.container.querySelector(`[data-compare-card="${BUILTIN_ID_PHOTO_SPECS[1].id}"]`)!
    await click(byText(second, t('tools.id_photo.compare.use_as_main')))
    expect(useIdPhotoStore.getState().selectedSpecId).toBe(BUILTIN_ID_PHOTO_SPECS[1].id)
    expect(useIdPhotoStore.getState().compareSpecIds).toBeNull()

    view.unmount()
  })

  it('adds and removes frames without dropping below two', async () => {
    useIdPhotoStore.setState({ imageSrc: 'blob:compare', imageElement: PHOTO, sourceSize: PHOTO })
    const view = await renderElement(<IdPhotoCompareView />)

    const target = BUILTIN_ID_PHOTO_SPECS[3].id
    const chip = [...view.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(`${BUILTIN_ID_PHOTO_SPECS[3].widthMm}×${BUILTIN_ID_PHOTO_SPECS[3].heightMm}`),
    )
    expect(chip).toBeDefined()
    await click(chip)
    expect(useIdPhotoStore.getState().compareSpecIds).toHaveLength(3)
    expect(view.container.querySelectorAll('[data-compare-card]')).toHaveLength(3)

    const card = view.container.querySelector(`[data-compare-card="${target}"]`)!
    await click([...card.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === t('tools.id_photo.compare.remove')))
    expect(useIdPhotoStore.getState().compareSpecIds).toEqual([
      BUILTIN_ID_PHOTO_SPECS[0].id,
      BUILTIN_ID_PHOTO_SPECS[1].id,
    ])

    // At two frames the strip has nothing left to give up.
    for (const entry of [...view.container.querySelectorAll('[data-compare-card]')]) {
      expect([...entry.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === t('tools.id_photo.compare.remove'))).toBe(false)
    }
    view.unmount()
  })

  it('closes the picker once four frames are side by side', async () => {
    useIdPhotoStore.setState({
      imageSrc: 'blob:compare',
      imageElement: PHOTO,
      sourceSize: PHOTO,
      compareSpecIds: BUILTIN_ID_PHOTO_SPECS.slice(0, 4).map((spec) => spec.id),
    })
    const view = await renderElement(<IdPhotoCompareView />)

    expect(view.container.querySelectorAll('[data-compare-card]')).toHaveLength(4)
    expect(view.container.textContent).toContain(t('tools.id_photo.compare.max'))
    const chips = [...view.container.querySelectorAll('button')].filter((button) => button.disabled)
    expect(chips.length).toBeGreaterThan(0)
    view.unmount()
  })

  it('says so on the card when a frame cannot be drawn', async () => {
    useIdPhotoStore.setState({ imageSrc: 'blob:compare', imageElement: PHOTO, sourceSize: PHOTO })
    const view = await renderElement(<IdPhotoCompareView />)
    await act(async () => {
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })
    expect(view.container.textContent).toContain(t('tools.id_photo.preview.render_failed'))
    view.unmount()
  })

  it('routes the module view to the strip', async () => {
    const view = await renderElement(<IdPhotoApp />)
    expect(view.container.textContent).toContain(t('tools.id_photo.compare.title'))
    view.unmount()
  })
})
