// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { encodePngRgba } from '../src/worker/development/icons/png'
import { encodeIco, icoSizesToken, inspectIco } from '../src/worker/development/icons/ico'
import { buildSvgSymbolSprite, iconSlug, svgInner, svgViewBox, uniqueSlugs } from '../src/worker/development/icons/sprite'
import { sanitizeSvgText } from '../src/worker/development/icons/svg-sanitize'
import { readImageSize } from '../src/worker/lib/image'

describe('icon PNG encoder', () => {
  it('writes a readable IHDR with the requested dimensions', () => {
    const png = encodePngRgba(4, 3, new Uint8Array(4 * 3 * 4).fill(128))
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(readImageSize(png, 'image/png')).toEqual({ width: 4, height: 3 })
  })

  it('refuses mismatched buffers and empty dimensions', () => {
    expect(() => encodePngRgba(0, 2, new Uint8Array(0))).toThrow()
    expect(() => encodePngRgba(2, 2, new Uint8Array(8))).toThrow()
  })
})

describe('icon ICO container', () => {
  const payload = (size: number): Uint8Array => {
    const bytes = new Uint8Array(size)
    bytes.set([0x89, 0x50, 0x4e, 0x47])
    return bytes
  }

  it('packs selected sizes and round-trips the directory', () => {
    const ico = encodeIco([
      { size: 16, png: payload(32) },
      { size: 48, png: payload(64) },
      { size: 256, png: payload(96) },
    ])
    expect(inspectIco(ico)).toEqual({ count: 3, sizes: [16, 48, 256] })
    expect(icoSizesToken([256, 16, 48])).toBe('16-48-256')
  })

  it('rejects duplicate, unsupported and oversized entry sets', () => {
    expect(() => encodeIco([{ size: 16, png: payload(8) }, { size: 16, png: payload(8) }])).toThrow()
    expect(() => encodeIco([{ size: 24, png: payload(8) }])).toThrow()
    expect(() => encodeIco([])).toThrow()
  })

  it('rejects an ICO whose directory points outside the file', () => {
    const ico = encodeIco([{ size: 16, png: payload(32) }])
    const broken = new Uint8Array(ico)
    new DataView(broken.buffer).setUint32(6 + 12, 4096, true)
    expect(() => inspectIco(broken)).toThrow()
  })
})

describe('sprite helpers', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'

  it('slugifies names and keeps duplicates unique', () => {
    expect(iconSlug('Arrow Right!')).toBe('arrow-right')
    expect(uniqueSlugs(['Arrow', 'arrow', 'Arrow'])).toEqual(['arrow', 'arrow-2', 'arrow-3'])
  })

  it('extracts the viewBox and the inner markup', () => {
    expect(svgViewBox(svg)).toBe('0 0 24 24')
    expect(svgInner(svg)).toContain('<path d="M0 0h24v24H0z"/>')
  })

  it('builds symbol ids from slugs and keeps the JSON index', () => {
    const sprite = buildSvgSymbolSprite([
      { name: 'Arrow', svg },
      { name: 'Arrow', svg },
    ], 'sprite-1')
    expect(sprite.svg).toContain('<symbol id="arrow" viewBox="0 0 24 24">')
    expect(sprite.svg).toContain('<symbol id="arrow-2"')
    expect(sprite.json.icons.map((icon) => icon.id)).toEqual(['arrow', 'arrow-2'])
  })
})

describe('SVG attack vectors', () => {
  it('accepts a normal icon', () => {
    expect(sanitizeSvgText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>', 1024)).toContain('<path')
  })

  const attacks: [string, string][] = [
    ['script', '<svg><script>alert(1)</script></svg>'],
    ['foreignObject', '<svg><foreignObject><div/></foreignObject></svg>'],
    ['event handler', '<svg onload="alert(1)"><path d="M0 0"/></svg>'],
    ['external href', '<svg><use href="https://evil.example/x.svg#a"/></svg>'],
    ['javascript url', '<svg><path fill="javascript:alert(1)"/></svg>'],
    ['data url', '<svg><path fill="data:image/svg+xml;base64,PHN2Zz4="/></svg>'],
    ['external use', '<svg><use fill="url(https://evil.example/x.svg#a)"/></svg>'],
    ['entity', '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg/>'],
    ['unbalanced', '<svg><g></svg>'],
  ]

  for (const [name, payload] of attacks) {
    it(`rejects ${name}`, () => {
      expect(() => sanitizeSvgText(payload, 4096)).toThrow()
    })
  }

  it('rejects an oversized SVG before parsing', () => {
    expect(() => sanitizeSvgText(`<svg>${'x'.repeat(2048)}</svg>`, 128)).toThrow()
  })
})
