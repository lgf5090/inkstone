// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { IdPhotoApp } from '../src/client/features/tools/id-photo/IdPhotoApp'
import { useIdPhotoStore } from '../src/client/features/tools/id-photo/store'
import { useToolsStore } from '../src/client/features/tools/store'
import type { CropRect } from '../src/client/features/tools/id-photo/engine/framing'

const LAYER = { width: 1200, height: 1600 }

function seedPhoto(patch: Partial<{ cropX: number; cropY: number; cropWidth: number; cropHeight: number }> = {}) {
  useIdPhotoStore.setState({
    imageSrc: 'blob:framing-test',
    originalImageSrc: 'blob:framing-test',
    imageElement: { width: LAYER.width, height: LAYER.height } as unknown as HTMLCanvasElement,
    workingSize: LAYER,
    sourceSize: LAYER,
    adjustOptions: { ...useIdPhotoStore.getState().adjustOptions, ...patch },
  })
}

function framing(): CropRect | null {
  return useIdPhotoStore.getState().cropRect()
}

function insideLayer(rect: CropRect | null): boolean {
  if (!rect) return false
  return (
    rect.cropX >= 0 &&
    rect.cropY >= 0 &&
    rect.cropWidth >= 1 &&
    rect.cropHeight >= 1 &&
    rect.cropX + rect.cropWidth <= LAYER.width + 1 &&
    rect.cropY + rect.cropHeight <= LAYER.height + 1
  )
}

/** Lets the preview engine's pending render promise settle inside an act scope. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
}

async function moveSlider(input: HTMLInputElement, value: string): Promise<void> {
  act(() => {
    // React tracks the node's value itself, so a plain assignment reads as "nothing changed" and
    // the change event is dropped. The prototype setter is what a real keystroke goes through.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setValue) setValue.call(input, value)
    else input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // The shared slider coalesces a drag into one write per frame, so the frame is the handoff.
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
  })
}

function pointer(element: Element, type: string, x: number, y: number): void {
  act(() => {
    element.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        clientX: x,
        clientY: y,
      }),
    )
  })
}

describe('ID photo manual framing', () => {
  beforeEach(async () => {
    installTestGlobals()
    await initI18n()
    // The attire swatches are SVG blobs, so jsdom needs the object-URL pair to exist.
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:framing-stub', configurable: true, writable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, configurable: true, writable: true })
    window.innerWidth = 1280
    window.innerHeight = 800
    useToolsStore.setState({ activeSubmodule: 'id_photo', idPhotoModuleExpanded: true, activeIdPhotoView: 'studio' })
    useIdPhotoStore.setState({
      activeOptionsTab: 'framing',
      optionsAccordionOpen: true,
      selectedSpecId: 'cn_one_inch',
      imageSrc: null,
      originalImageSrc: null,
      imageElement: null,
      workingSize: null,
      sourceSize: null,
      adjustOptions: { ...useIdPhotoStore.getState().adjustOptions, cropX: undefined, cropY: undefined, cropWidth: undefined, cropHeight: undefined, rotation: 0 },
    })
  })

  it('starts from the centred, uncropped default the engine renders', () => {
    seedPhoto()
    expect(useIdPhotoStore.getState().cropPercents()).toEqual({ zoom: 0, x: 50, y: 50 })
    const rect = framing()
    expect(rect).not.toBeNull()
    // cn_one_inch is 295x413 px (taller than the layer-relative 1200x1600), so the frame is height-bound.
    expect(rect?.cropHeight).toBe(LAYER.height)
    expect(insideLayer(rect)).toBe(true)
  })

  it('keeps the crop inside the layer for every zoom and pan combination', () => {
    seedPhoto()
    for (const zoom of [0, 25, 50, 75, 100]) {
      for (const x of [0, 33, 50, 100]) {
        for (const y of [0, 50, 100]) {
          useIdPhotoStore.getState().setCropPercents(zoom, x, y)
          const rect = framing()!
          expect(insideLayer(rect), `zoom=${zoom} x=${x} y=${y}`).toBe(true)
          const read = useIdPhotoStore.getState().cropPercents()!
          expect(read.zoom, `zoom=${zoom}`).toBeCloseTo(zoom, -1)
          // A frame that already spans the layer on one axis has nowhere to travel, so that axis
          // reports the neutral centre rather than the number it was handed.
          const freeX = LAYER.width - rect.cropWidth
          const freeY = LAYER.height - rect.cropHeight
          expect(Math.abs(read.x - (freeX > 1 ? x : 50)), `x=${x}`).toBeLessThanOrEqual(1)
          expect(Math.abs(read.y - (freeY > 1 ? y : 50)), `y=${y}`).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('shrinks the frame as zoom rises and never past the zoom ceiling', () => {
    seedPhoto()
    useIdPhotoStore.getState().setCropPercents(0, 50, 50)
    const wide = framing()!
    useIdPhotoStore.getState().setCropPercents(100, 50, 50)
    const tight = framing()!
    expect(tight.cropWidth).toBeLessThan(wide.cropWidth)
    expect(wide.cropWidth / tight.cropWidth).toBeCloseTo(4, 0)
    useIdPhotoStore.getState().setCropPercents(250, 50, 50)
    expect(framing()!.cropWidth).toBe(tight.cropWidth)
  })

  it('pans the frame by the dragged fraction of what is on screen', () => {
    seedPhoto()
    useIdPhotoStore.getState().setCropPercents(50, 50, 50)
    const before = framing()!
    useIdPhotoStore.getState().panByRatio(0.1, 0)
    const after = framing()!
    expect(after.cropX).toBeCloseTo(before.cropX - before.cropWidth * 0.1, 0)
    expect(after.cropY).toBe(before.cropY)
    expect(after.cropWidth).toBe(before.cropWidth)
    expect(insideLayer(after)).toBe(true)
  })

  it('stops the frame at the layer edge instead of running off the photo', () => {
    seedPhoto()
    useIdPhotoStore.getState().panByRatio(-2, -2)
    const clamped = framing()!
    expect(clamped.cropX).toBeGreaterThan(0)
    expect(clamped.cropY + clamped.cropHeight).toBeLessThanOrEqual(LAYER.height)
    expect(insideLayer(clamped)).toBe(true)
  })

  it('returns to the automatic framing when the crop is reset', () => {
    seedPhoto({ cropX: 100, cropY: 200, cropWidth: 600, cropHeight: 840 })
    useIdPhotoStore.getState().resetCrop()
    const options = useIdPhotoStore.getState().adjustOptions
    expect(options.cropX).toBeUndefined()
    expect(useIdPhotoStore.getState().cropPercents()).toEqual({ zoom: 0, x: 50, y: 50 })
  })

  it('re-centres the frame when the specification aspect changes', () => {
    seedPhoto({ cropX: 0, cropY: 0, cropWidth: 400, cropHeight: 560 })
    useIdPhotoStore.getState().setSelectedSpecId('us_passport')
    const options = useIdPhotoStore.getState().adjustOptions
    expect(options.cropX).toBeUndefined()
    expect(insideLayer(framing())).toBe(true)
  })

  it('drops the manual framing when a different photo arrives', async () => {
    class FakeImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      naturalWidth = 900
      naturalHeight = 1200
      width = 900
      height = 1200

      set src(_value: string) {
        setTimeout(() => this.onload?.(), 0)
      }
    }
    vi.stubGlobal('Image', FakeImage)
    seedPhoto({ cropX: 800, cropY: 900, cropWidth: 400, cropHeight: 560 })

    const loaded = await useIdPhotoStore.getState().setImageSrc('blob:second-photo')
    expect(loaded).toBe(true)
    expect(useIdPhotoStore.getState().adjustOptions.cropX).toBeUndefined()
    expect(useIdPhotoStore.getState().cropPercents()).toEqual({ zoom: 0, x: 50, y: 50 })
    expect(useIdPhotoStore.getState().workingSize).toEqual({ width: 900, height: 1200 })
    vi.unstubAllGlobals()
  })

  it('gives every adjustment slider exactly one readout in its row', async () => {
    seedPhoto()
    const view = await renderElement(<IdPhotoApp />)
    await settle()

    const tabs = [
      t('tools.id_photo.options.tab_color'),
      t('tools.id_photo.options.tab_framing'),
      t('tools.id_photo.options.tab_retouch'),
      t('tools.id_photo.options.tab_attire'),
    ]
    for (const tab of tabs) {
      const button = [...view.container.querySelectorAll('button')].find((el) => el.textContent?.trim() === tab)
      expect(button, `tab ${tab}`).toBeDefined()
      if (tab === t('tools.id_photo.options.tab_attire')) {
        // The positioning sliders only exist once an outfit is on the portrait.
        useIdPhotoStore.getState().setAdjustOptions({ attireId: 'male_suit_navy' })
      }
      act(() => {
        button!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      const rows = [...view.container.querySelectorAll<HTMLInputElement>('input[type="range"]')].map((input) => ({
        name: input.getAttribute('aria-labelledby') ? document.getElementById(input.getAttribute('aria-labelledby')!)?.textContent?.trim() : input.getAttribute('aria-label'),
        readouts: [...input.parentElement!.querySelectorAll('span')].length,
      }))
      expect(rows.length, `tab ${tab} has no sliders`).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.readouts, `${tab} / ${row.name} shows ${row.readouts} numbers`).toBe(1)
      }
    }
    view.unmount()
  })

  it('exposes zoom and position sliders that write the framing back to the store', async () => {
    seedPhoto()
    const view = await renderElement(<IdPhotoApp />)
    await settle()

    const labelled = (label: string): HTMLInputElement | null => {
      const field = [...view.container.querySelectorAll('label')].find((node) => node.textContent?.trim() === label)
      return field?.htmlFor ? (document.getElementById(field.htmlFor) as HTMLInputElement | null) : null
    }

    const zoom = labelled(t('tools.id_photo.framing.zoom'))
    expect(zoom).not.toBeNull()
    // The row shows one number, in the unit the user thinks in: 100% means no crop at all.
    expect(zoom!.min).toBe('100')
    expect(zoom!.max).toBe('400')
    const readouts = [...zoom!.parentElement!.querySelectorAll('span')].filter((span) => (span.textContent ?? '').includes('%'))
    expect(readouts).toHaveLength(1)
    expect(readouts[0].textContent).toBe('100%')

    await moveSlider(zoom!, '280')
    expect(useIdPhotoStore.getState().cropPercents()?.zoom).toBe(60)
    expect(readouts[0].textContent).toBe('280%')
    expect(insideLayer(framing())).toBe(true)

    const vertical = labelled(t('tools.id_photo.framing.vertical'))
    expect(vertical).not.toBeNull()
    await moveSlider(vertical!, '20')
    expect(useIdPhotoStore.getState().cropPercents()?.y).toBe(20)

    view.unmount()
  })

  it('pans the preview by dragging it with a pointer', async () => {
    const setPointerCapture = vi.fn()
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      value: setPointerCapture,
      configurable: true,
      writable: true,
    })
    seedPhoto()
    const view = await renderElement(<IdPhotoApp />)
    await settle()

    const surface = view.container.querySelector('[data-framing-drag]')
    expect(surface).not.toBeNull()
    const rect = { width: 300, height: 420, left: 40, top: 60 }
    vi.spyOn(surface as Element, 'getBoundingClientRect').mockReturnValue(rect as DOMRect)

    useIdPhotoStore.getState().setCropPercents(50, 50, 50)
    const before = framing()!

    pointer(surface!, 'pointerdown', 190, 270)
    pointer(surface!, 'pointermove', 160, 270)
    pointer(surface!, 'pointermove', 160, 300)
    pointer(surface!, 'pointerup', 160, 300)

    const after = framing()!
    expect(setPointerCapture).toHaveBeenCalled()
    expect(after.cropX).toBeGreaterThan(before.cropX)
    expect(after.cropY).toBeLessThan(before.cropY)
    expect(insideLayer(after)).toBe(true)

    const panX = (after.cropX - before.cropX) / before.cropWidth
    expect(panX).toBeCloseTo(30 / rect.width, 2)

    pointer(surface!, 'pointermove', 100, 100)
    expect(framing()!.cropX).toBe(after.cropX)

    view.unmount()
  })

  it('asks for a photo before offering framing controls', async () => {
    const view = await renderElement(<IdPhotoApp />)
    expect(view.container.textContent).toContain(t('tools.id_photo.framing.need_photo'))
    expect(view.container.querySelector('input[type="range"]')).toBeNull()
    view.unmount()
  })
})
