// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import {
  preprocessImageToCanvas,
  scanCanvas,
} from '../src/client/features/tools/qrcode/scanner/scan-pipeline'
import {
  compareSegments,
  generateControlNetMask,
  type Segment,
} from '../src/client/features/tools/qrcode/compare/diff-engine'
import {
  generateRandomString,
  runBatchGeneration,
} from '../src/client/features/tools/qrcode/batch/batch-engine'
import { QrScannerView } from '../src/client/features/tools/qrcode/scanner/QrScannerView'
import { QrCompareView } from '../src/client/features/tools/qrcode/compare/QrCompareView'
import { QrBatchView } from '../src/client/features/tools/qrcode/batch/QrBatchView'
import { AiEffectsTab } from '../src/client/features/tools/qrcode/options/AiEffectsTab'
import { DEFAULT_QR_OPTIONS } from '../src/client/features/tools/qrcode/engine/qr-engine'

// Mock jsQR
vi.mock('jsqr', () => {
  return {
    default: vi.fn((_data, width, height) => {
      if (width > 0 && height > 0) {
        return {
          data: 'https://inkstone.app/scanned-sample',
          location: {
            topLeftCorner: { x: 10, y: 10 },
            topRightCorner: { x: 90, y: 10 },
            bottomRightCorner: { x: 90, y: 90 },
            bottomLeftCorner: { x: 10, y: 90 },
          },
        }
      }
      return null
    }),
  }
})

class MockImageData {
  width: number
  height: number
  data: Uint8ClampedArray

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

describe('QR Toolkit Ported Features', () => {
  const contextMap = new WeakMap<HTMLCanvasElement, any>()

  beforeEach(async () => {
    installTestGlobals()
    await initI18n()

    if (typeof globalThis.ImageData === 'undefined') {
      ;(globalThis as any).ImageData = MockImageData
    }

    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, contextId: string) {
      if (contextId === '2d') {
        let ctx = contextMap.get(this)
        if (!ctx) {
          ctx = {
            canvas: this,
            filter: 'none',
            fillStyle: '#000000',
            strokeStyle: '#000000',
            lineWidth: 1,
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
            roundRect: vi.fn(),
            ellipse: vi.fn(),
            stroke: vi.fn(),
            fill: vi.fn(),
            save: vi.fn(),
            restore: vi.fn(),
            clip: vi.fn(),
            translate: vi.fn(),
            scale: vi.fn(),
            rotate: vi.fn(),
            transform: vi.fn(),
            setTransform: vi.fn(),
            resetTransform: vi.fn(),
            createImageData: vi.fn((w: number, h: number) => new MockImageData(w, h)),
            getImageData: vi.fn(() => ({
              data: new Uint8ClampedArray(400 * 400 * 4),
              width: 400,
              height: 400,
            })),
            putImageData: vi.fn(),
          }
          contextMap.set(this, ctx)
        }
        return ctx
      }
      return null
    } as any

    HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback, type = 'image/png') {
      callback(new Blob(['mock-bytes'], { type }))
    }

    HTMLCanvasElement.prototype.toDataURL = function () {
      return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Scan Pipeline', () => {
    it('preprocesses image with contrast, brightness, and grayscale', () => {
      const img = new Image(500, 500)
      const canvas = preprocessImageToCanvas(img, {
        contrast: 120,
        brightness: 110,
        blur: 2,
        grayscale: true,
        resize: 800,
      })

      expect(canvas.width).toBe(500)
      expect(canvas.height).toBe(500)
      const ctx = canvas.getContext('2d')
      expect(ctx).not.toBeNull()
    })

    it('scans canvas and decodes QR string with location points', async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 200
      canvas.height = 200
      const result = await scanCanvas(canvas)

      expect(result).not.toBeNull()
      expect(result?.text).toBe('https://inkstone.app/scanned-sample')
      expect(result?.durationMs).toBeGreaterThanOrEqual(0)
      expect(result?.location?.topLeft.x).toBe(10)
    })
  })

  describe('Diff Engine for AI QR Codes', () => {
    it('compares segments and computes mismatch counts and scanability score', () => {
      const gridSize = 10
      const total = gridSize * gridSize
      const mockAiSegs: Segment[] = []
      const mockRefSegs: Segment[] = []

      for (let i = 0; i < total; i++) {
        const x = i % gridSize
        const y = Math.floor(i / gridSize)
        const isExpectedLight = i % 2 === 0
        mockAiSegs.push({
          index: i,
          x,
          y,
          color: [200, 200, 200, 255],
          luminance: isExpectedLight ? 240 : 20,
          value: isExpectedLight ? 1 : 0,
          expected: isExpectedLight ? 1 : 0,
          isMargin: false,
        })
        mockRefSegs.push({
          index: i,
          x,
          y,
          color: [0, 0, 0, 255],
          luminance: isExpectedLight ? 255 : 0,
          value: isExpectedLight ? 1 : 0,
          expected: isExpectedLight ? 1 : 0,
          isMargin: false,
        })
      }

      // Flip luminance on inner modules (not margin) to trigger mismatches
      // Index 22: x=2, y=2 (inner), expected 1 (light), flip to dark (20)
      mockAiSegs[22].luminance = 20
      // Index 23: x=3, y=2 (inner), expected 0 (dark), flip to light (240)
      mockAiSegs[23].luminance = 240

      const diff = compareSegments(mockAiSegs, mockRefSegs, gridSize, 1, 20)
      expect(diff.segments.length).toBe(total)
      expect(diff.mismatchCount).toBe(2)
      expect(diff.scanabilityScore).toBeGreaterThan(80)
    })

    it('generates ControlNet inpaint mask canvas', () => {
      const gridSize = 10
      const mockDiff = {
        segments: [],
        mainSegments: [],
        mismatchDark: [{ x: 3, y: 3, index: 33, color: [0, 0, 0, 255] as any, luminance: 0, value: 0, expected: 1, isMargin: false }],
        mismatchLight: [{ x: 4, y: 4, index: 44, color: [255, 255, 255, 255] as any, luminance: 255, value: 1, expected: 0, isMargin: false }],
        mismatchCount: 2,
        averageLuminance: 128,
        lightLuminance: 255,
        darkLuminance: 0,
        scanabilityScore: 90,
      }

      const maskCanvas = generateControlNetMask(mockDiff, gridSize, 'mask')
      expect(maskCanvas.width).toBe(1024)
      expect(maskCanvas.height).toBe(1024)

      const corrCanvas = generateControlNetMask(mockDiff, gridSize, 'correction')
      expect(corrCanvas.width).toBe(1024)
    })
  })

  describe('Batch Generation Engine', () => {
    it('generates random alphanumeric strings', () => {
      const s1 = generateRandomString(12)
      const s2 = generateRandomString(24)
      expect(s1.length).toBe(12)
      expect(s2.length).toBe(24)
      expect(s1).not.toBe(s2)
    })

    it('runs batch generation and packages zip blob', async () => {
      const progressTracker: number[] = []
      const zipBlob = await runBatchGeneration({
        items: [
          { text: 'https://test1.com', filename: 'qr-1' },
          { text: 'https://test2.com', filename: 'qr-2' },
        ],
        size: 300,
        format: 'png',
        randomizeStyle: true,
        baseOptions: DEFAULT_QR_OPTIONS,
        onProgress: (cur) => progressTracker.push(cur),
      })

      expect(zipBlob).toBeInstanceOf(Blob)
      expect(zipBlob.type).toBe('application/zip')
      expect(progressTracker).toContain(2)
    })
  })

  describe('View Components Rendering', () => {
    it('renders QrScannerView with file and camera modes', () => {
      const view = renderElement(<QrScannerView />)
      expect(view.container.textContent).toContain(t('tools.qrcode.scanner.title'))
      expect(view.container.textContent).toContain(t('tools.qrcode.scanner.mode_file'))
      expect(view.container.textContent).toContain(t('tools.qrcode.scanner.mode_camera'))
      view.unmount()
    })

    it('renders QrCompareView with AI and Reference upload areas', () => {
      const view = renderElement(<QrCompareView />)
      expect(view.container.textContent).toContain(t('tools.qrcode.compare.title'))
      expect(view.container.textContent).toContain(t('tools.qrcode.compare.ai_image_label'))
      expect(view.container.textContent).toContain(t('tools.qrcode.compare.reference_qr_label'))
      view.unmount()
    })

    it('renders QrBatchView with multi-line and random generation options', () => {
      const view = renderElement(<QrBatchView />)
      expect(view.container.textContent).toContain(t('tools.qrcode.batch.title'))
      expect(view.container.textContent).toContain(t('tools.qrcode.batch.mode_lines'))
      expect(view.container.textContent).toContain(t('tools.qrcode.batch.mode_random'))
      view.unmount()
    })

    it('renders AiEffectsTab with effects and transform sliders', () => {
      const view = renderElement(<AiEffectsTab />)
      expect(view.container.textContent).toContain(t('tools.qrcode.ai.effects_title'))
      expect(view.container.textContent).toContain(t('tools.qrcode.ai.transform_title'))
      expect(view.container.textContent).toContain(t('tools.qrcode.ai.noise_title'))
      view.unmount()
    })
  })
})
