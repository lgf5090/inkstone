// @vitest-environment jsdom
/**
 * What an assistant write answers, and where a refusal is said.
 *
 * Every form on this screen waits on one of these actions, and the action used to swallow its own error
 * into a toast and resolve with nothing — so `await` returned the same thing for a saved model and for a
 * refused one, and the only way a form had to learn the difference was to guess. Two claims are pinned
 * here: the answer is a yes or a no, and a failure is told once — in the toast for a caller that prints
 * nothing, in the caller's own line for a form that has one. The second half is also what keeps the
 * route's own sentence (the field it refused) from being flattened into the generic refusal a mapped code
 * translates to, which is what a reader used to get for every bad request of any kind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { ApiError, api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { useAssistant, type ReportFailure, type WriteFailure } from './assistant-store'

/** One refused route, told the way `request()` tells it: a code the client knows, and the sentence under it. */
const refusal = () => new ApiError(400, 'bad_request', t('api.error.bad_request'), undefined, 'A model name is required.')

const original = useAssistant.getState()
let toastSpy: ReturnType<typeof vi.fn>

/** The form-facing half of a write: the failure it is to print, collected rather than thrown. */
function collect(): { failures: WriteFailure[], report: ReportFailure } {
  const failures: WriteFailure[] = []
  return { failures, report: (failure) => { failures.push(failure) } }
}

beforeEach(async () => {
  await initI18n()
  toastSpy = vi.fn()
  const real = useUi.getState().toast
  useUi.setState({ toast: toastSpy as typeof real })
  // The reads a write chains behind it are not this file's subject; the real ones would ask for a server.
  useAssistant.setState({
    loadSettings: vi.fn(async () => undefined),
    loadMcp: vi.fn(async () => undefined),
  })
})

afterEach(() => {
  useAssistant.setState(original, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('a write the reader asked for', () => {
  it('answers false when the route refuses it', async () => {
    vi.spyOn(api.assistant, 'updateModel').mockRejectedValue(refusal())
    const { failures, report } = collect()
    expect(await useAssistant.getState().updateModel('m1', { label: '' }, report)).toBe(false)
    expect(useAssistant.getState().loadSettings).not.toHaveBeenCalled()
    // The form got the two lines, so the toast stays out of the way: one failure, one surface.
    expect(failures).toEqual([{ headline: t('api.error.bad_request'), detail: 'A model name is required.' }])
    expect(toastSpy).not.toHaveBeenCalled()
  })

  it('answers true, and reads the settings back, when the route takes it', async () => {
    vi.spyOn(api.assistant, 'updateModel').mockResolvedValue(undefined as never)
    expect(await useAssistant.getState().updateModel('m1', { label: 'DeepSeek Flash' })).toBe(true)
    expect(useAssistant.getState().loadSettings).toHaveBeenCalled()
    expect(toastSpy).not.toHaveBeenCalled()
  })

  it('keeps toasting for a caller that prints nothing, as the model list rows do', async () => {
    vi.spyOn(api.assistant, 'updateModel').mockRejectedValue(refusal())
    expect(await useAssistant.getState().updateModel('m1', { reasoning: 'off' })).toBe(false)
    expect(toastSpy).toHaveBeenCalledWith({ title: t('api.error.bad_request'), tone: 'danger' })
  })

  it('answers false for every write a form waits on', async () => {
    const writes: { label: string, refuse: () => void, run: (report: ReportFailure) => Promise<boolean> }[] = [
      {
        label: 'updateProvider',
        refuse: () => { vi.spyOn(api.assistant, 'updateProvider').mockRejectedValue(refusal()) },
        run: (report) => useAssistant.getState().updateProvider('p1', { label: 'Example' }, report),
      },
      {
        label: 'addModel',
        refuse: () => { vi.spyOn(api.assistant, 'createModel').mockRejectedValue(refusal()) },
        run: (report) => useAssistant.getState().addModel({ providerId: 'p1', model: 'gpt' }, report),
      },
      {
        label: 'patchMcpServer',
        refuse: () => { vi.spyOn(api.assistant, 'patchMcpServer').mockRejectedValue(refusal()) },
        run: (report) => useAssistant.getState().patchMcpServer('s1', { label: 'Example' }, report),
      },
      {
        label: 'addMcpServer',
        refuse: () => { vi.spyOn(api.assistant, 'createMcpServer').mockRejectedValue(refusal()) },
        run: (report) => useAssistant.getState().addMcpServer({ label: 'Example' }, report),
      },
    ]
    for (const write of writes) {
      write.refuse()
      const { failures, report } = collect()
      expect(await write.run(report), `${write.label} claimed success`).toBe(false)
      expect(failures, `${write.label} said nothing about why`).toEqual([
        { headline: t('api.error.bad_request'), detail: 'A model name is required.' },
      ])
    }
  })

  it('answers null when a new provider is refused, so its form stays open', async () => {
    vi.spyOn(api.assistant, 'createProvider').mockRejectedValue(refusal())
    const { failures, report } = collect()
    expect(await useAssistant.getState().addProvider({ label: 'Example' }, report)).toBe(null)
    expect(failures).toHaveLength(1)
    expect(toastSpy).not.toHaveBeenCalled()
  })
})

describe('the refusal as the route wrote it', () => {
  it('keeps the sentence the route said beside the localised headline, all the way to the form', async () => {
    const answer = new Response(JSON.stringify({
      error: { code: 'bad_request', message: 'A model name is required.' },
    }), { status: 400, headers: { 'content-type': 'application/json' } })
    vi.stubGlobal('fetch', vi.fn(async () => answer))
    const { failures, report } = collect()
    expect(await useAssistant.getState().updateModel('m1', { label: '' }, report)).toBe(false)

    // The headline is the app's own sentence, in the reader's language — the route's English is never the
    // primary line, because no catalog key translates it and the i18n gate would be right to refuse one.
    expect(failures[0]?.headline).toBe(t('api.error.bad_request'))
    expect(failures[0]?.detail).toBe('A model name is required.')
  })

  it('says nothing extra when the route said nothing extra', async () => {
    vi.spyOn(api.assistant, 'updateModel').mockRejectedValue(new ApiError(500, 'internal', t('api.error.internal')))
    const { failures, report } = collect()
    expect(await useAssistant.getState().updateModel('m1', { label: 'Fine' }, report)).toBe(false)
    expect(failures[0]).toEqual({ headline: t('api.error.internal'), detail: null })
  })
})
