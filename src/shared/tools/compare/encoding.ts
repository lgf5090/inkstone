/**
 * Which character encoding a file is in, and how to read it without printing mojibake.
 *
 * A comparison tool that guesses and then draws mojibake is worse than one that says "I cannot read
 * this file", so detection only answers when it has evidence: a byte-order mark, a sample that the
 * strict UTF-8 decoder accepts, the null-byte pattern UTF-16 leaves, or a sample the strict GBK
 * decoder accepts. When none of those hold the answer is `null` and the screen asks the reader to
 * choose a decoder instead of drawing a guess.
 */

export const TEXT_ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'gbk'] as const
export type TextEncoding = (typeof TEXT_ENCODINGS)[number]

export type EncodingEvidence = 'bom' | 'utf8' | 'utf16' | 'gbk'

export interface EncodingDetection {
  encoding: TextEncoding | null
  evidence: EncodingEvidence | null
  /** Whether the decision rests on a mark in the file rather than on a successfully decoded sample. */
  confident: boolean
}

const SAMPLE_BYTES = 64 * 1024

function sampleOf(bytes: Uint8Array): Uint8Array {
  return bytes.byteLength > SAMPLE_BYTES ? bytes.subarray(0, SAMPLE_BYTES) : bytes
}

function decodesStrictly(bytes: Uint8Array, encoding: TextEncoding): boolean {
  try {
    new TextDecoder(encoding, { fatal: true, ignoreBOM: false }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** UTF-16 without a BOM leaves a null byte beside every ASCII character; the side tells the order. */
function utf16Pattern(bytes: Uint8Array): TextEncoding | null {
  if (bytes.byteLength < 8) return null
  const limit = Math.min(bytes.byteLength - (bytes.byteLength % 2), SAMPLE_BYTES)
  let evenNulls = 0
  let oddNulls = 0
  let pairs = 0
  for (let index = 0; index + 1 < limit; index += 2) {
    pairs++
    if (bytes[index] === 0) evenNulls++
    if (bytes[index + 1] === 0) oddNulls++
  }
  if (pairs === 0) return null
  if (evenNulls / pairs > 0.3) return 'utf-16be'
  if (oddNulls / pairs > 0.3) return 'utf-16le'
  return null
}

/** A file this full of control characters is a binary, not a text with an unreadable decoder. */
export function looksBinary(bytes: Uint8Array): boolean {
  const sample = sampleOf(bytes)
  if (sample.byteLength === 0) return false
  let controls = 0
  for (let index = 0; index < sample.byteLength; index++) {
    const code = sample[index]!
    if (code === 0) return true
    // Tab, newline and carriage return are text; the rest of C0 is not.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) controls++
  }
  return controls / sample.byteLength > 0.3
}

export function detectEncoding(bytes: Uint8Array): EncodingDetection {
  const sample = sampleOf(bytes)
  if (sample.byteLength >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return { encoding: 'utf-8', evidence: 'bom', confident: true }
  }
  if (sample.byteLength >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
    return { encoding: 'utf-16le', evidence: 'bom', confident: true }
  }
  if (sample.byteLength >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
    return { encoding: 'utf-16be', evidence: 'bom', confident: true }
  }

  // A UTF-16 file without a mark is full of null bytes, which `looksBinary` would call binary; the
  // order here is what keeps a wide-encoded text file readable rather than refused.
  const wide = utf16Pattern(sample)
  if (wide && decodesStrictly(sample, wide)) {
    return { encoding: wide, evidence: 'utf16', confident: false }
  }

  if (decodesStrictly(sample, 'utf-8')) {
    return { encoding: 'utf-8', evidence: 'utf8', confident: true }
  }

  if (!looksBinary(sample) && decodesStrictly(sample, 'gbk')) {
    return { encoding: 'gbk', evidence: 'gbk', confident: false }
  }

  return { encoding: null, evidence: null, confident: false }
}

/** The bytes as text. `fatal` keeps a wrong guess from being silently replaced with `�`. */
export function decodeBytes(
  bytes: Uint8Array,
  encoding: TextEncoding,
  fatal = true,
): string {
  return new TextDecoder(encoding, { fatal, ignoreBOM: false }).decode(bytes)
}
