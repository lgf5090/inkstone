// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isToolkitRenderingNeeded,
  renderToolkitQRCode,
} from '../src/client/features/tools/qrcode/engine/qr-toolkit-engine'
import { crystalize } from '../src/client/features/tools/qrcode/engine/effects/crystalize'
import { liquidify } from '../src/client/features/tools/qrcode/engine/effects/liquidify'
import type { QrStylingOptions } from '../src/shared/tools/qrcode/types'

class MockImageData {
  data: Uint8ClampedArray
  width: number
  height: number
  constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight?: number, height?: number) {
    if (typeof dataOrWidth === 'number') {
      this.width = dataOrWidth
      this.height = widthOrHeight!
      this.data = new Uint8ClampedArray(this.width * this.height * 4)
    } else {
      this.data = dataOrWidth
      this.width = widthOrHeight!
      this.height = height!
    }
  }
}

const contextMap = new WeakMap<HTMLCanvasElement, any>()

function setupCanvasContextMock() {
  if (typeof globalThis.ImageData === 'undefined') {
    ;(globalThis as any).ImageData = MockImageData
  }

  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, contextId: string) {
    if (contextId === '2d') {
      let ctx = contextMap.get(this)
      if (!ctx) {
        ctx = {
          canvas: this,
          fillStyle: '#000000',
          strokeStyle: '#000000',
          lineWidth: 1,
          font: '10px sans-serif',
          imageSmoothingEnabled: false,
          fillRect: vi.fn(),
          strokeRect: vi.fn(),
          clearRect: vi.fn(),
          drawImage: vi.fn(),
          beginPath: vi.fn(),
          closePath: vi.fn(),
          moveTo: vi.fn(),
          lineTo: vi.fn(),
          arc: vi.fn(),
          arcTo: vi.fn(),
          stroke: vi.fn(),
          fill: vi.fn(),
          save: vi.fn(),
          restore: vi.fn(),
          clip: vi.fn(),
          rotate: vi.fn(),
          scale: vi.fn(),
          translate: vi.fn(),
          setTransform: vi.fn(),
          getImageData: vi.fn((x: number, y: number, w: number, h: number) => {
            return new (globalThis as any).ImageData(w, h)
          }),
          putImageData: vi.fn(),
        }
        contextMap.set(this, ctx)
      }
      return ctx
    }
    return null
  } as any
}

describe('QR Toolkit Engine & Effects', () => {
  beforeEach(() => {
    setupCanvasContextMock()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('detects when toolkit rendering is required', () => {
    const defaultOpts: QrStylingOptions = {
      errorCorrectionLevel: 'M',
      dotsOptions: { type: 'square' },
      cornersSquareOptions: { type: 'square' },
      cornersDotOptions: { type: 'square' },
      backgroundOptions: { color: '#ffffff' },
    }
    expect(isToolkitRenderingNeeded(defaultOpts)).toBe(false)

    expect(
      isToolkitRenderingNeeded({
        ...defaultOpts,
        toolkitOptions: { effect: 'liquidify' },
      })
    ).toBe(true)

    expect(
      isToolkitRenderingNeeded({
        ...defaultOpts,
        toolkitOptions: { marginNoise: true },
      })
    ).toBe(true)

    expect(
      isToolkitRenderingNeeded({
        ...defaultOpts,
        toolkitOptions: { pixelStyle: 'squircle' },
      })
    ).toBe(true)

    expect(
      isToolkitRenderingNeeded({
        ...defaultOpts,
        toolkitOptions: { markerShape: 'octagon' },
      })
    ).toBe(true)
  })

  it('renders QR code to canvas with toolkit options', async () => {
    const canvas = document.createElement('canvas')
    const res = await renderToolkitQRCode(canvas, 'https://inkstone.app/test', {
      errorCorrectionLevel: 'H',
      width: 400,
      margin: 4,
      dotsOptions: { type: 'square', color: '#112233' },
      cornersSquareOptions: { type: 'square' },
      cornersDotOptions: { type: 'square' },
      backgroundOptions: { color: '#f0f0f0' },
      toolkitOptions: {
        pixelStyle: 'rounded',
        markerShape: 'circle',
        markerInnerShape: 'circle',
        rotate: 90,
      },
    })

    expect(res.width).toBeGreaterThan(0)
    expect(res.size).toBeGreaterThan(0)
    expect(res.version).toBeGreaterThanOrEqual(1)
    expect(canvas.width).toBe(res.width)
  })

  it('renders with independent marker settings and margin noise', async () => {
    const canvas = document.createElement('canvas')
    const res = await renderToolkitQRCode(canvas, 'Independent Markers', {
      errorCorrectionLevel: 'Q',
      width: 500,
      dotsOptions: { type: 'square' },
      cornersSquareOptions: { type: 'square' },
      cornersDotOptions: { type: 'square' },
      backgroundOptions: { color: '#ffffff' },
      toolkitOptions: {
        markerShape: 'box',
        markerInnerShape: 'plus',
        markers: [
          { markerShape: 'circle', markerInnerShape: 'circle' },
          { markerShape: 'octagon', markerInnerShape: 'diamond' },
        ],
        marginNoise: true,
        marginNoiseRate: 0.6,
        marginNoiseSpace: 'marker',
      },
    })

    expect(res.size).toBeGreaterThan(0)
    expect(canvas.getContext('2d')).not.toBeNull()
  })

  it('executes crystalize Delaunay effect on ImageData', () => {
    const width = 60
    const height = 60
    const raw = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < raw.length; i += 4) {
      raw[i] = 120
      raw[i + 1] = 150
      raw[i + 2] = 200
      raw[i + 3] = 255
    }
    const input = new (globalThis as any).ImageData(raw, width, height)
    const result = crystalize(input, 10, 100)

    expect(result.width).toBe(width)
    expect(result.height).toBe(height)
    expect(result.data.length).toBe(raw.length)
  })

  it('executes liquidify threshold effect on ImageData', () => {
    const width = 40
    const height = 40
    const raw = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < raw.length; i += 4) {
      raw[i] = 250
      raw[i + 1] = 250
      raw[i + 2] = 250
      raw[i + 3] = 255
    }
    const input = new (globalThis as any).ImageData(raw, width, height)
    const result = liquidify(input, 2, 128, '#ffffff', '#000000')

    expect(result.width).toBe(width)
    expect(result.height).toBe(height)
    expect(result.data.length).toBe(raw.length)
  })
})
