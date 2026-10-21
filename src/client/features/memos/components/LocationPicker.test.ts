// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoLocation } from '@shared/memos/types'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { LocationPicker } from './LocationPicker'

interface LocationPickerMapDoubleProps {
  point: { latitude: number; longitude: number } | null
  label: string
  onPick: (latitude: number, longitude: number) => void
}

vi.mock('./LocationPickerMap', async () => {
  const React = await import('react')
  return {
    LocationPickerMap: (props: LocationPickerMapDoubleProps) => React.createElement(
      'div',
      { 'data-testid': 'location-map', 'aria-label': props.label },
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: () => props.onPick(37.5, -122.25),
        },
        'pick-map',
      ),
    ),
  }
})

let rendered: RenderedElement | null = null
let onChange: ReturnType<typeof vi.fn>
let onClose: ReturnType<typeof vi.fn>

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

async function flush(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function setInputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function dialogInputs(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')]
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((button) => button.textContent?.trim() === text)
  if (!found) throw new Error(`no button named ${text}`)
  return found
}

async function renderPicker(options: {
  value?: MemoLocation | null
  enableReverseGeocode?: boolean
} = {}): Promise<void> {
  if (rendered) {
    act(() => { rendered?.unmount() })
    rendered = null
  }
  onChange = vi.fn()
  onClose = vi.fn()
  rendered = renderElement(createElement(LocationPicker, {
    value: options.value ?? null,
    onChange: onChange as unknown as (value: MemoLocation | null) => void,
    onClose: onClose as unknown as () => void,
    enableReverseGeocode: options.enableReverseGeocode,
  }))
  await flush()
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => { rendered?.unmount() })
  rendered = null
  vi.unstubAllGlobals()
})

describe('the location picker', () => {
  it('fills the coordinates from a map click and applies the place name', async () => {
    await renderPicker()
    click(buttonNamed('pick-map'))

    const inputs = dialogInputs()
    expect(inputs[0].value).toBe('37.5')
    expect(inputs[1].value).toBe('-122.25')
    expect(document.body.textContent).toContain(t('memos.location.selected_point', {
      coordinates: '37.5, -122.25',
    }))

    setInputValue(inputs[2], 'Home')
    click(buttonNamed(t('memos.location.apply')))

    expect(onChange).toHaveBeenCalledWith({ placeholder: 'Home', latitude: 37.5, longitude: -122.25 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('validates typed latitude and longitude before applying', async () => {
    await renderPicker()
    const inputs = dialogInputs()
    setInputValue(inputs[0], '91')
    setInputValue(inputs[1], '-181')

    expect(document.body.textContent).toContain(t('memos.location.invalid_latitude'))
    expect(document.body.textContent).toContain(t('memos.location.invalid_longitude'))
    expect(buttonNamed(t('memos.location.apply')).disabled).toBe(true)

    setInputValue(inputs[0], '-90')
    setInputValue(inputs[1], '180')
    expect(buttonNamed(t('memos.location.apply')).disabled).toBe(false)
  })

  it('rejects non-numeric coordinates', async () => {
    await renderPicker()
    const inputs = dialogInputs()
    setInputValue(inputs[0], 'north')
    expect(document.body.textContent).toContain(t('memos.location.invalid_latitude'))
    expect(buttonNamed(t('memos.location.apply')).disabled).toBe(true)
  })

  it('keeps reverse geocoding behind its setting', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ display_name: 'Ferry Building' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchImpl)
    await renderPicker({ enableReverseGeocode: false })
    click(buttonNamed('pick-map'))

    expect([...document.querySelectorAll('[role="dialog"] button')].some(
      (button) => button.textContent?.trim() === t('memos.location.reverse'),
    )).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('looks up a place name only when asked', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ display_name: 'Ferry Building' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchImpl)
    await renderPicker({ enableReverseGeocode: true })
    click(buttonNamed('pick-map'))
    expect(fetchImpl).not.toHaveBeenCalled()

    click(buttonNamed(t('memos.location.reverse')))
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[1].headers).toEqual({ 'Accept-Language': 'en-US' })
    expect(dialogInputs()[2].value).toBe('Ferry Building')
  })

  it('reports a failed reverse lookup', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })))
    await renderPicker({ enableReverseGeocode: true })
    click(buttonNamed('pick-map'))
    click(buttonNamed(t('memos.location.reverse')))
    await flush()

    expect(document.body.textContent).toContain(t('memos.location.reverse_failed'))
  })

  it('clears the draft without emitting a value', async () => {
    await renderPicker({ value: { placeholder: 'Home', latitude: 1.5, longitude: 2.5 } })
    expect(dialogInputs()[0].value).toBe('1.5')
    expect(dialogInputs()[1].value).toBe('2.5')
    expect(dialogInputs()[2].value).toBe('Home')

    click(buttonNamed(t('memos.location.clear')))
    expect(dialogInputs()[0].value).toBe('')
    expect(dialogInputs()[1].value).toBe('')
    expect(dialogInputs()[2].value).toBe('')
    expect(buttonNamed(t('memos.location.apply')).disabled).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('applies an unchanged value and closes from cancel without changes', async () => {
    await renderPicker({ value: { placeholder: 'Home', latitude: 1.5, longitude: 2.5 } })
    click(buttonNamed(t('memos.common.cancel')))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()

    await renderPicker({ value: { placeholder: 'Home', latitude: 1.5, longitude: 2.5 } })
    click(buttonNamed(t('memos.location.apply')))
    expect(onChange).toHaveBeenCalledWith({ placeholder: 'Home', latitude: 1.5, longitude: 2.5 })
  })
})
