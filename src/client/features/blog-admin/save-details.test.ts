import { describe, expect, it, vi } from 'vitest'
import { saveDetailsInOrder } from './save-details'

describe('saveDetailsInOrder', () => {
  it('writes the post row before the frontmatter tags', async () => {
    const steps: string[] = []
    const result = await saveDetailsInOrder(
      async () => { steps.push('post') },
      async () => { steps.push('tags'); return true },
    )
    expect(steps).toEqual(['post', 'tags'])
    expect(result).toBe(true)
  })

  it('does not touch tags when the post row is refused', async () => {
    const tagWrite = vi.fn(async () => true)
    await expect(saveDetailsInOrder(async () => { throw new Error('slug taken') }, tagWrite))
      .rejects.toThrow('slug taken')
    expect(tagWrite).not.toHaveBeenCalled()
  })
})
