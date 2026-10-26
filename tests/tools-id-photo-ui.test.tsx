// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { IdPhotoApp } from '../src/client/features/tools/id-photo/IdPhotoApp'
import { useIdPhotoStore } from '../src/client/features/tools/id-photo/store'
import { useToolsStore } from '../src/client/features/tools/store'

describe('ID Photo Studio UI Integration Tests', () => {
  beforeEach(async () => {
    installTestGlobals()
    await initI18n()
    window.innerWidth = 1280
    window.innerHeight = 800

    useToolsStore.setState({
      activeSubmodule: 'id_photo',
      idPhotoModuleExpanded: true,
      activeIdPhotoView: 'studio',
    })

    useIdPhotoStore.setState({
      activeOptionsTab: 'spec',
      optionsAccordionOpen: true,
      selectedSpecId: 'cn_one_inch',
      imageSrc: null,
      originalImageSrc: null,
      imageElement: null,
      exportFormat: 'jpg',
    })
  })

  it('renders IdPhotoApp workbench in studio view with all core panels', async () => {
    const view = await renderElement(<IdPhotoApp />)

    const root = view.container.querySelector('[data-testid="id-photo-app-root"]')
    expect(root).not.toBeNull()

    // Upload & Options panel headers
    expect(view.container.textContent).toContain(t('tools.id_photo.content.accordion_title'))
    expect(view.container.textContent).toContain(t('tools.id_photo.options.accordion_title'))
    expect(view.container.textContent).toContain(t('tools.id_photo.export.title'))

    view.unmount()
  })

  it('renders specification cards with national flag emojis', async () => {
    const view = await renderElement(<IdPhotoApp />)

    // Specifications should include country flags
    expect(view.container.textContent).toContain('🇨🇳')
    expect(view.container.textContent).toContain('🇺🇸')
    expect(view.container.textContent).toContain('🇪🇺')

    // Find and select US Passport spec
    const usPassportCard = Array.from(view.container.querySelectorAll('h4')).find((h) =>
      h.textContent?.includes('US Passport') || h.textContent?.includes('美国护照')
    )
    expect(usPassportCard).toBeDefined()

    view.unmount()
  })

  it('switches options tabs across spec, color, retouch, and attire', async () => {
    const view = await renderElement(<IdPhotoApp />)

    // Switch to Color tab
    act(() => {
      useIdPhotoStore.getState().setActiveOptionsTab('color')
    })
    expect(view.container.textContent).toContain(t('tools.id_photo.color.preset_title'))

    // Switch to Retouch tab
    act(() => {
      useIdPhotoStore.getState().setActiveOptionsTab('retouch')
    })
    expect(view.container.textContent).toContain(t('tools.id_photo.retouch.brightness'))

    // Switch to Attire tab
    act(() => {
      useIdPhotoStore.getState().setActiveOptionsTab('attire')
    })
    expect(view.container.textContent).toContain(t('tools.id_photo.attire.none'))

    view.unmount()
  })

  it('renders Print View when activeIdPhotoView is print', async () => {
    useToolsStore.setState({ activeIdPhotoView: 'print' })
    const view = await renderElement(<IdPhotoApp />)

    expect(view.container.textContent).toContain(t('tools.id_photo.print.title'))
    expect(view.container.textContent).toContain(t('tools.id_photo.print.paper_select'))
    expect(view.container.textContent).toContain(t('tools.id_photo.print.crop_marks'))

    view.unmount()
  })

  it('renders Compliance View when activeIdPhotoView is compliance', async () => {
    useToolsStore.setState({ activeIdPhotoView: 'compliance' })
    const view = await renderElement(<IdPhotoApp />)

    expect(view.container.textContent).toContain(t('tools.id_photo.compliance.title'))
    expect(view.container.textContent).toContain(t('tools.id_photo.compliance.score_label'))

    view.unmount()
  })

  it('renders Specs Directory View when activeIdPhotoView is specs', async () => {
    useToolsStore.setState({ activeIdPhotoView: 'specs' })
    const view = await renderElement(<IdPhotoApp />)

    expect(view.container.textContent).toContain(t('tools.id_photo.nav.specs'))
    expect(view.container.textContent).toContain(t('tools.id_photo.spec.add_custom'))

    view.unmount()
  })

  it('renders Batch View when activeIdPhotoView is batch', async () => {
    useToolsStore.setState({ activeIdPhotoView: 'batch' })
    const view = await renderElement(<IdPhotoApp />)

    expect(view.container.textContent).toContain(t('tools.id_photo.batch.title'))
    expect(view.container.textContent).toContain(t('tools.id_photo.batch.upload_btn'))

    view.unmount()
  })
})
