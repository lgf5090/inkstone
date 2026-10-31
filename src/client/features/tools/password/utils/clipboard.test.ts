import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_CLEAR_MS, copySecret } from './clipboard'

function stubClipboard(initial: string) {
  const writeText = vi.fn(async () => undefined)
  const readText = vi.fn(async () => initial)
  Object.assign(navigator, { clipboard: { writeText, readText } })
  return { writeText, readText }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('copySecret', () => {
  it('writes the secret now and wipes it after the delay', async () => {
    vi.useFakeTimers()
    const { writeText, readText } = stubClipboard('hunter2')

    await copySecret('hunter2')
    expect(writeText).toHaveBeenCalledWith('hunter2')

    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS)

    expect(readText).toHaveBeenCalled()
    expect(writeText).toHaveBeenLastCalledWith('')
  })

  it('leaves the clipboard alone when it no longer holds the secret', async () => {
    vi.useFakeTimers()
    const { writeText } = stubClipboard('something-else')

    await copySecret('hunter2')
    writeText.mockClear()
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS)

    expect(writeText).not.toHaveBeenCalled()
  })

  it('does not report a failed clean-up as a failed copy', async () => {
    vi.useFakeTimers()
    const { writeText } = stubClipboard('')
    Object.assign(navigator, {
      clipboard: {
        writeText,
        readText: vi.fn(async () => {
          throw new Error('denied')
        }),
      },
    })

    await expect(copySecret('hunter2')).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS)
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})
