import { describe, expect, it } from 'vitest'
import {
  parseQrStylingOptions,
} from '../src/shared/tools/qrcode/schemas'
import { QR_PRESETS } from '../src/shared/tools/qrcode/presets'
import { DEFAULT_QR_OPTIONS } from '../src/client/features/tools/qrcode/engine/qr-engine'
import { applyTextCaptionToSvg } from '../src/client/features/tools/qrcode/engine/text-decorator'

const SVG_SAMPLE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="#ffffff"/></svg>'

describe('QR styling validation', () => {
  it('accepts every built-in preset and the workbench default', () => {
    for (const preset of QR_PRESETS) {
      expect(parseQrStylingOptions(preset.options), `preset ${preset.id}`).not.toBeNull()
    }
    expect(parseQrStylingOptions(DEFAULT_QR_OPTIONS)).not.toBeNull()
  })

  it('accepts the partial styling an import or a saved template carries', () => {
    expect(parseQrStylingOptions({ dotsOptions: { color: '#123456' } })).toEqual({
      dotsOptions: { color: '#123456' },
    })
    expect(parseQrStylingOptions({ toolkitOptions: { pixelStyle: 'row', seed: 7 } })).not.toBeNull()
  })

  it('refuses a colour or font that could close an attribute', () => {
    expect(
      parseQrStylingOptions({ textOptions: { fontFamily: 'x" onload="alert(1)' } })
    ).toBeNull()
    expect(parseQrStylingOptions({ dotsOptions: { color: '#fff" onmouseover=x' } })).toBeNull()
    expect(parseQrStylingOptions({ backgroundOptions: { color: 'red;drop' } })).toBeNull()
  })

  it('refuses a logo that would make the reader fetch somewhere else', () => {
    expect(parseQrStylingOptions({ logoOptions: { src: 'https://tracker.example/1x1.gif' } })).toBeNull()
    expect(parseQrStylingOptions({ logoOptions: { src: 'data:image/png;base64,AAAA' } })).not.toBeNull()
    expect(parseQrStylingOptions({ logoOptions: { src: '/api/tools/qrcode/logo/abc' } })).not.toBeNull()
  })

  it('refuses keys the renderer has no vocabulary for', () => {
    expect(parseQrStylingOptions({ dotsOptions: { type: 'banana' } })).toBeNull()
    expect(parseQrStylingOptions({ __proto__: { polluted: true }, sneaky: 1 })).toBeNull()
    expect(parseQrStylingOptions({ toolkitOptions: { transformScale: 99 } })).toBeNull()
  })

  it('escapes the attributes it writes into an exported SVG', () => {
    const svg = applyTextCaptionToSvg(SVG_SAMPLE, {
      enabled: true,
      content: 'scan me',
      fontFamily: 'x" onload="alert(1)',
      color: '#000" onerror="x',
    }, '#ffffff" onload="y')

    expect(svg).not.toMatch(/onload="alert/)
    expect(svg).not.toMatch(/onerror="x"/)
    expect(svg).toContain('&quot;')
  })
})
