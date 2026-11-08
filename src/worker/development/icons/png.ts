import { zlibSync } from 'fflate'

/**
 * A minimal PNG encoder.
 *
 * Rasterization hands back RGBA pixels, and the outputs are written to R2 as PNG. The repository
 * already ships `fflate` for ZIP work, so the only pieces missing are the chunk framing and the
 * CRC table — both are defined by the PNG specification and do not need a dependency of their own.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const output = new Uint8Array(12 + data.byteLength)
  const view = new DataView(output.buffer)
  view.setUint32(0, data.byteLength)
  for (let index = 0; index < 4; index += 1) output[4 + index] = type.charCodeAt(index)
  output.set(data, 8)
  view.setUint32(8 + data.byteLength, crc32(output.subarray(4, 8 + data.byteLength)))
  return output
}

/** Encode straight (unfiltered) RGBA bytes as a PNG. A zero-length image is refused. */
export function encodePngRgba(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('The PNG dimensions are not valid')
  }
  if (rgba.byteLength !== width * height * 4) throw new Error('The PNG pixel buffer does not match its dimensions')

  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0
    raw.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1)
  }

  const header = new Uint8Array(13)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, width)
  headerView.setUint32(4, height)
  header[8] = 8
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = 0

  const compressed = zlibSync(raw, { level: 6 })
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}
