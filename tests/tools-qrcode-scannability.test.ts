// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  MIN_CONTRAST_RATIO,
  RECOMMENDED_QUIET_CELLS,
  assessScannability,
  decodeRenderedCode,
} from '../src/client/features/tools/qrcode/engine/scannability'
import type { QrStylingOptions } from '../src/shared/tools/qrcode/types'

const BASE: QrStylingOptions = {
  errorCorrectionLevel: 'Q',
  margin: 4,
  dotsOptions: { type: 'square', color: '#000000' },
  cornersSquareOptions: { type: 'square', color: '#000000' },
  cornersDotOptions: { type: 'square', color: '#000000' },
  backgroundOptions: { color: '#ffffff' },
}

describe('QR scannability checks', () => {
  it('passes a plain black on white code and reports what it measured', () => {
    const report = assessScannability(BASE, 'a', 1000)
    expect(report.contrastRatio).toBeCloseTo(21, 0)
    expect(report.modules).toBe(21)
    expect(report.version).toBe(1)
    expect(report.quietCells).toBe(RECOMMENDED_QUIET_CELLS)
    expect(report.issues).toEqual([])
  })

  it('flags a foreground that matches the background', () => {
    const report = assessScannability(
      { ...BASE, dotsOptions: { type: 'square', color: '#777777' }, backgroundOptions: { color: '#777777' } },
      'a',
      1000
    )
    expect(report.contrastRatio).toBeLessThan(MIN_CONTRAST_RATIO)
    expect(report.issues).toContain('tools.qrcode.check.low_contrast')
  })

  it('takes the weakest stop of a gradient, not the first one', () => {
    const report = assessScannability(
      {
        ...BASE,
        dotsOptions: {
          type: 'square',
          gradient: {
            type: 'linear',
            colorStops: [
              { offset: 0, color: '#000000' },
              { offset: 1, color: '#cccccc' },
            ],
          },
        },
      },
      'a',
      1000
    )
    expect(report.issues).toContain('tools.qrcode.check.low_contrast')
  })

  it('reports a thin quiet zone only when it is below the recommended four', () => {
    expect(assessScannability({ ...BASE, margin: 1 }, 'a', 1000).issues).toContain(
      'tools.qrcode.check.small_quiet_zone'
    )
    expect(assessScannability({ ...BASE, margin: 4 }, 'a', 1000).issues).not.toContain(
      'tools.qrcode.check.small_quiet_zone'
    )
  })

  it('judges logo coverage against the error correction actually chosen', () => {
    const withLogo = (ecc: 'L' | 'H') =>
      assessScannability(
        {
          ...BASE,
          errorCorrectionLevel: ecc,
          logoOptions: { src: 'data:image/png;base64,AAAA', size: 0.35 },
        },
        'a',
        1000
      )
    expect(withLogo('L').issues).toContain('tools.qrcode.check.logo_too_large')
    expect(withLogo('H').issues).not.toContain('tools.qrcode.check.logo_too_large')
  })

  it('flags an export too small to print legibly', () => {
    expect(assessScannability(BASE, 'a', 100).issues).toContain('tools.qrcode.check.small_module')
    expect(assessScannability(BASE, 'a', 1000).issues).not.toContain('tools.qrcode.check.small_module')
  })

  it('treats an unmeasurable colour pair as unknown rather than as a pass', () => {
    const report = assessScannability(
      { ...BASE, dotsOptions: { type: 'square', color: 'currentColor' } },
      'a',
      1000
    )
    expect(report.contrastRatio).toBeNull()
    expect(report.issues).not.toContain('tools.qrcode.check.low_contrast')
  })

  it('says unknown when it cannot read the rendered pixels', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 10
    canvas.height = 10
    expect(decodeRenderedCode(canvas)).toBe('unknown')
  })
})
