// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { IdPhotoApp } from '../src/client/features/tools/id-photo/IdPhotoApp'
import { useIdPhotoStore } from '../src/client/features/tools/id-photo/store'
import { useToolsStore } from '../src/client/features/tools/store'

const ESTIMATE = { x: 0.2, y: 0.1, width: 0.5, height: 0.4 }

describe('ID photo estimated head box wiring', () => {
  beforeEach(async () => {
    installTestGlobals()
    await initI18n()
    window.innerWidth = 1280
    window.innerHeight = 800
    useToolsStore.setState({ activeSubmodule: 'id_photo', idPhotoModuleExpanded: true, activeIdPhotoView: 'studio' })
    useIdPhotoStore.setState({
      selectedSpecId: 'cn_one_inch',
      imageSrc: 'blob:head-wiring',
      originalImageSrc: null,
      imageElement: null,
      workingSize: null,
      sourceSize: { width: 295, height: 413 },
      headBox: null,
      guidesVisible: true,
    })
  })

  it('draws the estimated head box over the preview in proportion', async () => {
    // A preview with no image to draw reports back "no head", so the case that keeps a box needs a
    // source element mounted; jsdom answers its 2D context as null, which stops before the estimate.
    useIdPhotoStore.setState({ headBox: ESTIMATE, imageElement: { width: 295, height: 413 } as unknown as HTMLCanvasElement })
    const view = await renderElement(<IdPhotoApp />)

    const box = view.container.querySelector('[data-head-box]')
    expect(box).not.toBeNull()
    const style = (box as HTMLElement).style
    expect(style.left).toBe('20%')
    expect(style.top).toBe('10%')
    expect(style.width).toBe('50%')
    expect(style.height).toBe('40%')
    expect(box?.textContent).toContain(t('tools.id_photo.preview.head_box_estimate'))
    expect(box?.getAttribute('aria-hidden')).not.toBeNull()

    view.unmount()
  })

  it('hides the head box together with the guides', async () => {
    useIdPhotoStore.setState({ headBox: ESTIMATE, guidesVisible: false })
    const view = await renderElement(<IdPhotoApp />)
    expect(view.container.querySelector('[data-head-box]')).toBeNull()
    view.unmount()
  })

  it('draws no box when the preview found no head', async () => {
    useIdPhotoStore.setState({ headBox: null })
    const view = await renderElement(<IdPhotoApp />)
    expect(view.container.querySelector('[data-head-box]')).toBeNull()
    view.unmount()
  })

  const unknownRows = (container: HTMLElement): number =>
    [...container.querySelectorAll('p')].filter((p) => p.textContent === t('tools.id_photo.compliance.unknown')).length

  it('scores the head checks from the estimate instead of giving up', async () => {
    useToolsStore.setState({ activeIdPhotoView: 'compliance' })
    useIdPhotoStore.setState({ headBox: ESTIMATE })
    const view = await renderElement(<IdPhotoApp />)

    // 0.4 of the frame height times the crown factor is exactly 50% for a 413px tall spec.
    expect(view.container.textContent).toContain('50%')
    expect(view.container.textContent).toContain(t('tools.id_photo.compliance.head_estimate'))
    // Only the file size stays unknown before an export; the two head rows now carry numbers.
    expect(unknownRows(view.container)).toBe(1)
    view.unmount()
  })

  it('leaves the head checks unknown until the preview reports a box', async () => {
    useToolsStore.setState({ activeIdPhotoView: 'compliance' })
    const view = await renderElement(<IdPhotoApp />)

    expect(view.container.textContent).not.toContain(t('tools.id_photo.compliance.head_estimate'))
    expect(unknownRows(view.container)).toBe(3)
    view.unmount()
  })
})
