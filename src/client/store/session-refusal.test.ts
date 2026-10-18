// @vitest-environment jsdom
/**
 * The notices the session store leaves behind when the server refuses it.
 *
 * Signing out, a settings change the debounce finally sent, and the banner the login form prints after a
 * refused session read. All three used to hand the toast — or the form — `err.message`, which for an
 * `ApiError` is the app's sentence for the route's *code*, and that sentence is deliberately generic:
 * `bad_request` covers an unset name, an over-long one and a body that is not JSON alike. The route
 * usually names the field it refused and says what is wrong with it, and `routeApiError()` keeps that line;
 * here it was dropped at the last step, so a settings write refused for one bad enum value, a sign-out
 * refused by a stale token and a session belonging to a deleted account all read as "The request is invalid".
 *
 * What is pinned is therefore two-sided, in the shape `useUi`'s toast already has: with a route reason the
 * notice carries it, and with none the input is exactly what it was before — same keys, same single line, no
 * empty description under the headline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { ApiError, api } from '../lib/api'
import { initI18n, setLocale, t } from '../lib/i18n'
import { useSession } from './session'
import { useUi, type ToastInput } from './ui'

const confirmMock = vi.hoisted(() => vi.fn(async (_options: { title?: string }) => false))
const notes = vi.hoisted(() => ({ pendingCount: 0, flushFails: false }))

vi.mock('../components/overlay', () => ({ confirm: confirmMock }))
vi.mock('../store/notes', () => ({
  useNotes: {
    getState: () => ({
      pendingCount: notes.pendingCount,
      flush: async () => {
        if (notes.flushFails) throw new Error('offline')
      },
    }),
  },
}))

/** The refusal a route answers with when it is able to point at a field. */
function refused(body: unknown, status = 400): Response {
  return new Response(JSON.stringify({ error: body }), { status, headers: { 'content-type': 'application/json' } })
}

let toastSpy: ReturnType<typeof vi.fn>

const realToast = useUi.getState().toast
const original = useSession.getState()

/** The one notice that went out, when exactly one did. */
function onlyToast(): ToastInput {
  expect(toastSpy, 'the failure popped no notice at all').toHaveBeenCalledTimes(1)
  return toastSpy.mock.calls[0]![0] as ToastInput
}

/** One settings change, written and sent: the clock is the store's own debounce, not a wall-clock wait. */
async function saveSettings(): Promise<void> {
  useSession.getState().updateSettings({ appearance: { ...DEFAULT_SETTINGS.appearance, proseSize: 20, language: 'en-US' } })
  await vi.advanceTimersByTimeAsync(500)
}

beforeEach(async () => {
  localStorage.clear()
  notes.pendingCount = 0
  notes.flushFails = false
  confirmMock.mockReset()
  confirmMock.mockResolvedValue(false)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  await initI18n()
  // The strings asserted below are the ones the reader sees, and `translateServiceMessage` rewrites an
  // unmapped fallback in every locale but this one, so the case states which language it is written in.
  setLocale('en-US', false)
  toastSpy = vi.fn((_input: ToastInput) => 't0')
  useUi.setState({ toast: toastSpy as unknown as typeof realToast })
  useSession.setState({ ...original, settings: DEFAULT_SETTINGS, user: null, site: null })
  vi.stubGlobal('location', { reload: vi.fn(), href: 'http://localhost/' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useUi.setState({ toast: realToast })
  useSession.setState(original, true)
})

describe('a refused sign-out', () => {
  it('says which field the route refused, not only that the request was invalid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refused({
      code: 'bad_request',
      message: 'The confirmation token expired with the session it belonged to.',
      details: { token: 'no longer valid' },
    })))

    await useSession.getState().logout()

    const toast = onlyToast()
    expect(toast.title).toBe(t('session.logout_failed'))
    expect(toast.tone).toBe('danger')
    expect(toast.description).toContain(t('api.error.bad_request'))
    expect(toast.description).toContain('confirmation token expired')
    expect(toast.description).toContain('no longer valid')
    // The notice was not asked to carry a new channel: the reason rides on the description it already had.
    expect(Object.keys(toast).sort()).toEqual(['description', 'title', 'tone'])
  })

  it('is the same notice it has always been when the route said nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))

    await useSession.getState().logout()

    expect(onlyToast()).toEqual({
      title: t('session.logout_failed'),
      description: t('api.request_failed_status', { status: 500 }),
      tone: 'danger',
    })
  })
})

describe('a session read the server refused', () => {
  it('leaves the login form the route\'s own reason, not only the generic sentence', async () => {
    // The banner under the form is one string, and until now it held `err.message` — which for an
    // `ApiError` is the app's sentence for the *code*. The route's line about the session existed and was
    // discarded on the way, so a stale account, a corrupt cookie and a refused field all read the same.
    vi.stubGlobal('fetch', vi.fn(async () => refused({
      code: 'bad_request',
      message: 'The stored session belongs to an account that no longer exists.',
      details: { session: 'unknown' },
    })))

    await useSession.getState().load()

    const error = useSession.getState().authError
    expect(error, 'the banner kept nothing the route said').toBeTruthy()
    expect(error).toContain(t('api.error.bad_request'))
    expect(error).toContain('account that no longer exists')
    expect(error).toContain('unknown')
  })

  it('shows the sentence it has always shown when the route named nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))

    await useSession.getState().load()

    expect(useSession.getState().authError).toBe(t('api.request_failed_status', { status: 500 }))
  })
})

describe('a refused settings write', () => {
  it('names the field the validator refused', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => refused({
      code: 'bad_request',
      message: 'The reading measure is not one of the four the layout knows.',
      details: { appearance: { proseWidth: 'invalid enum value' } },
    })))

    await saveSettings()

    const toast = onlyToast()
    expect(toast.title).toBe(t('session.could_not_save_settings'))
    expect(toast.description).toContain(t('api.error.bad_request'))
    expect(toast.description).toContain('reading measure is not one of the four')
    expect(toast.description).toContain('proseWidth')
  })

  it('stays one line when the route sent no body', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))

    await saveSettings()

    expect(onlyToast()).toEqual({
      title: t('session.could_not_save_settings'),
      description: t('api.request_failed_status', { status: 503 }),
      tone: 'danger',
    })
  })

  it('leaves a failure that never reached the route as the plain message it was', async () => {
    vi.useFakeTimers()
    vi.spyOn(api.settings, 'save').mockRejectedValue(new ApiError(0, 'offline', t('api.no_network_connection')))

    await saveSettings()

    expect(onlyToast()).toEqual({
      title: t('session.could_not_save_settings'),
      description: t('api.no_network_connection'),
      tone: 'danger',
    })
  })
})
