/**
 * A new tag has to reach the conversation it was made for, or say why it did not.
 *
 * `createTag` is optimistic — it validates the name, answers a duplicate with the tag that already
 * exists, seeds the local cache and posts the row without waiting — so its id is in hand before the
 * server has a row to point at, and the attach route refuses an unknown tag. The old path caught that
 * refusal and threw the answer away: the reader typed a name, nothing appeared, and no one said so.
 * What is pinned here is the two honest outcomes: the conversation is filed once the row is back, or a
 * danger toast says it was not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationTag } from '@shared/assistant'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { assistant: {} },
}))

const TAG: ConversationTag & { count: number } = { id: 't9', name: 'urgent', color: null, count: 0 }
const original = useAssistant.getState()

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  vi.useFakeTimers()
  useUi.setState({ toasts: [] })
  useAssistant.setState({ ...original, tagNodes: [] })
})

afterEach(() => {
  useAssistant.setState(original, true)
  useUi.setState({ toasts: [] })
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('filing a conversation under a tag that was only just created', () => {
  it('waits for the row to come back before attaching', async () => {
    // The row lands on the second read, which is what a POST still on the wire looks like from here.
    const loadTaxonomy = vi.fn(async () => {
      if (loadTaxonomy.mock.calls.length >= 2) useAssistant.setState({ tagNodes: [TAG] })
    })
    const toggle = vi.fn(async () => undefined)
    useAssistant.setState({ loadTaxonomy, toggleConversationTag: toggle })
    const pending = useAssistant.getState().attachNewTag('c1', 't9')
    await vi.runAllTimersAsync()
    await pending
    expect(loadTaxonomy.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(toggle).toHaveBeenCalledWith('c1', 't9', true)
  })

  it('attaches at once when the row is already there', async () => {
    useAssistant.setState({
      tagNodes: [TAG],
      loadTaxonomy: vi.fn(async () => undefined),
      toggleConversationTag: vi.fn(async () => undefined),
    })
    const toggle = useAssistant.getState().toggleConversationTag
    await useAssistant.getState().attachNewTag('c1', 't9')
    expect(toggle).toHaveBeenCalledWith('c1', 't9', true)
    expect(useUi.getState().toasts).toHaveLength(0)
  })

  it('says so when the row never arrives, instead of filing nothing in silence', async () => {
    const toggle = vi.fn(async () => undefined)
    useAssistant.setState({ loadTaxonomy: vi.fn(async () => undefined), toggleConversationTag: toggle })
    const pending = useAssistant.getState().attachNewTag('c1', 'gone')
    await vi.runAllTimersAsync()
    await pending
    expect(toggle).not.toHaveBeenCalled()
    const toasts = useUi.getState().toasts
    expect(toasts.length, 'a label that did not reach the conversation was never mentioned').toBeGreaterThan(0)
    expect(toasts.at(-1)?.tone).toBe('danger')
  })
})
