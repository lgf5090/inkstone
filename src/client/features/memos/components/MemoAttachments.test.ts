// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMO_PREFERENCES_DEFAULTS } from '@shared/memos/constants'
import type { MemoAttachment } from '@shared/memos/types'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { useUi } from '../../../store/ui'
import { MemoAttachments } from './MemoAttachments'

const api = vi.hoisted(() => ({
  preferences: { get: vi.fn() },
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, memosApi: api }
})

const ai = vi.hoisted(() => ({
  providers: vi.fn(),
  transcribe: vi.fn(),
}))

vi.mock('../ai-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai-client')>()
  return { ...actual, memoAi: ai }
})

let view: RenderedElement | null = null
let nextId = 0

function attachment(overrides: Partial<MemoAttachment> = {}): MemoAttachment {
  nextId += 1
  return {
    id: `attachment-${nextId}`,
    filename: `photo-${nextId}.jpg`,
    mime: 'image/jpeg',
    size: 2048,
    width: 1200,
    height: 800,
    url: `/api/memos/files/attachment-${nextId}`,
    thumbnailUrl: null,
    motion: null,
    mediaMetadata: null,
    createdAt: 1_700_000_000,
    ...overrides,
  }
}

function render(attachments: MemoAttachment[], compact = false): RenderedElement {
  view = renderElement(createElement(MemoAttachments, { attachments, compact }))
  return view
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

function press(key: string, target: EventTarget = window): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function pointer(type: string, target: Element, init: PointerEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...init }))
  })
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]')
}

function buttonWithText(text: string, root: ParentNode = document): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`no button containing ${text}`)
  return button
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  useUi.setState({ toasts: [] })
  vi.clearAllMocks()
  api.preferences.get.mockResolvedValue(MEMO_PREFERENCES_DEFAULTS)
  ai.providers.mockResolvedValue([])
})

async function flush(times = 2): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('the memo attachment gallery', () => {
  it('renders one image lazily with its dimensions and opens a caption on click', () => {
    const item = attachment({ filename: 'harbour.jpg', width: 1600, height: 900 })
    const rendered = render([item])
    const image = rendered.container.querySelector('img')
    expect(image?.getAttribute('alt')).toBe('harbour.jpg')
    expect(image?.getAttribute('loading')).toBe('lazy')
    expect(image?.getAttribute('decoding')).toBe('async')
    expect(image?.getAttribute('width')).toBe('1600')
    expect(image?.getAttribute('height')).toBe('900')

    const trigger = rendered.container.querySelector<HTMLButtonElement>('button[aria-label="Open image harbour.jpg"]')
    expect(trigger).not.toBeNull()
    trigger!.focus()
    click(trigger!)

    const panel = dialog()
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('harbour.jpg')
    expect(panel?.querySelector('img')?.getAttribute('alt')).toBe('harbour.jpg')
    expect(document.activeElement instanceof HTMLElement && panel!.contains(document.activeElement)).toBe(true)
  })

  it('walks images with the arrow keys, traps Tab, closes on Escape and returns focus', () => {
    const firstItem = attachment({ filename: 'first.jpg' })
    const secondItem = attachment({ filename: 'second.jpg' })
    const rendered = render([firstItem, secondItem])
    const triggers = rendered.container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Open image"]')
    expect(triggers).toHaveLength(2)
    triggers[0]!.focus()
    click(triggers[0]!)

    expect(dialog()?.textContent).toContain(t('memos.media.counter', { index: 1, total: 2 }))
    press('ArrowRight')
    expect(dialog()?.textContent).toContain(t('memos.media.counter', { index: 2, total: 2 }))
    expect(dialog()?.textContent).toContain('second.jpg')
    press('ArrowRight')
    expect(dialog()?.textContent).toContain(t('memos.media.counter', { index: 1, total: 2 }))
    press('ArrowLeft')
    expect(dialog()?.textContent).toContain(t('memos.media.counter', { index: 2, total: 2 }))

    const panel = dialog()!
    const focusables = [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    const last = focusables[focusables.length - 1]!
    last.focus()
    press('Tab', document)
    expect(document.activeElement).toBe(focusables[0])

    press('Escape')
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(triggers[0])
  })

  it('renders videos, audio and documents with controls and accessible names', async () => {
    const video = attachment({
      filename: 'clip.mp4',
      mime: 'video/mp4',
      thumbnailUrl: '/poster.jpg',
      mediaMetadata: { video: { durationSeconds: 65 } },
    })
    const audio = attachment({ filename: 'voice.mp3', mime: 'audio/mpeg' })
    const document = attachment({ filename: 'notes.pdf', mime: 'application/pdf', size: 4096 })
    const rendered = render([video, audio, document])
    await flush()

    const videoElement = rendered.container.querySelector('video')
    expect(videoElement).not.toBeNull()
    expect(videoElement?.hasAttribute('controls')).toBe(true)
    expect(videoElement?.getAttribute('aria-label')).toBe('clip.mp4')
    expect(videoElement?.getAttribute('poster')).toBe('/poster.jpg')

    const audioElement = rendered.container.querySelector('audio')
    expect(audioElement).not.toBeNull()
    expect(audioElement?.hasAttribute('controls')).toBe(false)
    expect(audioElement?.getAttribute('preload')).toBe('metadata')
    expect(audioElement?.getAttribute('aria-hidden')).toBe('true')
    expect(rendered.container.querySelector(`button[aria-label="${t('memos.media.audio_play')}"]`)).not.toBeNull()
    expect(rendered.container.querySelector('input[type="range"]')).not.toBeNull()
    expect(rendered.container.querySelector('a[aria-label="Download voice.mp3"]')).not.toBeNull()
    const transcribe = [...rendered.container.querySelectorAll('button')]
      .find((item) => item.textContent?.includes(t('memos.media.transcribe')))
    expect(transcribe?.disabled).toBe(true)

    expect(rendered.container.querySelector('a[aria-label="Open notes.pdf"]')).not.toBeNull()
    expect(rendered.container.querySelector('a[aria-label="Download notes.pdf"]')).not.toBeNull()
    expect(rendered.container.textContent).toContain('4.0 KB')
    expect(rendered.container.textContent).toContain(t('memos.media.video_duration', { duration: '1:05' }))
  })

  it('falls back from the thumbnail to the original and then to a download row', () => {
    const item = attachment({
      filename: 'broken.jpg',
      url: '/api/memos/files/full',
      thumbnailUrl: '/api/memos/files/thumb',
    })
    const rendered = render([item])
    let image = rendered.container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('/api/memos/files/thumb')
    act(() => { image!.dispatchEvent(new Event('error')) })
    image = rendered.container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('/api/memos/files/full')
    act(() => { image!.dispatchEvent(new Event('error')) })

    expect(rendered.container.querySelector('img')).toBeNull()
    const fallback = rendered.container.querySelector('[role="status"]')
    expect(fallback?.textContent).toContain(t('memos.media.image_failed'))
    expect(fallback?.querySelector('a[aria-label="Download broken.jpg"]')).not.toBeNull()
  })

  it('shows capture metadata below an image in the detail view but not on a card', () => {
    const item = attachment({
      filename: 'trip.jpg',
      mediaMetadata: {
        photo: {
          width: 1200,
          height: 800,
          captureTime: { local: '2024-05-01 10:20:30', offsetMinutes: 480 },
          cameraMake: 'Apple',
          cameraModel: 'iPhone 15 Pro',
          lensModel: 'Main Camera',
          fNumber: 1.8,
          exposureTimeSeconds: 1 / 120,
          iso: 100,
          focalLengthMm: 24,
        },
      },
    })
    const detail = render([item])
    expect(detail.container.textContent).toContain('Captured 2024-05-01 10:20:30')
    expect(detail.container.textContent).toContain('Apple iPhone 15 Pro')
    expect(detail.container.textContent).toContain('Main Camera')
    expect(detail.container.textContent).toContain('24 mm · f/1.8 · 1/120 s · ISO 100')

    act(() => { view?.unmount() })
    view = null
    document.body.innerHTML = ''
    const compact = render([item], true)
    expect(compact.container.textContent).not.toContain('Captured 2024-05-01 10:20:30')
  })

  it('plays the paired motion video of a Live Photo from the viewer', () => {
    const item = attachment({
      filename: 'live.jpg',
      url: '/api/memos/files/live',
      motion: { groupId: 'group-1', role: 'still' },
    })
    const rendered = render([item])
    expect(rendered.container.textContent).toContain(t('memos.media.live_photo'))
    const trigger = rendered.container.querySelector<HTMLButtonElement>('button[aria-label="Open Live Photo live.jpg"]')
    expect(trigger).not.toBeNull()
    click(trigger!)

    click(buttonWithText(t('memos.media.play_motion'), dialog()!))
    const video = dialog()?.querySelector('video')
    expect(video).not.toBeNull()
    expect(video?.getAttribute('src')).toBe('/api/memos/files/live?motion=1')
    expect(video?.hasAttribute('controls')).toBe(true)
    expect(video?.getAttribute('aria-label')).toBe(t('memos.media.motion_video_label', { name: 'live.jpg' }))

    click(buttonWithText(t('memos.media.show_still'), dialog()!))
    expect(dialog()?.querySelector('video')).toBeNull()
    expect(dialog()?.querySelector('img')).not.toBeNull()
  })

  it('previews a Live Photo on a tile while the pointer is over it', () => {
    const item = attachment({
      filename: 'live.jpg',
      url: '/api/memos/files/live',
      motion: { groupId: 'group-1', role: 'still' },
    })
    const rendered = render([item])
    const tile = rendered.container.querySelector<HTMLButtonElement>('button[aria-label="Open Live Photo live.jpg"]')
    expect(tile).not.toBeNull()
    expect(rendered.container.querySelector('video')).toBeNull()

    pointer('pointerover', tile!)
    const preview = rendered.container.querySelector('video')
    expect(preview).not.toBeNull()
    expect(preview?.getAttribute('src')).toBe('/api/memos/files/live?motion=1')
    expect(preview?.hasAttribute('autoplay')).toBe(true)
    expect(preview?.hasAttribute('loop')).toBe(true)
    expect(preview?.muted).toBe(true)
    expect(preview?.getAttribute('data-memo-motion-preview')).toBe('')

    pointer('pointerout', tile!)
    expect(rendered.container.querySelector('video')).toBeNull()

    pointer('pointerdown', tile!)
    expect(rendered.container.querySelector('video')).not.toBeNull()
    pointer('pointerup', tile!)
    expect(rendered.container.querySelector('video')).toBeNull()
  })

  it('keeps a still image still on hover and under reduced motion', () => {
    const still = attachment({ filename: 'still.jpg' })
    const rendered = render([still])
    const tile = rendered.container.querySelector('button[aria-label="Open image still.jpg"]')
    pointer('pointerover', tile!)
    expect(rendered.container.querySelector('video')).toBeNull()

    act(() => { view?.unmount() })
    view = null
    document.body.innerHTML = ''
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion: reduce'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })))
    const live = attachment({
      filename: 'live.jpg',
      motion: { groupId: 'group-2', role: 'still' },
    })
    const reduced = render([live])
    const liveTile = reduced.container.querySelector<HTMLButtonElement>('button[aria-label="Open Live Photo live.jpg"]')
    pointer('pointerover', liveTile!)
    pointer('pointerdown', liveTile!)
    expect(reduced.container.querySelector('video')).toBeNull()
  })

  it('builds a collage and reports the attachments a compact card leaves out', () => {
    const items = Array.from({ length: 5 }, () => attachment())
    const rendered = render(items, true)
    expect(rendered.container.querySelectorAll('button[aria-label^="Open image"]')).toHaveLength(4)
    expect(rendered.container.textContent).toContain(t('memos.attachments.more', { count: 1 }))
  })
})
