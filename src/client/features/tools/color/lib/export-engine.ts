/**
 * Universal Palette Exporter Engine (ASE, CSS, SCSS, Tailwind, JSON)
 */

import { hexToRgb, rgbToOklchString } from '@shared/tools/color/spaces'
import type { MessageKey } from '@shared/locales/en-US'

export interface PaletteExportData {
  title: string
  colors: string[] // hex values
}

/**
 * A palette title turned into something that may stand inside an identifier, a variable name or a file name.
 *
 * Titles here are what the reader typed, and a third of them are written in characters this filter cannot
 * keep: such a title used to survive as a run of hyphens, exporting `--color-----1` and a Tailwind key of
 * `'-----'`. Whatever has no Latin letter or digit in it is named after the collection instead, after the
 * separators are folded — which also stops two words from becoming `my--palette`.
 */
export function slugFromTitle(title: string): string {
  const folded = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return folded || 'palette'
}

/**
 * Builds binary Adobe Swatch Exchange (.ase) file
 */
export function exportToAseBlob(palette: PaletteExportData): Blob {
  const { title, colors } = palette

  // Calculate buffer size needed
  // Header: 4 (magic) + 2 (ver major) + 2 (ver minor) + 4 (block count) = 12 bytes
  // Each color block:
  // - 2 bytes type (0x0001)
  // - 4 bytes block length
  // - 2 bytes name length (in UTF-16 characters including 0x0000)
  // - name.length * 2 + 2 bytes
  // - 4 bytes color model ('RGB ')
  // - 12 bytes (3 x float32: R, G, B in 0..1)
  // - 2 bytes color type (0x0002 for normal)
  // Total per block: 2 + 4 + 2 + (name.length + 1) * 2 + 4 + 12 + 2 = 26 + (name.length + 1) * 2 bytes

  let totalBytes = 12
  const colorBlocksMeta: Array<{
    name: string
    nameLengthUtf16: number
    blockLength: number
    r: number
    g: number
    b: number
  }> = []

  colors.forEach((hex, index) => {
    const name = `${title} ${index + 1} (${hex.toUpperCase()})`
    const nameLengthUtf16 = name.length + 1
    // Block length is size of data after the 4-byte length field:
    // 2 (nameLength) + nameLengthUtf16 * 2 + 4 (model) + 12 (floats) + 2 (colorType)
    const blockLength = 2 + nameLengthUtf16 * 2 + 4 + 12 + 2
    totalBytes += 2 + 4 + blockLength

    const rgb = hexToRgb(hex)
    colorBlocksMeta.push({
      name,
      nameLengthUtf16,
      blockLength,
      r: rgb.r / 255,
      g: rgb.g / 255,
      b: rgb.b / 255,
    })
  })

  const buffer = new ArrayBuffer(totalBytes)
  const view = new DataView(buffer)
  let offset = 0

  // Header
  // Magic 'ASEF'
  view.setUint8(offset++, 0x41)
  view.setUint8(offset++, 0x53)
  view.setUint8(offset++, 0x45)
  view.setUint8(offset++, 0x46)
  // Version 1.0
  view.setUint16(offset, 1, false)
  offset += 2
  view.setUint16(offset, 0, false)
  offset += 2
  // Total blocks
  view.setUint32(offset, colors.length, false)
  offset += 4

  // Color Blocks
  for (const block of colorBlocksMeta) {
    // Block Type: 0x0001 (Color entry)
    view.setUint16(offset, 0x0001, false)
    offset += 2
    // Block Length
    view.setUint32(offset, block.blockLength, false)
    offset += 4
    // Name Length in characters (including null)
    view.setUint16(offset, block.nameLengthUtf16, false)
    offset += 2
    // UTF-16BE characters
    for (let c = 0; c < block.name.length; c++) {
      view.setUint16(offset, block.name.charCodeAt(c), false)
      offset += 2
    }
    // Trailing null char
    view.setUint16(offset, 0x0000, false)
    offset += 2

    // Color Model: 'RGB '
    view.setUint8(offset++, 0x52) // 'R'
    view.setUint8(offset++, 0x47) // 'G'
    view.setUint8(offset++, 0x42) // 'B'
    view.setUint8(offset++, 0x20) // ' '

    // 3 x Float32
    view.setFloat32(offset, block.r, false)
    offset += 4
    view.setFloat32(offset, block.g, false)
    offset += 4
    view.setFloat32(offset, block.b, false)
    offset += 4

    // Color Type: 2 (Normal)
    view.setUint16(offset, 0x0002, false)
    offset += 2
  }

  return new Blob([buffer], { type: 'application/octet-stream' })
}

/**
 * Builds CSS Variables format
 */
export function exportToCssVariables(palette: PaletteExportData): string {
  const prefix = slugFromTitle(palette.title)
  const vars = palette.colors
    .map((hex, i) => `  --color-${prefix}-${i + 1}: ${hex.toLowerCase()};`)
    .join('\n')
  return `/* ${palette.title} CSS Variables */\n:root {\n${vars}\n}`
}

/**
 * Builds SCSS Variables format
 */
export function exportToScssVariables(palette: PaletteExportData): string {
  const prefix = slugFromTitle(palette.title)
  const vars = palette.colors
    .map((hex, i) => `$color-${prefix}-${i + 1}: ${hex.toLowerCase()};`)
    .join('\n')
  return `// ${palette.title} SCSS Variables\n${vars}\n`
}

/**
 * Builds Tailwind CSS config format
 */
export function exportToTailwindConfig(palette: PaletteExportData): string {
  const name = slugFromTitle(palette.title)
  const entries = palette.colors
    .map((hex, i) => `        '${(i + 1) * 100}': '${hex.toLowerCase()}',`)
    .join('\n')
  return `// Tailwind CSS Colors Extension\nmodule.exports = {\n  theme: {\n    extend: {\n      colors: {\n        '${name}': {\n${entries}\n        },\n      },\n    },\n  },\n}`
}

/**
 * Builds JSON format
 */
export function exportToJson(palette: PaletteExportData): string {
  return JSON.stringify(
    {
      title: palette.title,
      exportedAt: new Date().toISOString(),
      colors: palette.colors.map((hex, index) => ({
        index: index + 1,
        hex: hex.toLowerCase(),
      })),
    },
    null,
    2,
  )
}

/**
 * Builds a Tailwind v4 `@theme` block.
 *
 * The v3 shape above exports a `module.exports` object, which a v4 stylesheet ignores: v4 takes its
 * palette from CSS custom properties declared inside `@theme`.
 */
export function exportToTailwindV4Theme(palette: PaletteExportData): string {
  const prefix = slugFromTitle(palette.title)
  const entries = palette.colors
    .map((hex, i) => `  --color-${prefix}-${i + 1}: ${hex.toLowerCase()};`)
    .join('\n')
  return `/* ${palette.title} — Tailwind v4 theme */\n@theme {\n${entries}\n}`
}

/**
 * Builds CSS custom properties written in `oklch()` — the notation this app's own accent scale uses.
 */
export function exportToOklchCssVariables(palette: PaletteExportData): string {
  const prefix = slugFromTitle(palette.title)
  const vars = palette.colors
    .map((hex, i) => `  --color-${prefix}-${i + 1}: ${rgbToOklchString(hexToRgb(hex))};`)
    .join('\n')
  return `/* ${palette.title} CSS Variables (OKLCH) */\n:root {\n${vars}\n}`
}

/**
 * Builds a Design Tokens (DTCG) document, which is what Figma's token importer reads.
 *
 * The leaves are named by their place in the palette: renaming tokens is design-tool work, and a made-up
 * English colour name would survive into the reader's file library.
 */
export function exportToFigmaTokens(palette: PaletteExportData): string {
  const group = slugFromTitle(palette.title)
  const leaves = palette.colors
    .map((hex, i) => `    "${i + 1}": {\n      "$value": "${hex.toLowerCase()}"\n    }`)
    .join(',\n')
  return `{\n  "$type": "color",\n  "${group}": {\n${leaves}\n  }\n}`
}

/**
 * Builds a GIMP palette (.gpl). GIMP stores channels as decimals, one colour per line.
 */
export function exportToGpl(palette: PaletteExportData): string {
  const rows = palette.colors
    .map((hex, i) => {
      const { r, g, b } = hexToRgb(hex)
      return `${String(r).padStart(3, ' ')} ${String(g).padStart(3, ' ')} ${String(b).padStart(3, ' ')}\t${i + 1}`
    })
    .join('\n')
  return `GIMP Palette\nName: ${palette.title}\nColumns: ${Math.min(palette.colors.length, 8)}\n#\n${rows}\n`
}

/**
 * Builds an Android `colors.xml`. Android writes the alpha channel first, and opaque is `FF`.
 */
export function exportToAndroidColors(palette: PaletteExportData): string {
  const prefix = slugFromTitle(palette.title)
  const items = palette.colors
    .map((hex, i) => `    <color name="${prefix}_${i + 1}">#FF${hex.replace('#', '').toLowerCase()}</color>`)
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${items}\n</resources>\n`
}

/**
 * Builds the colour list an Xcode asset catalogue is generated from.
 *
 * sRGB components stay in 0..1 because that is what the catalogue stores; a hex would be re-parsed twice.
 */
export function exportToIosColors(palette: PaletteExportData): string {
  return JSON.stringify(
    {
      colorSetName: slugFromTitle(palette.title),
      colors: palette.colors.map((hex, index) => {
        const { r, g, b } = hexToRgb(hex)
        return {
          idiom: 'universal',
          name: `${slugFromTitle(palette.title)}-${index + 1}`,
          hex: hex.toLowerCase(),
          components: { red: r / 255, green: g / 255, blue: b / 255, alpha: 1 },
        }
      }),
    },
    null,
    2,
  )
}

/**
 * What the export dialog offers.
 *
 * One table drives the picker, the preview, the file name and the download: the formats used to be listed
 * three times over, which is how a new one could be added to the chips and still download nothing.
 */
export type ExportFormatId =
  | 'css' | 'scss' | 'oklch' | 'tailwind' | 'tailwind_v4' | 'figma' | 'json' | 'gpl' | 'android' | 'ios' | 'ase'

export interface ExportFormatSpec {
  labelKey: MessageKey
  /** The file-name tail after the palette slug. */
  suffix: string
  mime: string
  /** A format whose bytes are not text: its preview is written by the dialog, not built here. */
  binary?: boolean
  build: (palette: PaletteExportData) => string
}

export const EXPORT_FORMATS: Record<ExportFormatId, ExportFormatSpec> = {
  css: { labelKey: 'tools.color.export.format_css', suffix: 'css', mime: 'text/css', build: exportToCssVariables },
  scss: { labelKey: 'tools.color.export.format_scss', suffix: 'scss', mime: 'text/x-scss', build: exportToScssVariables },
  oklch: { labelKey: 'tools.color.export.format_oklch', suffix: 'oklch.css', mime: 'text/css', build: exportToOklchCssVariables },
  tailwind: { labelKey: 'tools.color.export.format_tailwind', suffix: 'tailwind.js', mime: 'text/javascript', build: exportToTailwindConfig },
  tailwind_v4: { labelKey: 'tools.color.export.format_tailwind_v4', suffix: 'tailwind-v4.css', mime: 'text/css', build: exportToTailwindV4Theme },
  figma: { labelKey: 'tools.color.export.format_figma', suffix: 'tokens.json', mime: 'application/json', build: exportToFigmaTokens },
  json: { labelKey: 'tools.color.export.format_json', suffix: 'json', mime: 'application/json', build: exportToJson },
  gpl: { labelKey: 'tools.color.export.format_gpl', suffix: 'gpl', mime: 'text/plain', build: exportToGpl },
  android: { labelKey: 'tools.color.export.format_android', suffix: 'colors.xml', mime: 'text/xml', build: exportToAndroidColors },
  ios: { labelKey: 'tools.color.export.format_ios', suffix: 'ios-colors.json', mime: 'application/json', build: exportToIosColors },
  // Adobe's swatch file is bytes: nothing here builds its text, and the dialog says what the file is.
  ase: { labelKey: 'tools.color.export.format_ase', suffix: 'ase', mime: 'application/octet-stream', binary: true, build: () => '' },
}



/** Every format id, in the order the dialog lists them. */
export const EXPORT_FORMAT_IDS = Object.keys(EXPORT_FORMATS) as ExportFormatId[]

/** The name a format's file gets: the slug decides the stem, the suffix keeps two formats apart. */
export function exportFileName(format: ExportFormatId, palette: PaletteExportData): string {
  return `${slugFromTitle(palette.title)}.${EXPORT_FORMATS[format].suffix}`
}

/**
 * Triggers browser download for text or binary Blob
 */

export function triggerDownload(content: Blob | string, filename: string, mimeType = 'text/plain') {
  const blob = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
