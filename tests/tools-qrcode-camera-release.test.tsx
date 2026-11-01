// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { CameraScanner } from '../src/client/features/tools/qrcode/scanner/CameraScanner'

function fakeStream() {
  const track = { kind: 'video', stop: vi.fn() }
  return { stream: { getTracks: () => [track], getVideoTracks: () => [track] }, track }
}

describe('camera scanner releases the device when paused', () => {
  let getUserMedia: ReturnType<typeof vi.fn>
  let acquired: ReturnType<typeof fakeStream>[]

  beforeEach(() => {
    installTestGlobals()
    void initI18n()
    acquired = []
    getUserMedia = vi.fn(async () => {
      const made = fakeStream()
      acquired.push(made)
      return made.stream
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
    })
    HTMLMediaElement.prototype.play = vi.fn(async () => undefined)
  })

  const button = (container: HTMLElement, label: string) =>
    Array.from(container.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === label)

  it('stops every track and clears the element when the reader pauses', async () => {
    const view = await renderElement(<CameraScanner onScan={() => undefined} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(acquired[0].track.stop).not.toHaveBeenCalled()

    const pause = button(view.container, t('tools.qrcode.scanner.pause_camera'))
    expect(pause, 'no pause control').toBeDefined()
    await act(async () => {
      pause?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(acquired[0].track.stop, 'the camera stayed open behind a paused label').toHaveBeenCalled()
    const video = view.container.querySelector('video')
    expect(video?.srcObject, 'the frozen frame still reads as a live feed').toBeNull()

    const resume = button(view.container, t('tools.qrcode.scanner.resume_camera'))
    expect(resume, 'no resume control after pausing').toBeDefined()
    await act(async () => {
      resume?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(getUserMedia).toHaveBeenCalledTimes(2)

    await act(async () => {
      view.unmount()
    })
    expect(acquired[1].track.stop).toHaveBeenCalled()
  })
})
