export interface PdfIndexProgress {
  done: number
  total: number
}

export async function indexPdfPages(
  total: number,
  readText: (page: number) => Promise<string>,
  index: (pages: Array<{ page: number; text: string }>) => Promise<{ indexed: number }>,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<{ pages: number; chunks: number }> {
  let pages = 0
  let chunks = 0
  let batch: Array<{ page: number; text: string }> = []
  const flush = async () => {
    if (!batch.length) return
    const result = await index(batch)
    chunks += result.indexed
    batch = []
  }
  for (let page = 1; page <= total; page++) {
    if (signal?.aborted) throw new DOMException('Indexing cancelled', 'AbortError')
    const text = (await readText(page)).trim()
    if (text) {
      pages++
      batch.push({ page, text })
    }
    onProgress?.(page, total)
    if (batch.length >= 8) await flush()
  }
  await flush()
  return { pages, chunks }
}
