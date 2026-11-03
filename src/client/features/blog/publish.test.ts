/**
 * "Update" publishes what the reader sees.
 *
 * The editor keeps unsaved keystrokes in the notes store, so a refresh that read the server copy
 * would re-publish the previous paragraph. These cases pin the store-first read and the flush that
 * makes the server agree with it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  contents: {} as Record<string, string | undefined>,
  flush: vi.fn(async () => undefined),
  get: vi.fn(),
  publish: vi.fn(async () => ({})),
  capture: vi.fn(async () => ({ version: 1 })),
  toast: vi.fn(),
  reload: vi.fn(),
}))

vi.mock('./snapshot', () => ({ captureBlogSnapshot: state.capture }))
vi.mock('./status', () => ({ useBlogNoteStatus: { getState: () => ({ reload: state.reload }) } }))
vi.mock('../../lib/api', () => ({
  api: {
    notes: { get: state.get },
    blog: { publish: state.publish },
  },
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
}))
vi.mock('../../store/notes', () => ({
  useNotes: {
    getState: () => ({
      contents: state.contents,
      flush: state.flush,
    }),
  },
}))
vi.mock('../../store/ui', () => ({ useUi: { getState: () => ({ toast: state.toast }) } }))

const { refreshBlogSnapshot } = await import('./publish')

const PUBLISHED = '---\nblogType: post\nisPublished: true\n---\n\nFresh paragraph.\n'
const OLD = '---\nblogType: post\nisPublished: true\n---\n\nOld paragraph.\n'

beforeEach(() => {
  state.contents = {}
  state.flush.mockClear()
  state.get.mockReset()
  state.publish.mockClear()
  state.capture.mockClear()
  state.toast.mockClear()
})

describe('refreshBlogSnapshot', () => {
  it('publishes the open editor buffer instead of re-reading the server copy', async () => {
    state.contents.n1 = PUBLISHED
    state.get.mockResolvedValue({ content: OLD })

    expect(await refreshBlogSnapshot('n1')).toBe(true)
    expect(state.flush).toHaveBeenCalledWith({ immediate: true })
    expect(state.capture).toHaveBeenCalledWith('n1', PUBLISHED)
    expect(state.publish).toHaveBeenCalledWith('n1', { version: 1 })
  })

  it('falls back to the server when the note is not open here', async () => {
    state.get.mockResolvedValue({ content: PUBLISHED })

    expect(await refreshBlogSnapshot('n1')).toBe(true)
    expect(state.flush).not.toHaveBeenCalled()
    expect(state.capture).toHaveBeenCalledWith('n1', PUBLISHED)
  })

  it('does not republish a note that is no longer published', async () => {
    state.get.mockResolvedValue({ content: '---\nblogType: post\nisPublished: false\n---\n\nDraft.\n' })

    expect(await refreshBlogSnapshot('n1')).toBe(false)
    expect(state.capture).not.toHaveBeenCalled()
    expect(state.publish).not.toHaveBeenCalled()
  })
})
