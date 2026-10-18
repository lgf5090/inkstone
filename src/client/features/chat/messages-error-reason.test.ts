// @vitest-environment jsdom
/**
 * What the store leaves behind when reading a thread was refused.
 *
 * The banner a refused thread shows is built from a single string, `messagesError`, and the view prints that
 * string as a detail line only when it differs from the headline the catalog already supplies. So storing the
 * headline here was self-cancelling: the route's sentence about the field it refused was dropped at the store,
 * and the reader saw one identical line for a missing thread, a refused conversation id and a validator that
 * rejected one field — the toast that carried the reason having expired long before the banner was read.
 *
 * Both halves are pinned because the second is how this kind of fix usually goes wrong: with a reason the
 * field holds exactly that reason, and with nothing to say it holds the generic sentence, so the banner stays
 * the one-line block it has always been instead of growing an empty second line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../../lib/api'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'

/** A refusal told the way `routeApiError()` tells one: a localised headline, and the route's line under it. */
function refusal(detail?: string): ApiError {
  return new ApiError(400, 'bad_request', t('api.error.bad_request'), undefined, detail)
}

const original = useAssistant.getState()
const toast = vi.fn()

async function openRefusedThread(): Promise<void> {
  await useAssistant.getState().openConversation('c1')
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  toast.mockClear()
  useUi.setState({ ...useUi.getState(), toast })
  useAssistant.setState({
    ...original,
    activeId: null,
    messages: [],
    messagesError: null,
    messagesReady: true,
    // The artifacts beside a thread are read in parallel and are not this case's subject; left real, the
    // unstubbed call fails in jsdom and its own refusal lands as a second toast.
    loadArtifacts: vi.fn(async () => undefined),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  useAssistant.setState(original, true)
})

describe('the reason a refused thread keeps', () => {
  it('holds the route\'s own sentence, not the headline the banner already prints', async () => {
    const reason = 'The reader\'s own history is not readable here.'
    vi.spyOn(api.assistant, 'conversation').mockRejectedValue(refusal(reason))

    await openRefusedThread()

    const state = useAssistant.getState()
    expect(state.messagesError, 'the reason was flattened at the store, so the banner has nothing left to show')
      .toBe(reason)
    expect(state.messagesError).not.toBe(t('assistant.chat.load_failed'))
  })

  it('falls back to the generic sentence when the route said nothing beyond the code', async () => {
    vi.spyOn(api.assistant, 'conversation').mockRejectedValue(refusal())

    await openRefusedThread()

    // Equal to the headline on purpose: that is the signal the view uses to drop the detail line rather
    // than print the same sentence twice, or an empty one where the reason should have been.
    expect(useAssistant.getState().messagesError).toBe(t('assistant.chat.load_failed'))
  })

  it('still says the failure out loud beside the banner', async () => {
    vi.spyOn(api.assistant, 'conversation').mockRejectedValue(refusal('No such thread.'))

    await openRefusedThread()

    expect(toast).toHaveBeenCalledTimes(1)
  })
})
