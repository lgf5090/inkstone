// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IdPhotoRecord } from '../src/shared/tools/id-photo/types'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { IdPhotoHistoryView } from '../src/client/features/tools/id-photo/history/IdPhotoHistoryView'
import { useIdPhotoStore } from '../src/client/features/tools/id-photo/store'
import { useToolsStore } from '../src/client/features/tools/store'

const record = (overrides: Partial<IdPhotoRecord> = {}): IdPhotoRecord => ({
  id: 'rec_1',
  userId: 'user-alice',
  title: '旧名字',
  specId: 'cn_one_inch',
  specName: '标准一寸',
  widthPx: 295,
  heightPx: 413,
  widthMm: 25,
  heightMm: 35,
  dpi: 300,
  bgColor: '#ffffff',
  optionsJson: '{}',
  r2Key: 'tools/id_photo/jpg/user/rec_1.jpg',
  printR2Key: '',
  fileType: 'jpg',
  fileSize: 40_000,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
}

describe('ID photo record renaming', () => {
  let mounted: Awaited<ReturnType<typeof renderElement>> | null = null

  beforeEach(async () => {
    installTestGlobals()
    await initI18n()
    window.innerWidth = 1280
    window.innerHeight = 800
    useToolsStore.setState({ activeSubmodule: 'id_photo', idPhotoModuleExpanded: true, activeIdPhotoView: 'history' })
    useIdPhotoStore.setState({ customSpecs: [], selectedSpecId: 'cn_one_inch' })
  })

  // A dialog lives in a portal, so an unmounted view would leave it in the document for the next case.
  afterEach(() => {
    mounted?.unmount()
    mounted = null
    vi.unstubAllGlobals()
  })

  async function openHistory(current: IdPhotoRecord): Promise<{ bodies: string[]; view: Awaited<ReturnType<typeof renderElement>> }> {
  const bodies: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'PATCH') {
        bodies.push(String(init?.body))
        return Response.json({ ok: true, data: { ...current, title: '报名照 · 一寸', updatedAt: 2 } })
      }
      return Response.json({ ok: true, data: { records: [current], total: 1 } })
    }),
  )
  const view = await renderElement(<IdPhotoHistoryView />)
  mounted = view
  await settle()
  return { bodies, view }
}

  it('opens a dialog instead of a native prompt and sends the new title', async () => {
    const { bodies, view } = await openHistory(record())
    const container = view.container

    const rename = [...container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === t('tools.id_photo.history.rename'),
    )
    expect(rename).toBeDefined()
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null)

    await act(async () => {
      rename!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    expect(promptSpy).not.toHaveBeenCalled()
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain(t('tools.id_photo.history.rename_title'))
    // The field starts from what the archive already says.
    const input = dialog!.querySelector('input')!
    expect(input.value).toBe('旧名字')

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, '报名照 · 一寸')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      dialog!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })

    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0])).toEqual({ title: '报名照 · 一寸' })
    // The list shows the new name without a reload, and the dialog is gone.
    expect(container.textContent).toContain('报名照 · 一寸')
    expect(container.textContent).not.toContain('旧名字')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    view.unmount()
  })

  it('keeps the dialog open with a reason when the server refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'PATCH') return new Response(JSON.stringify({ ok: false, error: 'bad' }), { status: 400, headers: { 'content-type': 'application/json' } })
        return Response.json({ ok: true, data: { records: [record()], total: 1 } })
      }),
    )
    const view = await renderElement(<IdPhotoHistoryView />)
    mounted = view
    await settle()

    const rename = [...view.container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === t('tools.id_photo.history.rename'),
    )
    await act(async () => {
      rename!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const dialog = document.querySelector('[role="dialog"]')!
    const input = dialog.querySelector('input')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, '四十个字符的名字用来验证服务端拒绝路径')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })

    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(dialog.textContent).toContain(t('tools.id_photo.history.rename_failed'))
    view.unmount()
  })

  it('refuses to send a blank name without asking the server', async () => {
    const { bodies, view } = await openHistory(record())
    const rename = [...view.container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === t('tools.id_photo.history.rename'),
    )
    await act(async () => {
      rename!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const dialog = document.querySelector('[role="dialog"]')!
    const input = dialog.querySelector('input')!
    const submit = dialog.querySelector('button[type="submit"]') as HTMLButtonElement

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, '   ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(submit.disabled).toBe(true)

    await act(async () => {
      setValue.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(submit.disabled).toBe(true)
    expect(bodies).toHaveLength(0)
    view.unmount()
  })

  it('closes on cancel without touching the archive', async () => {
    const { bodies, view } = await openHistory(record())
    const rename = [...view.container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === t('tools.id_photo.history.rename'),
    )
    await act(async () => {
      rename!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const dialog = document.querySelector('[role="dialog"]')!
    const cancel = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.includes(t('tools.id_photo.common.cancel')))
    await act(async () => {
      cancel!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(bodies).toHaveLength(0)
    view.unmount()
  })
})
