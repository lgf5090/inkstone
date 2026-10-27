export function sliceText(value: string, start = 0, end = value.length): string {
  let from = clampIndex(start, value.length)
  let to = clampIndex(end, value.length)
  if (to < from) to = from

  if (from > 0 && isLowSurrogate(value.charCodeAt(from)) && isHighSurrogate(value.charCodeAt(from - 1))) {
    from++
  }
  if (to > from && to < value.length && isLowSurrogate(value.charCodeAt(to)) && isHighSurrogate(value.charCodeAt(to - 1))) {
    to--
  }
  return value.slice(from, to)
}

export function truncateText(value: string, maxLength: number): string {
  if (!Number.isFinite(maxLength) || maxLength <= 0) return ''
  const limit = Math.min(value.length, Math.floor(maxLength))
  return sliceText(value, 0, limit)
}

/**
 * Title suffixes that carry a note's file type. The workspace picks the drawing editor, the ink
 * editor and the mind map editor off the END of the title, so appending the copy marker after the
 * extension turns the duplicate into plain text: `Board.excalidraw` used to become
 * `Board.excalidraw copy`, which no editor claims. The list lives here because this module must not
 * reach into the client; the tests pin every consumer (`isInkNoteTitle`, `isMindmapDocumentTitle`
 * and the workspace's drawing check) to it, so adding a type without adding it here goes red.
 */
export const NOTE_TYPE_SUFFIXES = ['.excalidraw', '.elixir', '.ink']

export function duplicateNoteTitle(
  title: string,
  maxLength: number,
  fallback = 'Untitled note',
  suffix = ' copy',
): string {
  const normalizedSuffix = truncateText(suffix, maxLength)
  const base = title.trim() || fallback
  const matched = NOTE_TYPE_SUFFIXES.find((candidate) => base.toLowerCase().endsWith(candidate))
  const type = matched ? base.slice(base.length - matched.length) : ''
  const head = type ? base.slice(0, base.length - type.length) : base
  const reserve = normalizedSuffix.length + type.length
  return truncateText(head, Math.max(0, maxLength - reserve)) + normalizedSuffix + type
}

/**
 * UTF-8 byte length without allocating an encoded copy (note bodies reach 1.9 MB and
 * this runs on every write). Lone surrogates count as 3 bytes, matching TextEncoder's
 * U+FFFD replacement.
 */
export function utf8ByteLength(value: string): number {
  let total = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x80) {
      total += 1
    }
    else if (code < 0x800) {
      total += 2
    }
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        total += 4
        index++
      }
      else {
        total += 3
      }
    }
    else {
      total += 3
    }
  }
  return total
}

function clampIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) return value === Infinity ? length : 0
  return Math.min(length, Math.max(0, Math.trunc(value)))
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff
}
