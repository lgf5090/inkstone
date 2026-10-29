// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/api'

vi.mock('./api', () => ({
  inknoteApi: {
    library: vi.fn(async () => { throw new ApiError(401, 'unauthenticated', 'Please sign in') }),
    settings: vi.fn(async () => ({ config: {}, updatedAt: 1 })),
    templates: vi.fn(async () => ({ templates: [] })),
    trash: vi.fn(async () => ({ notes: [] })),
  },
}))

describe('the inknote bootstrap', () => {
  it('turns a refused session into the sign-in state, not a generic error', async () => {
    const { useInknoteStore } = await import('./store')
    useInknoteStore.setState({ initialized: false, loading: false, unauthorized: false, error: null })
    await useInknoteStore.getState().bootstrap()
    expect(useInknoteStore.getState().unauthorized).toBe(true)
    expect(useInknoteStore.getState().error).toBeNull()
    expect(useInknoteStore.getState().initialized).toBe(true)
  })
})
