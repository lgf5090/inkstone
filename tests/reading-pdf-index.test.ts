import { describe, expect, it, vi } from 'vitest'
import { indexPdfPages } from '../src/client/features/reading/engine/pdf-index'

describe('indexPdfPages', () => {
  it('indexes every page beyond the old 200-page cap', async () => {
    const batches: number[][] = []
    const progress = vi.fn()
    const result = await indexPdfPages(
      201,
      async (page) => `text ${page}`,
      async (rows) => {
        batches.push(rows.map((row) => row.page))
        return { indexed: rows.length }
      },
      undefined,
      progress,
    )
    expect(result).toEqual({ pages: 201, chunks: 201 })
    expect(batches.flat()).toHaveLength(201)
    expect(batches.flat().at(-1)).toBe(201)
    expect(progress).toHaveBeenLastCalledWith(201, 201)
  })

  it('stops when cancelled and does not start another batch', async () => {
    const controller = new AbortController()
    const index = vi.fn(async (_rows: Array<{ page: number; text: string }>) => ({ indexed: 0 }))
    const promise = indexPdfPages(20, async (page) => {
      if (page === 9) controller.abort()
      return `text ${page}`
    }, index, controller.signal)
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(index).toHaveBeenCalledTimes(1)
    expect(index.mock.calls[0]?.[0].map((row) => row.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})
