// @vitest-environment jsdom
/**
 * The insights drawer has to answer three different things with three different surfaces: a read in
 * flight, a read that failed, and a read that legitimately came back empty. A failed read used to leave
 * the log tab spinning forever and the statistics tab completely blank, which reads as "no data" rather
 * than "no answer".
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantProvider } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { api } from '../../lib/api'
import { KeyInsights } from './KeyInsights'

const PROVIDER: AssistantProvider = {
  id: 'p1', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', endpoints: {},
  hasKey: true, icon: '', keyHint: 'abcd', keyLastUsedAt: null, reasoningDialect: null, sticky: false, createdAt: 1, updatedAt: 1,
}

let rendered: RenderedElement | null = null

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  vi.spyOn(api.assistant, 'keyStats').mockRejectedValue(new Error('offline'))
  vi.spyOn(api.assistant, 'requestLogs').mockRejectedValue(new Error('offline'))
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('the insights drawer when a read fails', () => {
  it('names the failure and offers a retry instead of spinning forever', async () => {
    await act(async () => {
      rendered = renderElement(createElement(KeyInsights, {
        open: true, onClose: () => undefined, provider: PROVIDER,
      }))
      // The rejected read settles in a microtask after the first render; let it land inside act.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain(t('assistant.insights.load_failed'))
    expect(document.body.textContent).toContain(t('common.retry'))
    expect(document.body.querySelector('[role="alert"]')).toBeTruthy()
  })
})
