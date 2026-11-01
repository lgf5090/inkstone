// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  calculatePrintLayout,
  fitPrintDpi,
} from '../src/client/features/tools/id-photo/engine/print-layout-engine'
import { attireRect, svgViewBoxAspect } from '../src/client/features/tools/id-photo/engine/id-photo-engine'
import { ATTIRE_PRESETS, PRINT_SHEET_PRESETS } from '../src/shared/tools/id-photo/presets'
import type { PrintSheetOptions } from '../src/shared/tools/id-photo/types'

const options = (over: Partial<PrintSheetOptions> = {}): PrintSheetOptions => ({
  paperSize: '6inch',
  orientation: 'portrait',
  gapMm: 2,
  marginMm: 4,
  showCropMarks: true,
  dpi: 300,
  ...over,
})

describe('Print sheet feasibility', () => {
  it('keeps the requested dpi while the sheet stays inside the canvas budget', () => {
    const a4 = PRINT_SHEET_PRESETS.find((preset) => preset.id === 'a4')!
    expect(fitPrintDpi(a4.widthMm, a4.heightMm, 300)).toBe(300)
    expect(calculatePrintLayout(25, 35, options({ paperSize: 'a4' })).dpi).toBe(300)
  })

  it('refuses to lay a photo that is larger than the paper', () => {
    const layout = calculatePrintLayout(100, 150, options({ paperSize: '5inch' }))
    expect(layout.fits).toBe(false)
    expect(layout.cols).toBe(0)
    expect(layout.rows).toBe(0)
    expect(layout.totalCount).toBe(0)
    expect(layout.startX).toBeGreaterThanOrEqual(0)
    expect(layout.startY).toBeGreaterThanOrEqual(0)
  })

  it('still fits a normal one-inch grid on 6-inch paper', () => {
    const layout = calculatePrintLayout(25, 35, options())
    expect(layout.fits).toBe(true)
    expect(layout.totalCount).toBe(9)
    expect(layout.startX).toBeGreaterThan(0)
  })

  it('caps an absurd dpi instead of asking for a 100 megapixel canvas', () => {
    const layout = calculatePrintLayout(25, 35, options({ paperSize: 'a4', dpi: 1200 }))
    expect(layout.dpi).toBeLessThan(1200)
    expect(layout.dpiReduced).toBe(true)
    expect(layout.paperWidthPx * layout.paperHeightPx).toBeLessThanOrEqual(20_000_000)
  })
})

describe('Attire overlay geometry', () => {
  it('draws every preset at the aspect ratio its own viewBox declares', () => {
    ATTIRE_PRESETS.forEach((preset) => {
      expect(svgViewBoxAspect(preset.previewSvg)).toBeCloseTo(4 / 3, 5)
    })
  })

  it('falls back when a viewBox is missing or malformed', () => {
    expect(svgViewBoxAspect('<svg></svg>')).toBeCloseTo(4 / 3, 5)
    expect(svgViewBoxAspect('<svg viewBox="0 0 400 200"></svg>')).toBeCloseTo(2, 5)
  })

  it('keeps the overlay proportional on a square spec instead of stretching it', () => {
    const portrait = attireRect(295, 413, 1, 0, 0, 4 / 3)
    expect(portrait.width / portrait.height).toBeCloseTo(4 / 3, 5)

    const square = attireRect(600, 600, 1, 0, 0, 4 / 3)
    expect(square.width / square.height).toBeCloseTo(4 / 3, 5)
    expect(square.height).toBeLessThan(600)
  })
})
