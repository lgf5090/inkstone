import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/client/styles/tokens.css', 'utf8')

function themeBlock(selector: string): string {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`selector not found: ${selector}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('\n}', open)
  return css.slice(open + 1, close)
}

function token(block: string, name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(block)
  if (!match) throw new Error(`${name} missing`)
  return match[1].trim()
}

function toRgb(value: string): [number, number, number] {
  if (value.startsWith('#')) {
    const hex = value.slice(1)
    return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number]
  }
  const match = /^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)%)?\)$/.exec(value)
  if (!match) throw new Error(`unsupported colour: ${value}`)
  const lightness = Number(match[1]) / 100
  const chroma = Number(match[2])
  const hue = (Number(match[3]) * Math.PI) / 180
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3
  const channels = [
    4.0767416621 * l - 3.2091720801 * m + 0.0707507020 * s,
    -1.2684380046 * l + 2.6097664011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map((linear) => {
    const gamma = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.max(linear, 0) ** (1 / 2.4) - 0.055
    return Math.min(255, Math.max(0, Math.round(gamma * 255)))
  })
  return channels as [number, number, number]
}

function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((channel) => {
    const scaled = channel / 255
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(foreground: string, background: string): number {
  const fg = toRgb(foreground)
  const alpha = /\/\s*([\d.]+)%/.exec(foreground)
  const bg = toRgb(background)
  const weight = alpha ? Number(alpha[1]) / 100 : 1
  const blended = fg.map((channel, index) => channel * weight + bg[index]! * (1 - weight)) as [number, number, number]
  const first = luminance(blended)
  const second = luminance(bg)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

const themes = [
  ['dark', ":root[data-theme='dark']"],
  ['light', ":root[data-theme='light']"],
] as const

describe('graph canvas tokens', () => {
  it('parses the control colours the way the probe expects', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrast('#7f7f7f', '#ffffff')).toBeCloseTo(4.0, 1)
  })

  for (const [name, selector] of themes) {
    it(`${name}: edges clear non-text contrast against every background`, () => {
      const block = themeBlock(selector)
      const backgrounds = [token(block, '--bg-base')]
      if (name === 'light') backgrounds.push('#ffffff')
      if (name === 'dark') backgrounds.push('#151617')
      const edge = token(block, '--graph-edge')
      const dim = token(block, '--graph-edge-dim')
      expect(edge).not.toMatch(/\/\s*\d+(\.\d+)?%/)
      for (const background of backgrounds) {
        expect(contrast(edge, background), `edge on ${background}`).toBeGreaterThanOrEqual(3)
        expect(contrast(dim, background), `dim edge on ${background}`).toBeGreaterThanOrEqual(3)
      }
    })

    it(`${name}: node labels clear body-text contrast`, () => {
      const block = themeBlock(selector)
      const label = token(block, '--graph-label')
      const backgrounds = [token(block, '--bg-base')]
      if (name === 'light') backgrounds.push('#ffffff')
      if (name === 'dark') backgrounds.push('#151617')
      expect(label).not.toMatch(/\/\s*\d+(\.\d+)?%/)
      for (const background of backgrounds) {
        expect(contrast(label, background), `label on ${background}`).toBeGreaterThanOrEqual(4.5)
      }
    })
  }
})
