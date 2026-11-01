/**
 * What the traditional-colour page says, and what it actually paints.
 *
 * A Chromium sweep over every view found three things the unit suite could not see: a 10px solar-term chip
 * whose 10% veil left it at 3.86:1 on mid-tone colours, an interpolation badge that took the accent as its
 * ink while sitting on a permanently black pill (1.9:1 with a picked olive), and a subtitle that claimed
 * 384 and 250 colours while the tabs next to it printed 82 and 47.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { recommendedTextColor } from '@shared/tools/color/a11y'
import { TRADITIONAL_CHINESE_COLORS } from '@shared/tools/color/presets/traditional-chinese'
import { TRADITIONAL_NIPPON_COLORS } from '@shared/tools/color/presets/traditional-nippon'
import { solarTermPlate } from '../src/client/features/tools/color/components/TraditionalColorCard'
import { contrastRatio, over, parseColor } from '../scripts/lib/contrast.mjs'

const AA_SMALL = 4.5
const plate = (css: string) => {
  const p = parseColor(css)
  if (!p) throw new Error(`${css} is not a colour this gate can read`)
  return p
}

/** The worst substrate a chip can land on: pure white or pure black, whichever hurts the pair more. */
function worstPair(ink: string, plateCss: string): number {
  const p = plate(plateCss)
  const inkRgb = plate(ink).rgb
  return Math.min(
    ...[255, 0].map((substrate) => contrastRatio(inkRgb, over({ rgb: p.rgb, alpha: p.alpha }, [substrate, substrate, substrate]))),
  )
}

describe('the solar-term chip', () => {
  const items = [...TRADITIONAL_CHINESE_COLORS, ...TRADITIONAL_NIPPON_COLORS].filter((c) => c.solarTerm)

  it('has chips to judge at all', () => {
    // An empty list would make the two tests below vacuously green.
    expect(items.length).toBeGreaterThan(50)
  })

  it('carries its label at AA over any swatch it is dropped on', () => {
    for (const item of items) {
      const ink = recommendedTextColor(item.hex)
      const worst = worstPair(ink, solarTermPlate(ink))
      expect(worst, `${item.name} ${item.hex} ${item.solarTerm} paints its chip at ${worst.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_SMALL)
    }
  })

  it('does not go back to a translucent veil over the swatch', () => {
    // The old markup was `bg-black/10`, which measured 3.86:1 for the sage-green card's chip in Chromium.
    const source = readFileSync('src/client/features/tools/color/components/TraditionalColorCard.tsx', 'utf8')
    const chip = /solarTerm && \(([\s\S]{0,700}?)<\/span>/.exec(source)
    expect(chip, 'the chip markup moved').toBeTruthy()
    expect(chip![0], 'a 10% veil is what failed AA').not.toContain('bg-black/10')
    expect(chip![0]).toContain('solarTermPlate')
  })
})

describe('the gradient stage badge', () => {
  it('keeps a fixed ink because its pill is always dark', () => {
    const source = readFileSync('src/client/features/tools/color/views/GradientStudioView.tsx', 'utf8')
    const badge = /useOklabInterpolation && \(([\s\S]{0,400}?)\)\}/.exec(source)
    expect(badge, 'the OKLab badge moved').toBeTruthy()
    expect(badge![1], 'the accent is not readable on a black pill').not.toContain('var(--accent)')
    expect(badge![1]).toContain('text-white')
  })
})

describe('the collection subtitle', () => {
  it('counts what the datasets actually hold', () => {
    const zh = readFileSync('src/shared/locales/zh-CN-tools.ts', 'utf8')
    const en = readFileSync('src/shared/locales/en-US-tools.ts', 'utf8')
    const line = (src: string) => /'tools\.color\.traditional\.subtitle': '([^']+)'/.exec(src)?.[1] ?? ''
    expect(line(zh), 'the Chinese line still states a number the page cannot show').not.toMatch(/\d{3}/)
    expect(line(en), 'the English line still states a number the page cannot show').not.toMatch(/\d{3}/)
    expect(line(zh)).toContain('{chinese}')
    expect(line(en)).toContain('{nippon}')
    // And the call site must feed it, or the braces would print literally.
    const view = readFileSync('src/client/features/tools/color/views/TraditionalColorView.tsx', 'utf8')
    expect(view).toContain('chinese: TRADITIONAL_CHINESE_COLORS.length')
    expect(view).toContain('nippon: TRADITIONAL_NIPPON_COLORS.length')
  })
})
