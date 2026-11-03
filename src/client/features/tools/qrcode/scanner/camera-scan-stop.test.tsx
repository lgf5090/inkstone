/**
 * A decoded code stops the camera loop.
 *
 * The loop used to keep decoding the same frame four times a second for as long as the scanner
 * stayed open, so one code in front of the lens produced an endless stream of result updates.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CameraScanner } from './CameraScanner'

const pipeline = vi.hoisted(() => ({
  scanCanvas: vi.fn(async () => ({ text: 'decoded', format: 'qr', durationMs: 1 })),
}))

vi.mock('./scan-pipeline', () => ({
  preprocessImageToCanvas: () => ({}),
  scanCanvas: pipeline.scanCanvas,
}))

vi.mock('../../../../lib/i18n', () => ({ t: (key: string) => key }))

let root: Root
let container: HTMLDivElement
let scans = 0

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  pipeline.scanCanvas.mockClear()
  scans = 0
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'cam-1', label: 'Camera' }],
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('camera scanner loop', () => {
  it('decodes once and then pauses itself', async () => {
    await act(async () => {
      root.render(createElement(CameraScanner, { onScan: () => { scans += 1 } }))
      await Promise.resolve()
    })
    const video = container.querySelector('video')!
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 })

    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(scans).toBe(1)
    expect(pipeline.scanCanvas).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(scans).toBe(1)
    expect(pipeline.scanCanvas).toHaveBeenCalledTimes(1)
  })
})
