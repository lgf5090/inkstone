export const MEMO_LINK_PREVIEW_MAX = 10

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '*'])
const CLOSING_BRACKETS: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{',
}

export function parseMemoHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.hostname ? url : null
  } catch {
    return null
  }
}

function blank(value: string): string {
  return value.replace(/[^\n]/g, ' ')
}

function maskFencedCode(content: string): string {
  const lines = content.split('\n')
  let fence: { marker: string; length: number } | null = null
  for (const [index, line] of lines.entries()) {
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
    if (!fence) {
      if (!opening) continue
      fence = { marker: opening[1]![0]!, length: opening[1]!.length }
      lines[index] = blank(line)
      continue
    }
    lines[index] = blank(line)
    if (closing && closing[1]![0] === fence.marker && closing[1]!.length >= fence.length) {
      fence = null
    }
  }
  return lines.join('\n')
}

function maskInlineCode(content: string): string {
  const runs = [...content.matchAll(/`+/g)]
  let result = content
  for (let index = 0; index < runs.length; index += 1) {
    const opening = runs[index]!
    const closingIndex = runs.findIndex(
      (run, position) => position > index && run[0].length === opening[0].length,
    )
    if (closingIndex < 0) continue
    const start = opening.index!
    const end = runs[closingIndex]!.index! + opening[0].length
    result = result.slice(0, start) + blank(result.slice(start, end)) + result.slice(end)
    index = closingIndex
  }
  return result
}

function maskMarkdownLinks(content: string): string {
  return content
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, blank)
    .replace(/^ {0,3}\[[^\]\n]+\]:[^\n]*$/gm, blank)
    .replace(/<https?:\/\/[^>\s]+>/gi, blank)
    .replace(/<[^>\n]+>/g, blank)
}

function count(value: string, character: string, end: number): number {
  let total = 0
  for (let index = 0; index < end; index += 1) {
    if (value[index] === character) total += 1
  }
  return total
}

function trimTrailing(value: string): string {
  let end = value.length
  while (end > 0) {
    const last = value[end - 1]!
    if (TRAILING_PUNCTUATION.has(last)) {
      end -= 1
      continue
    }
    const opener = CLOSING_BRACKETS[last]
    if (opener) {
      if (count(value, last, end) <= count(value, opener, end)) break
      end -= 1
      continue
    }
    break
  }
  return value.slice(0, end)
}

export function extractMemoLinkUrls(content: string, limit = MEMO_LINK_PREVIEW_MAX): string[] {
  if (limit <= 0 || !content.includes('://')) return []
  const masked = maskMarkdownLinks(maskInlineCode(maskFencedCode(content)))
  const urls: string[] = []
  const seen = new Set<string>()
  for (const match of masked.matchAll(URL_PATTERN)) {
    const url = trimTrailing(match[0])
    const parsed = parseMemoHttpUrl(url)
    if (!parsed || parsed.username || parsed.password) continue
    parsed.hash = ''
    const normalized = parsed.toString()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    urls.push(normalized)
    if (urls.length >= limit) break
  }
  return urls
}
