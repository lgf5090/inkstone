// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  exportQrToBlob,
  exportQrToDataUrl,
  downloadQrCode,
  copyQrCodeToClipboard,
  dataUrlToBlob,
  ensureSolidBackground,
  canvasToBlob,
} from '../src/client/features/tools/qrcode/engine/export-pipeline'
import {
  applyFrame,
  drawRoundRect,
} from '../src/client/features/tools/qrcode/engine/frame-decorator'
import {
  QrEngine,
  DEFAULT_QR_OPTIONS,
  mapEyeShapeToCornerOptions,
  buildQrCodeStylingOptions,
  prepareStyledLogo,
} from '../src/client/features/tools/qrcode/engine/qr-engine'
import {
  applyTextCaption,
  applyTextCaptionToSvg,
  calculateEffectiveFontSize,
  wrapTextLines,
} from '../src/client/features/tools/qrcode/engine/text-decorator'
import {
  ONLINE_LOGOS,
  getOnlineLogoById,
  getOnlineLogoDataUrl,
} from '../src/shared/tools/qrcode/online-logos'
import {
  QR_PRESETS,
  getPresetById,
  getPresetsByCategory,
} from '../src/shared/tools/qrcode/presets'
import type { QrFrameType } from '../src/shared/tools/qrcode/types'

const contextMap = new WeakMap<HTMLCanvasElement, any>()

function setupCanvasContextMock() {
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
          textAlign: 'center',
          textBaseline: 'alphabetic',
          shadowColor: 'transparent',
          shadowBlur: 0,
          shadowOffsetX: 0,
          shadowOffsetY: 0,
          fillRect: vi.fn(),
          strokeRect: vi.fn(),
          clearRect: vi.fn(),
          drawImage: vi.fn(),
          fillText: vi.fn(),
          strokeText: vi.fn(),
          measureText: vi.fn((text: string) => ({ width: text.length * 10 })),
          beginPath: vi.fn(),
          closePath: vi.fn(),
          moveTo: vi.fn(),
          lineTo: vi.fn(),
          arc: vi.fn(),
          arcTo: vi.fn(),
          bezierCurveTo: vi.fn(),
          quadraticCurveTo: vi.fn(),
          stroke: vi.fn(),
          fill: vi.fn(),
          save: vi.fn(),
          restore: vi.fn(),
          clip: vi.fn(),
          setLineDash: vi.fn(),
          getLineDash: vi.fn(() => []),
          createLinearGradient: vi.fn(() => ({
            addColorStop: vi.fn(),
          })),
          createRadialGradient: vi.fn(() => ({
            addColorStop: vi.fn(),
          })),
        }
        contextMap.set(this, ctx)
      }
      return ctx
    }
    return null
  } as any

  HTMLCanvasElement.prototype.toDataURL = function (this: HTMLCanvasElement, type = 'image/png') {
    return `data:${type};base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==`
  }

  HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, callback, type = 'image/png') {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const binary = atob(b64)
    const array = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i)
    callback(new Blob([array], { type }))
  }

  class MockImage {
    naturalWidth = 200
    naturalHeight = 200
    crossOrigin = ''
    private _src = ''
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    get src() {
      return this._src
    }
    set src(val: string) {
      this._src = val
      setTimeout(() => {
        if (val.includes('error-image')) {
          if (this.onerror) this.onerror()
        } else {
          if (this.onload) this.onload()
        }
      }, 0)
    }
  }
  globalThis.Image = MockImage as any
}

describe('QR Code Engine & Beautification System', () => {
  beforeEach(() => {
    setupCanvasContextMock()
  })

  describe('Online Logos Library', () => {
    it('contains all 9 required online logos', () => {
      const expectedIds = [
        'wechat',
        'qq',
        'taobao',
        'weibo',
        'qzone',
        'twitter',
        'facebook',
        'fingerprint',
        'redpacket',
      ]
      expect(ONLINE_LOGOS).toHaveLength(9)
      for (const id of expectedIds) {
        const found = ONLINE_LOGOS.find((l) => l.id === id)
        expect(found).toBeDefined()
        expect(found?.name).toBeTruthy()
        expect(found?.nameKey).toContain('tools.qrcode.logos.')
        expect(found?.svg).toContain('<svg')
        expect(found?.svg).toContain('</svg>')
        expect(found?.dataUrl).toMatch(/^data:image\/svg\+xml;utf8,/)
      }
    })

    it('retrieves logo by id and returns undefined for unknown id', () => {
      const wechat = getOnlineLogoById('wechat')
      expect(wechat?.name).toBe('WeChat')
      expect(getOnlineLogoById('non-existent')).toBeUndefined()
    })

    it('retrieves logo Data URL directly', () => {
      const dataUrl = getOnlineLogoDataUrl('taobao')
      expect(dataUrl).toContain('data:image/svg+xml;utf8,')
      expect(dataUrl).toContain('%3Csvg')
      expect(getOnlineLogoDataUrl('unknown')).toBeUndefined()
    })
  })

  describe('Presets Library', () => {
    it('contains all 15 reference presets across 4 categories', () => {
      expect(QR_PRESETS).toHaveLength(15)

      const minimal = getPresetsByCategory('minimal')
      expect(minimal.map((p) => p.id)).toEqual([
        'default',
        'wecom',
        'simple-dots',
        'liquid-gradient',
        'bar-gradient',
        'square-jump',
      ])

      const frame = getPresetsByCategory('frame')
      expect(frame.map((p) => p.id)).toEqual([
        'dark-green-frame',
        'red-blue-gradient',
        'three-color-card',
        'heart-border',
        'liquid-stamp',
      ])

      const artistic = getPresetsByCategory('artistic')
      expect(artistic.map((p) => p.id)).toEqual(['pacman'])

      const scenario = getPresetsByCategory('scenario')
      expect(scenario.map((p) => p.id)).toEqual([
        'taobao',
        'meme-bubble',
        'mushroom-meme',
      ])
    })

    it('retrieves preset by ID correctly', () => {
      const wecom = getPresetById('wecom')
      expect(wecom).toBeDefined()
      expect(wecom?.name).toBe('WeCom')
      expect(wecom?.options.dotsOptions.color).toBe('#1877f2')

      expect(getPresetById('unknown')).toBeUndefined()
    })

    it('ensures each preset has valid styling options and frame settings', () => {
      for (const preset of QR_PRESETS) {
        expect(preset.options.errorCorrectionLevel).toMatch(/^[LMQH]$/)
        expect(preset.options.dotsOptions.type).toBeDefined()
        expect(preset.options.cornersSquareOptions).toBeDefined()
        expect(preset.options.backgroundOptions).toBeDefined()

        if (preset.category === 'frame' || preset.options.frameOptions?.type !== 'none') {
          expect(preset.options.frameOptions?.type).toBeTruthy()
        }
      }
    })
  })

  describe('Text Caption Decorator', () => {
    it('calculates proportional font size relative to 1000px base width', () => {
      expect(calculateEffectiveFontSize(35, 1000)).toBe(35)
      expect(calculateEffectiveFontSize(50, 1000)).toBe(50)
      expect(calculateEffectiveFontSize(35, 500)).toBe(18)
      expect(calculateEffectiveFontSize(20, 100)).toBe(12)
    })

    it('returns original canvas when caption is disabled or empty', () => {
      const canvas = document.createElement('canvas')
      canvas.width = 300
      canvas.height = 300

      const disabledResult = applyTextCaption(canvas, {
        enabled: false,
        content: 'Hello',
        fontSize: 30,
        fontFamily: 'sans-serif',
        color: '#000',
        position: 'bottom',
      })
      expect(disabledResult).toBe(canvas)

      const emptyResult = applyTextCaption(canvas, {
        enabled: true,
        content: '   \n  ',
        fontSize: 30,
        fontFamily: 'sans-serif',
        color: '#000',
        position: 'bottom',
      })
      expect(emptyResult).toBe(canvas)
    })

    it('adds text caption height and draws multiline text with underline', () => {
      const canvas = document.createElement('canvas')
      canvas.width = 500
      canvas.height = 500

      const result = applyTextCaption(canvas, {
        enabled: true,
        content: '第一行说明文字\n第二行扫码关注',
        fontSize: 40,
        fontFamily: 'sans-serif',
        bold: true,
        italic: true,
        underline: true,
        color: '#ff0000',
        position: 'bottom',
      })

      expect(result).not.toBe(canvas)
      expect(result.width).toBe(500)
      expect(result.height).toBeGreaterThan(500)

      const ctx = result.getContext('2d') as any
      expect(ctx.fillText).toHaveBeenCalled()
      expect(ctx.stroke).toHaveBeenCalled()
    })

    it('wraps long lines automatically into multiple lines without overflowing', () => {
      const canvas = document.createElement('canvas')
      canvas.width = 300
      canvas.height = 300

      const longText = '这是一段非常长的说明文字用来测试文字折行功能是否生效并且防止水平溢出画布'
      const wrapped = wrapTextLines(null, longText, 150, 18)
      expect(wrapped.length).toBeGreaterThan(1)

      const result = applyTextCaption(canvas, {
        enabled: true,
        content: longText,
        fontSize: 30,
      })
      expect(result.height).toBeGreaterThan(300)
    })

    it('supports top position caption layout', () => {
      const canvas = document.createElement('canvas')
      canvas.width = 400
      canvas.height = 400

      const result = applyTextCaption(canvas, {
        enabled: true,
        content: '顶部标题文字',
        fontSize: 30,
        fontFamily: 'sans-serif',
        color: '#000000',
        position: 'top',
      })

      expect(result.height).toBeGreaterThan(400)
      const ctx = result.getContext('2d') as any
      expect(ctx.drawImage).toHaveBeenCalledWith(canvas, 0, expect.any(Number))
    })

    it('decorates SVG with caption tags and preserves inner nested SVGs', () => {
      const sampleSvg = '<svg width="500" height="500"><g><svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg></g></svg>'
      const outputSvg = applyTextCaptionToSvg(sampleSvg, {
        enabled: true,
        content: '扫码即刻体验',
        fontSize: 30,
        fontFamily: 'sans-serif',
        color: '#1877f2',
        position: 'bottom',
      })

      expect(outputSvg).toContain('<text')
      expect(outputSvg).toContain('扫码即刻体验')
      expect(outputSvg).toContain('<svg viewBox="0 0 24 24">')
      expect(outputSvg).toContain('</svg>')
    })
  })

  describe('Frame Decorator', () => {
    it('draws rounded rectangles with safe bounds', () => {
      const canvas = document.createElement('canvas')
      canvas.width = 200
      canvas.height = 200
      const ctx = canvas.getContext('2d')!

      drawRoundRect(ctx, 10, 10, 100, 100, 15)
      expect(ctx.beginPath).toHaveBeenCalled()
      expect(ctx.arcTo).toHaveBeenCalledTimes(4)
      expect(ctx.closePath).toHaveBeenCalled()
    })

    it('returns original canvas when frame type is none', () => {
      const canvas = document.createElement('canvas')
      canvas.width = 300
      canvas.height = 300

      const res = applyFrame(canvas, { type: 'none' })
      expect(res).toBe(canvas)
    })

    const frameTypes: QrFrameType[] = [
      'dark-green',
      'red-blue',
      'three-color',
      'heart',
      'liquid-stamp',
      'pacman',
      'meme-bubble',
      'mushroom',
    ]

    for (const frameType of frameTypes) {
      it(`renders frame type "${frameType}" successfully`, () => {
        const sourceCanvas = document.createElement('canvas')
        sourceCanvas.width = 400
        sourceCanvas.height = 400

        const framed = applyFrame(sourceCanvas, {
          type: frameType,
          label: `Test ${frameType}`,
          color: '#123456',
          secondaryColor: '#abcdef',
        })

        expect(framed).not.toBe(sourceCanvas)
        expect(framed.width).toBeGreaterThanOrEqual(400)
        expect(framed.height).toBeGreaterThanOrEqual(400)

        const ctx = framed.getContext('2d') as any
        expect(ctx.drawImage).toHaveBeenCalled()
        expect(ctx.fillText).toHaveBeenCalled()
      })
    }

    it('allows clearing the frame label by providing empty string', () => {
      const sourceCanvas = document.createElement('canvas')
      sourceCanvas.width = 400
      sourceCanvas.height = 400

      const framed = applyFrame(sourceCanvas, {
        type: 'dark-green',
        label: '',
      })
      expect(framed).toBeDefined()
    })
  })

  describe('QrEngine', () => {
    it('initializes with default options and allows updates', () => {
      const engine = new QrEngine()
      expect(engine.getData()).toBe('https://example.com')
      expect(engine.getOptions().errorCorrectionLevel).toBe('Q')
      expect(engine.getOptions().dotsOptions.type).toBe('square')

      engine.update({ errorCorrectionLevel: 'H' }, 'https://custom.com')
      expect(engine.getData()).toBe('https://custom.com')
      expect(engine.getOptions().errorCorrectionLevel).toBe('H')
    })

    it('maps eye shapes to corner square and dot options including aliases', () => {
      const square = mapEyeShapeToCornerOptions('square', '#000', '#111')
      expect(square.cornersSquareOptions.type).toBe('square')
      expect(square.cornersDotOptions.type).toBe('square')

      const circle = mapEyeShapeToCornerOptions('circle', '#222', '#333')
      expect(circle.cornersSquareOptions.type).toBe('dot')
      expect(circle.cornersDotOptions.type).toBe('dot')

      const rounded = mapEyeShapeToCornerOptions('rounded', '#444', '#555')
      expect(rounded.cornersSquareOptions.type).toBe('extra-rounded')

      const leaf = mapEyeShapeToCornerOptions('leaf', '#666', '#777')
      expect(leaf.cornersSquareOptions.type).toBe('extra-rounded')
      expect(leaf.cornersDotOptions.type).toBe('dot')

      const leafDiag = mapEyeShapeToCornerOptions('leaf-diagonal')
      expect(leafDiag.cornersSquareOptions.type).toBe('extra-rounded')
      expect(leafDiag.cornersDotOptions.type).toBe('dot')

      const leafPointed = mapEyeShapeToCornerOptions('leaf-pointed')
      expect(leafPointed.cornersSquareOptions.type).toBe('extra-rounded')
      expect(leafPointed.cornersDotOptions.type).toBe('dot')
    })

    it('automatically applies eyeShape to cornersSquareOptions and cornersDotOptions', () => {
      const engine = new QrEngine({ eyeShape: 'circle' })
      expect(engine.getOptions().cornersSquareOptions.type).toBe('dot')
      expect(engine.getOptions().cornersDotOptions.type).toBe('dot')

      engine.setOptions({ eyeShape: 'rounded' })
      expect(engine.getOptions().cornersSquareOptions.type).toBe('extra-rounded')
    })

    it('builds qr-code-styling native configuration with rotation degrees to radians', () => {
      const nativeOpts = buildQrCodeStylingOptions(
        {
          errorCorrectionLevel: 'M',
          dotsOptions: {
            type: 'rounded',
            gradient: {
              type: 'linear',
              rotation: 90,
              colorStops: [{ offset: 0, color: '#f00' }, { offset: 1, color: '#00f' }],
            },
          },
          cornersSquareOptions: {
            type: 'extra-rounded',
            color: '#123',
          },
          cornersDotOptions: {
            type: 'dot',
            color: '#456',
          },
          backgroundOptions: {
            color: '#fff',
          },
          logoOptions: {
            logoId: 'wechat',
            size: 0.25,
            margin: 8,
          },
        },
        'https://test.org',
        800,
        800,
        'canvas'
      )

      expect(nativeOpts.width).toBe(800)
      expect(nativeOpts.height).toBe(800)
      expect(nativeOpts.qrOptions.errorCorrectionLevel).toBe('M')
      expect(nativeOpts.dotsOptions.type).toBe('rounded')
      expect(nativeOpts.dotsOptions.gradient.rotation).toBeCloseTo(Math.PI / 2)
      expect(nativeOpts.image).toContain('data:image/svg+xml')
      expect(nativeOpts.imageOptions.imageSize).toBe(0.25)
      expect(nativeOpts.imageOptions.margin).toBe(8)
    })

    it('prepares styled logo with circle, rounded mask and shadow', async () => {
      const src = getOnlineLogoDataUrl('qq')
      const originalLogo = await prepareStyledLogo(src, { shape: 'original', shadow: false })
      expect(originalLogo).toBe(src)

      const circleLogo = await prepareStyledLogo(src, { shape: 'circle', shadow: true })
      expect(circleLogo).toBeTruthy()

      const roundedLogo = await prepareStyledLogo(src, { shape: 'rounded', hasShadow: true })
      expect(roundedLogo).toBeTruthy()
    })

    it('handles broken or error image URLs cleanly without throwing', async () => {
      const fallback = await prepareStyledLogo('https://error-image.png', { shape: 'circle' })
      expect(fallback).toBe('https://error-image.png')
    })

    it('renders composite canvas and SVG with decorators', async () => {
      const engine = new QrEngine({
        dotsOptions: { type: 'rounded', color: '#1877f2' },
        frameOptions: { type: 'dark-green', label: '扫一扫 了解详情' },
        textOptions: {
          enabled: true,
          content: '官方推荐公众号',
          fontSize: 30,
          fontFamily: 'sans-serif',
          color: '#000',
          position: 'bottom',
        },
      })

      const canvas = await engine.renderCanvas(500, 500)
      expect(canvas).toBeInstanceOf(HTMLCanvasElement)
      expect(canvas.width).toBeGreaterThanOrEqual(500)
      expect(canvas.height).toBeGreaterThanOrEqual(500)

      const svg = await engine.renderSvg(500, 500)
      expect(typeof svg).toBe('string')
      expect(svg).toContain('<svg')
      expect(svg).toContain('</svg>')
    })

    it('appends preview canvas into DOM container', async () => {
      const engine = new QrEngine()
      const container = document.createElement('div')
      await engine.append(container, 300, 300)

      expect(container.children.length).toBe(1)
      expect(container.firstChild).toBeInstanceOf(HTMLCanvasElement)
    })
  })

  describe('Export Pipeline', () => {
    it('converts data URLs to Blobs correctly without truncating commas in SVG', () => {
      const pngDataUrl =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      const blob = dataUrlToBlob(pngDataUrl)
      expect(blob).toBeInstanceOf(Blob)
      expect(blob.type).toBe('image/png')
      expect(blob.size).toBeGreaterThan(0)

      const svgWithCommas = '<svg><polygon points="0,0 10,10 20,20"/><path d="M 0,0 L 5,5"/></svg>'
      const svgDataUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(svgWithCommas)
      const svgBlob = dataUrlToBlob(svgDataUrl)
      expect(svgBlob.type).toBe('image/svg+xml')
    })

    it('ensures solid background for JPEG export falling back to white on transparent', () => {
      const source = document.createElement('canvas')
      source.width = 200
      source.height = 200

      const solid = ensureSolidBackground(source, '#ffffff')
      expect(solid.width).toBe(200)
      expect(solid.height).toBe(200)
      const ctx = solid.getContext('2d') as any
      expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 200, 200)

      const transparentFallback = ensureSolidBackground(source, 'transparent')
      const ctx2 = transparentFallback.getContext('2d') as any
      expect(ctx2.fillStyle).toBe('#ffffff')
    })

    it('exports QR code as Blob across all formats including jpg alias', async () => {
      const engine = new QrEngine()

      const pngBlob = await exportQrToBlob(engine, { width: 500, format: 'png' })
      expect(pngBlob).toBeInstanceOf(Blob)
      expect(pngBlob.type).toBe('image/png')

      const jpegBlob = await exportQrToBlob(engine, { width: 1000, format: 'jpeg', quality: 0.85 })
      expect(jpegBlob).toBeInstanceOf(Blob)
      expect(jpegBlob.type).toBe('image/jpeg')

      const jpgBlob = await exportQrToBlob(engine, { width: 1000, format: 'jpg' })
      expect(jpgBlob).toBeInstanceOf(Blob)
      expect(jpgBlob.type).toBe('image/jpeg')

      const svgBlob = await exportQrToBlob(engine, { width: 1500, format: 'svg' })
      expect(svgBlob).toBeInstanceOf(Blob)
      expect(svgBlob.type).toBe('image/svg+xml;charset=utf-8')

      const webpBlob = await exportQrToBlob(engine, { width: 500, format: 'webp' })
      expect(webpBlob).toBeInstanceOf(Blob)
      expect(webpBlob.type).toBe('image/webp')
    })

    it('exports QR code as Data URL across all formats including jpg', async () => {
      const engine = new QrEngine()

      const pngUrl = await exportQrToDataUrl(engine, { width: 500, format: 'png' })
      expect(pngUrl).toMatch(/^data:image\/png/)

      const jpegUrl = await exportQrToDataUrl(engine, { width: 500, format: 'jpeg' })
      expect(jpegUrl).toMatch(/^data:image\/jpeg/)

      const jpgUrl = await exportQrToDataUrl(engine, { width: 500, format: 'jpg' })
      expect(jpgUrl).toMatch(/^data:image\/jpeg/)

      const svgUrl = await exportQrToDataUrl(engine, { width: 500, format: 'svg' })
      expect(svgUrl).toMatch(/^data:image\/svg\+xml/)

      const webpUrl = await exportQrToDataUrl(engine, { width: 500, format: 'webp' })
      expect(webpUrl).toMatch(/^data:image\/webp/)
    })

    it('triggers file download correctly with jpg extension handling', async () => {
      const engine = new QrEngine()
      const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-url')
      const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
      const appendSpy = vi.spyOn(document.body, 'appendChild')
      const removeSpy = vi.spyOn(document.body, 'removeChild')

      await downloadQrCode(engine, {
        format: 'jpg',
      })

      expect(createObjectURLSpy).toHaveBeenCalled()
      expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:test-url')
      expect(clickSpy).toHaveBeenCalled()
      expect(appendSpy).toHaveBeenCalled()
      expect(removeSpy).toHaveBeenCalled()

      clickSpy.mockRestore()
      createObjectURLSpy.mockRestore()
      revokeObjectURLSpy.mockRestore()
    })

    it('copies QR image to clipboard via Clipboard API', async () => {
      const engine = new QrEngine()
      const writeMock = vi.fn().mockResolvedValue(undefined)
      const writeTextMock = vi.fn().mockResolvedValue(undefined)

      ;(globalThis as any).ClipboardItem = class ClipboardItemStub {
        constructor(public items: any) {}
      }

      Object.defineProperty(navigator, 'clipboard', {
        value: {
          write: writeMock,
          writeText: writeTextMock,
        },
        configurable: true,
      })

      const success = await copyQrCodeToClipboard(engine)
      expect(success).toBe(true)
      expect(writeMock).toHaveBeenCalled()
    })
  })
})
