// @vitest-environment node
/**
 * The pooled embedder behind a whole-book index.
 *
 * A book is hundreds of page chunks, and one Workers AI call for all of them is both slow and a
 * rate-limit target. These cases pin the two promises the caller relies on: the answer keeps the input
 * order so vectors can be zipped back onto chunks, and the reader's concurrency is the number of calls
 * actually in flight — not a value that is stored and ignored.
 */
import { describe, expect, it, vi } from 'vitest'
import { chunkPageText, embedTextsPooled } from '../src/worker/mcp/ai-search'
import type { Env } from '../src/worker/env'

function fakeAi() {
  let active = 0
  let peak = 0
  const batches: number[] = []
  const run = vi.fn(async (_model: string, input: { text: string[] }) => {
    batches.push(input.text.length)
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    active -= 1
    return { data: input.text.map((text) => ({ embedding: [Number(text)] })) }
  })
  return { ai: { run } as unknown as NonNullable<Env['AI']>, run, batches, peak: () => peak }
}

const texts = Array.from({ length: 40 }, (_unused, index) => String(index))

describe('embedding a long list in batches', () => {
  it('returns one vector per text, in the order the texts were given', async () => {
    const { ai } = fakeAi()
    const vectors = await embedTextsPooled(ai, texts, 2, 4)
    expect(vectors).toHaveLength(texts.length)
    expect(vectors.map((vector) => vector[0])).toEqual(texts.map(Number))
  })

  it('keeps only the reader\'s number of batches in flight', async () => {
    const sequential = fakeAi()
    await embedTextsPooled(sequential.ai, texts, 1, 4)
    expect(sequential.peak(), 'a sequential run had more than one call open').toBe(1)
    expect(sequential.batches.every((size) => size <= 4)).toBe(true)
    expect(sequential.run).toHaveBeenCalledTimes(10)

    const pooled = fakeAi()
    await embedTextsPooled(pooled.ai, texts, 3, 4)
    expect(pooled.peak(), 'the lane count was not the concurrency the reader chose').toBe(3)
  })
})

describe('chunking one page at the reader\'s size', () => {
  it('uses the size it was given and keeps every character of a page inside the budget', () => {
    const page = 'x'.repeat(5_000)
    for (const size of [800, 1_200, 1_500, 2_000]) {
      const chunks = chunkPageText(page, size)
      expect(chunks.every((chunk) => chunk.length <= size), `a chunk was longer than ${size}`).toBe(true)
      expect(chunks.join(''), `the ${size}-character split lost or reordered text`).toBe(page)
    }
  })

  it('does not let a smaller chunk buy less of the page', () => {
    // The budget is what a page is worth indexing, so the count follows it. A short text is covered by
    // either size; a long one is covered up to the same number of characters.
    const long = 'y'.repeat(8_000)
    expect(chunkPageText(long, 800).join('').length).toBe(6_400)
    expect(chunkPageText(long, 1_500).join('').length).toBe(6_000)
    expect(chunkPageText('short page', 800)).toEqual(['short page'])
  })
})
