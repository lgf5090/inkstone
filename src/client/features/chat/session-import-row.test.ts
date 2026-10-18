// @vitest-environment jsdom
/**
 * The session-import row on the assistant's Data tab: the three states a reader has to tell apart.
 *
 * The file this row takes was not written by this app, so every one of the three states carries a fact the
 * reader cannot get from the button alone. Nothing picked yet — the row has to say what it will read.
 * Picking — the chosen file's own name and size, because the ceiling is a size and the reader is holding
 * the file, not the number. Then the answer: the counts the route wrote, the reasons it gave for what it
 * refused, or the reason it refused the file whole. A toast that vanished in four seconds would leave a
 * reader with half a library of threads and nothing on screen to say so, which is why the result is drawn
 * as well as announced.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatBytes } from '@shared/byte-format'
import { initI18n, t } from '../../lib/i18n'
import { ApiError } from '../../lib/api'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { SessionImportRow } from './AssistantDataTab'

const { importSessionFile, bootstrap } = vi.hoisted(() => ({
  importSessionFile: vi.fn(),
  bootstrap: vi.fn(),
}))

vi.mock('../../lib/api', () => ({
  // Stands in for the real one with the real argument order: the row reads the route's own sentence off the
  // fifth argument, so a fake that took the message first would let the ceiling case below pass on a field
  // the production class never puts where the row looks for it.
  ApiError: class ApiError extends Error {
    readonly serverMessage: string | undefined
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
      readonly details?: unknown,
      serverMessage?: string,
    ) {
      super(message)
      this.serverMessage = serverMessage
    }
  },
  api: {
    assistant: {
      importSessionFile: (payload: { filename: string, text: string }) => importSessionFile(payload),
    },
  },
}))

vi.mock('./assistant-store', () => ({
  useAssistant: Object.assign(() => undefined, { getState: () => ({ bootstrap }) }),
}))

const SUMMARY = { threads: 2, messages: 40, alreadyImported: 0, skipped: [] as string[] }

let rendered: RenderedElement | null = null

const text = () => rendered!.container.textContent ?? ''
const buttons = () => [...rendered!.container.querySelectorAll<HTMLButtonElement>('button')]
const importButton = () => buttons().find((node) => node.textContent?.trim() === t('assistant.settings.import_sessions'))
const status = () => rendered!.container.querySelector('[role="status"]')
const alert = () => rendered!.container.querySelector('[role="alert"]')

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

/**
 * The file the reader chose, put on the hidden input the way a browser puts it there.
 *
 * `value` is stubbed because the row clears it after reading, which is the only way a second pick of the
 * same file fires a change event at all — so the test asserts on the row rather than on jsdom's notion of
 * what a file input may hold.
 */
async function pickFile(name: string, body: string): Promise<void> {
  const input = rendered!.container.querySelector('input[type="file"]')
  expect(input, 'the row offers no file chooser').toBeTruthy()
  const cleared = vi.fn()
  Object.defineProperty(input, 'value', { get: () => '', set: cleared, configurable: true })
  Object.defineProperty(input, 'files', { value: [new File([body], name)], configurable: true })
  await act(async () => {
    input!.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(cleared, 'the chooser still holds the file after picking').toHaveBeenCalled()
}

async function mount(): Promise<void> {
  rendered?.unmount()
  rendered = renderElement(createElement(SessionImportRow))
  await settle()
}

const originalToast = useUi.getState().toast

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useUi.setState({ toast: originalToast })
  importSessionFile.mockReset().mockResolvedValue({ imported: { ...SUMMARY } })
  bootstrap.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  useUi.setState({ toast: originalToast })
})

describe('the session import row', () => {
  it('names what it reads before anything is chosen, and offers no import without a file', async () => {
    await mount()
    expect(text()).toContain(t('assistant.settings.import_sessions_hint'))
    // The action exists but cannot be taken: a press with no file would be a request for nothing.
    expect(importButton(), 'the import action is missing').toBeTruthy()
    expect(importButton()!.disabled).toBe(true)
    expect(status()).toBeNull()
    expect(alert()).toBeNull()
  })

  it('shows the file the reader picked, by name and by the size the ceiling is measured in', async () => {
    const body = '{"role":"user","content":"hi"}'
    await mount()
    await pickFile('chatgpt-log.jsonl', body)
    expect(text()).toContain(t('assistant.settings.sessions_picked', {
      name: 'chatgpt-log.jsonl',
      size: formatBytes(new TextEncoder().encode(body).byteLength),
    }))
    expect(importButton()!.disabled).toBe(false)
  })

  it('says it is reading while the request is out, rather than leaving a button that does nothing', async () => {
    let release: ((value: { imported: typeof SUMMARY }) => void) | null = null
    importSessionFile.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    await mount()
    await pickFile('slow.json', '{}')
    await act(async () => { importButton()!.click() })
    expect(text()).toContain(t('assistant.settings.sessions_running', { name: 'slow.json' }))
    expect(importButton()!.getAttribute('aria-busy')).toBe('true')
    // A running import is not a result: neither the empty answer nor a refusal has been earned yet.
    expect(status()).toBeNull()
    expect(alert()).toBeNull()
    await act(async () => { release?.({ imported: { ...SUMMARY } }) })
    expect(importButton()!.getAttribute('aria-busy')).not.toBe('true')
  })

  it('sends the file text with its name, and reports the counts the route wrote', async () => {
    await mount()
    await pickFile('thread.md', '**You:** hello')
    await act(async () => { importButton()!.click() })
    await settle()
    expect(importSessionFile).toHaveBeenCalledWith({ filename: 'thread.md', text: '**You:** hello' })
    expect(status(), 'the result is not on screen').toBeTruthy()
    expect(status()!.textContent).toContain(t('assistant.settings.sessions_result', { threads: 2, messages: 40 }))
    // The tab was re-read: an imported thread that does not appear in the list is an import a reader will
    // go and look for twice.
    expect(bootstrap).toHaveBeenCalledWith(true)
  })

  it('lists every reason the route gave, and counts the threads that were already here', async () => {
    importSessionFile.mockResolvedValueOnce({
      imported: {
        threads: 1,
        messages: 3,
        alreadyImported: 1,
        skipped: ['2 turns were a system or tool turn', '1 attachment id(s) the file named that are not files of this account were dropped'],
      },
    })
    await mount()
    await pickFile('again.json', '{}')
    await act(async () => { importButton()!.click() })
    await settle()
    expect(status()!.textContent).toContain(t('assistant.settings.sessions_already', { count: 1 }))
    expect(status()!.textContent).toContain(t('assistant.settings.sessions_skipped', { count: 2 }))
    // Both reasons are on screen, not merged into a number: the reader decides what to fix from the wording.
    const lines = [...(status()?.querySelectorAll('li') ?? [])].map((node) => node.textContent)
    expect(lines).toEqual([
      '2 turns were a system or tool turn',
      '1 attachment id(s) the file named that are not files of this account were dropped',
    ])
  })

  it('says so when the file brought nothing new, instead of claiming an import', async () => {
    importSessionFile.mockResolvedValueOnce({ imported: { threads: 0, messages: 0, alreadyImported: 1, skipped: [] } })
    await mount()
    await pickFile('again.json', '{}')
    await act(async () => { importButton()!.click() })
    await settle()
    expect(status()!.textContent).toContain(t('assistant.settings.import_nothing'))
    expect(status()!.textContent).not.toContain(t('assistant.settings.sessions_result', { threads: 0, messages: 0 }))
  })

  it('keeps the route\'s reason on screen when the file was refused, and asks again on retry', async () => {
    importSessionFile.mockRejectedValueOnce(new Error('the fetch died'))
    await mount()
    await pickFile('broken.json', '{')
    await act(async () => { importButton()!.click() })
    await settle()
    expect(alert(), 'the refusal is not named').toBeTruthy()
    expect(alert()!.textContent).toContain(t('assistant.settings.sessions_failed'))
    expect(status()).toBeNull()
    // A failure with no request behind it: nothing was written, so the tab is not re-read.
    expect(bootstrap).not.toHaveBeenCalled()

    const retry = buttons().find((node) => node.textContent?.trim() === t('common.retry'))
    expect(retry, 'the refusal offers no retry').toBeTruthy()
    importSessionFile.mockResolvedValueOnce({ imported: { ...SUMMARY } })
    await act(async () => { retry!.click() })
    await settle()
    expect(importSessionFile).toHaveBeenCalledTimes(2)
    expect(alert()).toBeNull()
    expect(status()!.textContent).toContain(t('assistant.settings.sessions_result', { threads: 2, messages: 40 }))
  })

  it('prints what the route said about the ceiling, not only that it failed', async () => {
    // Built from the module's own class, which this file's mock stands in for: the row only reads the
    // server's text off an `ApiError`, so a hand-rolled lookalike would prove nothing. The fifth argument
    // is the route's own sentence, and it is the only part of a refusal the row prints as a detail.
    importSessionFile.mockRejectedValueOnce(new ApiError(
      413,
      'payload_too_large',
      'too large',
      undefined,
      'That file is 6.2 MB of text, over the 4 MB a session import reads.',
    ))
    await mount()
    await pickFile('huge.json', '{}')
    await act(async () => { importButton()!.click() })
    await settle()
    // The number and the way down come from the server, and a row that hid them would leave the reader to
    // guess which file to go split.
    expect(alert()!.textContent).toContain('over the 4 MB a session import reads')
  })
})
