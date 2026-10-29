/** "1-3,7" as zero-based page indices, clamped to the pages that exist. */
export function parsePageRange(value: string, count: number): number[] {
  if (count <= 0) return []
  const text = value.trim()
  if (!text) return Array.from({ length: count }, (_, index) => index)
  const picked = new Set<number>()
  for (const part of text.split(/[,\uFF0C\s]+/)) {
    if (!part) continue
    const single = /^(\d+)$/.exec(part)
    if (single) {
      const page = Number(single[1])
      if (page >= 1 && page <= count) picked.add(page - 1)
      continue
    }
    const span = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part)
    if (!span) continue
    const from = Number(span[1])
    const to = Number(span[2])
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    for (let page = Math.max(1, Math.min(from, to)); page <= Math.min(count, Math.max(from, to)); page += 1) picked.add(page - 1)
  }
  return picked.size ? [...picked].sort((a, b) => a - b) : Array.from({ length: count }, (_, index) => index)
}
