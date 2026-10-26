/**
 * Universal Palette Exporter Engine (ASE, CSS, SCSS, Tailwind, JSON)
 */

import { hexToRgb } from '@shared/tools/color/spaces'

export interface PaletteExportData {
  title: string
  colors: string[] // hex values
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
  const prefix = palette.title.toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'palette'
  const vars = palette.colors
    .map((hex, i) => `  --color-${prefix}-${i + 1}: ${hex.toLowerCase()};`)
    .join('\n')
  return `/* ${palette.title} CSS Variables */\n:root {\n${vars}\n}`
}

/**
 * Builds SCSS Variables format
 */
export function exportToScssVariables(palette: PaletteExportData): string {
  const prefix = palette.title.toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'palette'
  const vars = palette.colors
    .map((hex, i) => `$color-${prefix}-${i + 1}: ${hex.toLowerCase()};`)
    .join('\n')
  return `// ${palette.title} SCSS Variables\n${vars}\n`
}

/**
 * Builds Tailwind CSS config format
 */
export function exportToTailwindConfig(palette: PaletteExportData): string {
  const name = palette.title.toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'custom'
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
