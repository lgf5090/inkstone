// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_ID_PHOTO_SPECS } from '../src/shared/tools/id-photo/specs'
import type { IdPhotoSpec } from '../src/shared/tools/id-photo/types'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { IdPhotoApp } from '../src/client/features/tools/id-photo/IdPhotoApp'
import { useIdPhotoStore } from '../src/client/features/tools/id-photo/store'
import { useToolsStore } from '../src/client/features/tools/store'
import { specLabel } from '../src/client/features/tools/id-photo/spec-label'
import { describeSizeLimit } from '../src/client/features/tools/id-photo/specs/size-limit'

const spec = (overrides: Partial<IdPhotoSpec>): IdPhotoSpec => ({
  id: 'x',
  name: 'X',
  category: 'custom',
  countryCode: '',
  countryNameKey: '',
  widthMm: 25,
  heightMm: 35,
  widthPx: 295,
  heightPx: 413,
  dpi: 300,
  recommendedBgColors: ['#ffffff'],
  faceRatioMin: 0.6,
  faceRatioMax: 0.8,
  ...overrides,
})

function inputForLabel(label: string, root: ParentNode = document): HTMLInputElement | undefined {
  const field = [...root.querySelectorAll('label')].find((node) => node.textContent?.trim() === label)
  const id = field?.htmlFor
  return id ? (document.getElementById(id) as HTMLInputElement | null) ?? undefined : undefined
}

async function typeValue(input: HTMLInputElement | undefined, value: string): Promise<void> {
  expect(input).toBeDefined()
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    if (setValue) setValue.call(input!, value)
    else input!.value = value
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
}

describe('ID photo published file size', () => {
  beforeEach(async () => {
    installTestGlobals()
    await initI18n()
    window.innerWidth = 1280
    window.innerHeight = 800
    useToolsStore.setState({ activeSubmodule: 'id_photo', idPhotoModuleExpanded: true, activeIdPhotoView: 'studio' })
    useIdPhotoStore.setState({
      activeOptionsTab: 'spec',
      optionsAccordionOpen: true,
      selectedSpecId: 'cn_one_inch',
      customSpecs: [],
      customSpecModalOpen: false,
      imageSrc: null,
      imageElement: null,
      targetMaxKb: undefined,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the published window in one neutral form', () => {
    expect(describeSizeLimit(spec({ fileSizeMinKb: 20, fileSizeMaxKb: 200 }))).toBe('20–200 KB')
    expect(describeSizeLimit(spec({ fileSizeMaxKb: 200 }))).toBe('≤ 200 KB')
    expect(describeSizeLimit(spec({ fileSizeMinKb: 20 }))).toBe('≥ 20 KB')
    expect(describeSizeLimit(spec({ fileSizeMinKb: 40, fileSizeMaxKb: 40 }))).toBe('40 KB')
    expect(describeSizeLimit(spec({}))).toBeNull()
  })

  it('labels a specification card by what the authority actually published', async () => {
    const withLimit = BUILTIN_ID_PHOTO_SPECS.find((s) => s.fileSizeMaxKb)!
    const without = BUILTIN_ID_PHOTO_SPECS.find((s) => !s.fileSizeMaxKb && !s.fileSizeMinKb)!
    expect(withLimit).toBeDefined()
    expect(without).toBeDefined()

    const view = await renderElement(<IdPhotoApp />)
    await settle()

    const published = view.container.querySelector(`[data-spec-size-limit="${withLimit.id}"]`)
    const blank = view.container.querySelector(`[data-spec-size-limit="${without.id}"]`)
    expect(published?.textContent).toBe(describeSizeLimit(withLimit))
    expect(blank?.textContent).toBe(t('tools.id_photo.spec.size_unpublished'))
    expect(blank?.textContent).not.toContain('KB')
    view.unmount()
  })

  it('labels the specification library the same way as the studio tab', async () => {
    const withLimit = BUILTIN_ID_PHOTO_SPECS.find((s) => s.fileSizeMaxKb)!
    const without = BUILTIN_ID_PHOTO_SPECS.find((s) => !s.fileSizeMaxKb && !s.fileSizeMinKb)!
    useToolsStore.setState({ activeIdPhotoView: 'specs' })

    const view = await renderElement(<IdPhotoApp />)
    await settle()

    const published = view.container.querySelector(`[data-spec-size-limit="${withLimit.id}"]`)
    const blank = view.container.querySelector(`[data-spec-size-limit="${without.id}"]`)
    expect(published?.textContent).toBe(describeSizeLimit(withLimit))
    expect(blank?.textContent).toBe(t('tools.id_photo.spec.size_unpublished'))
    view.unmount()
  })

  it('tells the exporter which ceiling the chosen specification asks for', async () => {
    const withLimit = BUILTIN_ID_PHOTO_SPECS.find((s) => s.fileSizeMaxKb)!
    const without = BUILTIN_ID_PHOTO_SPECS.find((s) => !s.fileSizeMaxKb && !s.fileSizeMinKb)!

    useIdPhotoStore.setState({ selectedSpecId: withLimit.id })
    const view = await renderElement(<IdPhotoApp />)
    await settle()
    const hint = view.container.querySelector('[data-export-spec-limit]')?.textContent
    expect(hint).toContain(describeSizeLimit(withLimit))
    expect(hint).toContain(specLabel(withLimit))
    view.unmount()

    useIdPhotoStore.setState({ selectedSpecId: without.id })
    const second = await renderElement(<IdPhotoApp />)
    await settle()
    const blank = second.container.querySelector('[data-export-spec-limit]')?.textContent
    expect(blank).toBe(t('tools.id_photo.export.spec_limit_unknown', { spec: specLabel(without) }))
    expect(blank).not.toContain(describeSizeLimit(withLimit)!)
    second.unmount()
  })

  it('sends the ceiling the user types and omits it when left blank', async () => {
    const bodies: string[] = []
    const created = { id: 'spec_created', name: '自定义', category: 'custom', countryCode: '', countryNameKey: '', widthMm: 35, heightMm: 45, widthPx: 413, heightPx: 531, dpi: 300, recommendedBgColors: ['#ffffff'] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') {
          bodies.push(String(init.body))
          return Response.json({ ok: true, data: created })
        }
        // Every other call is a list (specs, records, settings) and the store iterates what comes back.
        return Response.json({ ok: true, data: [created] })
      }),
    )
    useIdPhotoStore.setState({ customSpecModalOpen: true })

    const view = await renderElement(<IdPhotoApp />)
    await settle()

    // The modal renders through a portal, so its fields live outside the mounted container.
    const nameInput = inputForLabel(t('tools.id_photo.spec.add_custom'))
    const kbInput = inputForLabel(t('tools.id_photo.spec.size_limit'))
    expect(nameInput).toBeDefined()
    expect(kbInput).toBeDefined()

    // The studio's own "Add Custom" button carries the same caption, so the submit is the form's own.
    const submit = (input?: HTMLElement) =>
      input!.closest('form')!.querySelector('button[type="submit"]') as HTMLButtonElement

    await typeValue(nameInput, '报名表')
    // A ceiling outside the accepted range blocks the submit instead of silently dropping it.
    await typeValue(kbInput, '999999')
    expect(submit(kbInput).disabled).toBe(true)
    expect(bodies).toHaveLength(0)

    await typeValue(kbInput, '120')
    expect(submit(kbInput).disabled).toBe(false)
    await act(async () => {
      kbInput!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })
    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0])).toMatchObject({ name: '报名表', fileSizeMaxKb: 120 })

    // Leaving the field empty is a different answer from an unreadable one: no key is sent at all.
    useIdPhotoStore.setState({ customSpecModalOpen: true })
    await settle()
    const reopenedName = inputForLabel(t('tools.id_photo.spec.add_custom'))
    const reopenedKb = inputForLabel(t('tools.id_photo.spec.size_limit'))
    await typeValue(reopenedName, '无上限')
    await typeValue(reopenedKb, '')
    expect(submit(reopenedKb).disabled).toBe(false)
    await act(async () => {
      reopenedKb!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })
    expect(bodies).toHaveLength(2)
    expect(JSON.parse(bodies[1])).not.toHaveProperty('fileSizeMaxKb')
    view.unmount()
  })
})
