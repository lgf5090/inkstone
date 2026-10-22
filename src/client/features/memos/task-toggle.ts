export interface MemoTaskMarker {
  index: number
  line: number
  offset: number
  checked: boolean
}

const FENCE_LINE = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})/
const TASK_LINE = /^((?:[ \t]*>)*[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+)\[([^\]\r\n])\]/

function lineStarts(content: string): number[] {
  const starts = [0]
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    if (char === '\n') {
      starts.push(index + 1)
    } else if (char === '\r') {
      if (content[index + 1] === '\n') index += 1
      starts.push(index + 1)
    }
  }
  return starts
}

export function findMemoTasks(content: string): MemoTaskMarker[] {
  if (!content.includes('[')) return []
  const lines = content.split(/\r\n|\r|\n/)
  const starts = lineStarts(content)
  const markers: MemoTaskMarker[] = []
  let fence: { char: string; length: number } | null = null
  for (let line = 0; line < lines.length; line += 1) {
    const text = lines[line]!
    const fenceMatch = FENCE_LINE.exec(text)
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      if (fence === null) {
        fence = { char: marker[0]!, length: marker.length }
      } else if (marker[0] === fence.char && marker.length >= fence.length) {
        fence = null
      }
      continue
    }
    if (fence !== null) continue
    const match = TASK_LINE.exec(text)
    if (!match) continue
    const status = match[2]!
    markers.push({
      index: markers.length,
      line,
      offset: (starts[line] ?? 0) + match[1]!.length + 1,
      checked: status !== ' ',
    })
  }
  return markers
}

export function toggleMemoTask(content: string, index: number): string | null {
  const marker = findMemoTasks(content)[index]
  if (!marker) return null
  const replacement = marker.checked ? ' ' : 'x'
  return `${content.slice(0, marker.offset)}${replacement}${content.slice(marker.offset + 1)}`
}

/** Rewrites every task marker in place, leaving indentation, quote depth and list bullets untouched. */
export function setAllMemoTasks(content: string, checked: boolean): string | null {
  const markers = findMemoTasks(content)
  if (markers.length === 0) return null
  const replacement = checked ? 'x' : ' '
  let next = ''
  let cursor = 0
  for (const marker of markers) {
    next += content.slice(cursor, marker.offset) + replacement
    cursor = marker.offset + 1
  }
  return next + content.slice(cursor)
}
