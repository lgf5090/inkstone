import { describe, expect, it } from 'vitest'
import {
  MEDIA_BLOCK_DEFAULTS,
  clampRowHeight,
  clampWidth,
  formatMediaHeader,
  formatMediaOptions,
  formatMediaRowGroup,
  formatMediaRowLine,
  parseMediaOptions,
  parseMediaRow,
  readEmbedRow,
  rowWeights,
  stripMediaRowGroup,
} from './media-layout'

describe('media block header options', () => {
  it('starts every block at the reading defaults', () => {
    expect(parseMediaOptions('')).toEqual(MEDIA_BLOCK_DEFAULTS)
    expect(parseMediaOptions('media')).toEqual(MEDIA_BLOCK_DEFAULTS)
  })

  it('reads each spelling a toolbar writes back', () => {
    const options = parseMediaOptions('wrap=right width=45% gap=narrow align=left fit=cover ratio=16:9 radius=full border shadow no-caption caption-align=left numbered cols=3')
    expect(options).toEqual({
      wrap: 'right',
      width: 45,
      gap: 'narrow',
      align: 'left',
      fit: 'cover',
      ratio: '16:9',
      border: true,
      shadow: true,
      radius: 'full',
      caption: false,
      captionAlign: 'left',
      numbered: true,
      columns: 3,
    })
    expect(formatMediaOptions(options)).toBe('wrap=right width=45% cols=3 gap=narrow align=left fit=cover ratio=16:9 radius=full border shadow no-caption caption-align=left numbered')
  })

  it('reads the bare words an author would type', () => {
    expect(parseMediaOptions('left 60% 2')).toMatchObject({ wrap: 'left', width: 60, columns: 2 })
    expect(parseMediaOptions('center cover rounded')).toMatchObject({ align: 'center', fit: 'cover', radius: 'lg' })
    expect(parseMediaOptions('wide')).toMatchObject({ gap: 'wide' })
  })

  it('keeps a typo from costing the reader their pictures', () => {
    const options = parseMediaOptions('wrap=left nonsense=3 width=999')
    expect(options.wrap).toBe('left')
    expect(options.width).toBeNull()
  })

  it('leaves a default out of the line it writes', () => {
    expect(formatMediaHeader(MEDIA_BLOCK_DEFAULTS, 3)).toBe('::: media')
    expect(formatMediaHeader({ ...MEDIA_BLOCK_DEFAULTS, wrap: 'left', width: 40 }, 4)).toBe(':::: media wrap=left width=40%')
  })

  it('clamps the numbers a drag can produce', () => {
    expect(clampWidth(4)).toBe(20)
    expect(clampWidth(240)).toBe(100)
    expect(clampRowHeight(10)).toBe(60)
    expect(clampRowHeight(99999)).toBe(1200)
  })
})

describe('media row lines', () => {
  it('counts the embeds on a line, in the order they were written', () => {
    expect(readEmbedRow('![[a.png]] ![设计草图](attachments/sketch.png)')).toHaveLength(2)
    expect(readEmbedRow('text ![[a.png]]')).toBeNull()
    expect(readEmbedRow('![[a.png]] trailing words')).toBeNull()
    expect(readEmbedRow('plain paragraph')).toBeNull()
  })

  it('accepts the destination spellings a vault produces', () => {
    // A space would end a bare destination for Markdown itself, so the layout reads no more than the
    // link rule does; a name with balanced parentheses in it is the case that needs the extra grammar.
    expect(readEmbedRow('![alt](image(1).png)')).toHaveLength(1)
    expect(readEmbedRow('![alt](image (1).png)')).toBeNull()
    expect(readEmbedRow('![alt](<image.png>)')).toHaveLength(1)
    expect(readEmbedRow('![a](https://x.test/i.png) ![b](/notes/i2.png)')).toHaveLength(2)
  })

  it('reads the row group beside the pictures', () => {
    const row = parseMediaRow('![[a.png]] ![[b.png]] {w=1:2.5 h=300 align=left}')
    expect(row?.cells.map((cell) => cell.raw)).toEqual(['![[a.png]]', '![[b.png]]'])
    expect(row?.options).toEqual({ weights: [1, 2.5], height: 300, align: 'left' })
  })

  it('tells a picture’s own name from the row’s settings', () => {
    const row = parseMediaRow('![[a.png]]{#fig:beach} ![[b.png]] {h=200}')
    expect(row?.cells[0]?.figId).toBe('beach')
    expect(row?.cells[1]?.figId).toBeNull()
    expect(row?.options.height).toBe(200)
    // The name is taken off the embed text the page renders, or the marker shows as literal text.
    expect(row?.cells[0]?.raw).toBe('![[a.png]]')
  })

  it('takes a caption from the title, and from an alias that is not a size', () => {
    const titled = parseMediaRow('![alt](a.png "The beach at dusk")')
    expect(titled?.cells[0]?.caption).toBe('The beach at dusk')
    expect(titled?.cells[0]?.nativeCaption).toBe(true)
    expect(titled?.cells[0]?.target).toBe('a.png')
    const aliased = parseMediaRow('![[a.png|The beach at dusk]]')
    expect(aliased?.cells[0]?.caption).toBe('The beach at dusk')
    expect(aliased?.cells[0]?.nativeCaption).toBe(false)
    expect(parseMediaRow('![[a.png|600x400]]')?.cells[0]?.caption).toBeNull()
  })

  it('names what a picture is, so a video is not stretched like a still', () => {
    expect(parseMediaRow('![[clip.mp4]]')?.cells[0]?.kind).toBe('video')
    expect(parseMediaRow('![[note.md]]')?.cells[0]?.kind).toBe('other')
    expect(parseMediaRow('![a](x.webp)')?.cells[0]?.kind).toBe('image')
  })

  it('holds a row of twelve pictures and refuses a thirteenth', () => {
    const twelve = Array.from({ length: 12 }, (_unused, index) => `![[p${index}.png]]`).join(' ')
    expect(parseMediaRow(twelve)?.cells).toHaveLength(12)
    expect(parseMediaRow(`${twelve} ![[last.png]]`)).toBeNull()
  })

  it('carries a weight for every picture in a long row', () => {
    const twelve = Array.from({ length: 12 }, (_unused, index) => `![[p${index}.png]]`).join(' ')
    const weights = Array.from({ length: 12 }, (_unused, index) => index + 1).join(':')
    expect(parseMediaRow(`${twelve} {w=${weights}}`)?.options.weights).toHaveLength(12)
    expect(parseMediaRow('![[a]] ![[b]] {w=1:1:1:1:1:1:1:1:1:1:1:1:1}')?.options.weights).toEqual([])
  })

  it('writes a row line without disturbing the embeds', () => {
    const line = '![[beach.png|600]] ![设计草图](attachments/sketch.png "v2") {w=1:2}'
    const next = formatMediaRowLine(line, { weights: [3, 1], height: 240, align: null })
    expect(next).toBe('![[beach.png|600]] ![设计草图](attachments/sketch.png "v2") {w=3:1 h=240}')
  })

  it('gives a row its first width list when a drag creates one', () => {
    // The row had no group at all: a gap drag is the common way a share is ever written, and dropping it
    // would leave the reader watching a picture resize and then snap back on the next render.
    expect(formatMediaRowLine('![[a.png]] ![[b.png]]', { weights: [1, 1.9], height: null, align: null }))
      .toBe('![[a.png]] ![[b.png]] {w=1:1.9}')
  })

  it('does not let one picture claim a share of a row it is alone on', () => {
    expect(formatMediaRowLine('![[a.png]]', { weights: [2, 1], height: null, align: null })).toBe('![[a.png]]')
    expect(formatMediaRowLine('![[a.png]] {h=200}', { weights: [], height: 200, align: null })).toBe('![[a.png]] {h=200}')
  })

  it('leaves a line it cannot read untouched', () => {
    expect(formatMediaRowLine('just a paragraph', { weights: [], height: 200, align: null })).toBe('just a paragraph')
    expect(stripMediaRowGroup('just a paragraph')).toBe('just a paragraph')
  })

  it('strips the row settings and keeps the pictures', () => {
    expect(stripMediaRowGroup('![[a.png]] ![[b.png]] {w=1:2 h=240}')).toBe('![[a.png]] ![[b.png]]')
  })

  it('pads and trims a weight list to the pictures that are really there', () => {
    expect(rowWeights([2], 3)).toEqual([2, 1, 1])
    expect(rowWeights([2, 3, 4, 5, 6], 2)).toEqual([2, 3])
    expect(rowWeights([0, -1, Number.NaN], 2)).toEqual([1, 1])
  })

  it('writes a group only for what differs from the row’s defaults', () => {
    expect(formatMediaRowGroup({ weights: [1], height: null, align: null })).toBe('')
    expect(formatMediaRowGroup({ weights: [1, 2], height: null, align: null })).toBe('{w=1:2}')
    expect(formatMediaRowGroup({ weights: [], height: 300, align: 'right' })).toBe('{h=300 align=right}')
  })
})
