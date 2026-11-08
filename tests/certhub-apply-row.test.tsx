// @vitest-environment jsdom
/**
 * The request form's two visible bugs: a checkbox that printed its label twice, and a wildcard row
 * that still offered HTTP-01 even though the CA refuses it.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { ApplyDomainRow, viewForPath } from '../src/client/features/development/certhub/CerthubApp'
import type { CerthubDnsProviderView } from '../src/shared/development/certhub/types'

let rendered: RenderedElement | null = null

beforeEach(async () => {
  installTestGlobals()
  localStorage.clear()
  await initI18n()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function row(overrides: Partial<{ name: string; wildcard: boolean; primary: boolean; challengeMode: 'dns-01' | 'http-01'; dnsProviderId: string }> = {}) {
  return { id: 'row-1', name: '', wildcard: false, primary: true, challengeMode: 'dns-01' as const, dnsProviderId: '', ...overrides }
}

function renderRow(input: ReturnType<typeof row>, onChange: (patch: Partial<ReturnType<typeof row>>) => void = () => undefined) {
  const providers: CerthubDnsProviderView[] = []
  return renderElement(createElement(ApplyDomainRow, { row: input, providers, onChange, onPrimary: () => undefined }))
}

function countText(scope: HTMLElement, text: string): number {
  return (scope.textContent ?? '').split(text).length - 1
}

describe('ApplyDomainRow', () => {
  it('prints each checkbox label exactly once', () => {
    rendered = renderRow(row())
    expect(countText(rendered.container, t('development.certhub.apply.wildcard'))).toBe(1)
    expect(countText(rendered.container, t('development.certhub.apply.primary'))).toBe(1)
  })

  it('names each checkbox once for assistive technology too', () => {
    rendered = renderRow(row())
    const boxes = [...rendered.container.querySelectorAll<HTMLElement>('[role="checkbox"]')]
    expect(boxes).toHaveLength(2)
    // The accessible name is the button's own content: a wrapping `<label>` would add a second copy
    // outside the control and leave the name unchanged, which is what made this hard to notice.
    expect(boxes[0]?.textContent).toBe(t('development.certhub.apply.wildcard'))
    expect(boxes[1]?.textContent).toBe(t('development.certhub.apply.primary'))
  })

  it('removes a domain row only when the form can spare one', () => {
    rendered = renderRow(row())
    const labelled = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.getAttribute('aria-label') === t('development.certhub.apply.remove_domain'))
    expect(labelled).toBeUndefined()

    let removed = false
    rendered.rerender(createElement(ApplyDomainRow, {
      row: row(),
      providers: [],
      onChange: () => undefined,
      onPrimary: () => undefined,
      onRemove: () => { removed = true },
    }))
    const withRemove = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.getAttribute('aria-label') === t('development.certhub.apply.remove_domain'))
    expect(withRemove).toBeTruthy()
    act(() => { withRemove?.click() })
    expect(removed).toBe(true)
  })

  it('switches the wildcard row to DNS-01 and explains why', async () => {
    const changes: unknown[] = []
    rendered = renderRow(row(), (patch) => changes.push(patch))
    const wildcard = [...rendered.container.querySelectorAll<HTMLElement>('[role="checkbox"]')][0]!
    act(() => { wildcard.click() })
    expect(changes).toEqual([{ wildcard: true, challengeMode: 'dns-01' }])

    rendered.rerender(createElement(ApplyDomainRow, {
      row: row({ wildcard: true }),
      providers: [],
      onChange: () => undefined,
      onPrimary: () => undefined,
    }))
    expect(rendered.container.textContent).toContain(t('development.certhub.apply.wildcard_dns_only'))
  })

  it('disables the HTTP-01 choice once the row is a wildcard', () => {
    rendered = renderRow(row({ wildcard: true }))
    const trigger = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.getAttribute('aria-label') === t('development.certhub.apply.challenge'))!
    act(() => { trigger.click() })
    const http = [...document.body.querySelectorAll<HTMLButtonElement>('button[role="menuitemcheckbox"]')]
      .find((button) => button.textContent === t('development.certhub.apply.http_manual'))
    expect(http).toBeTruthy()
    expect(http!.disabled).toBe(true)
    const dns = [...document.body.querySelectorAll<HTMLButtonElement>('button[role="menuitemcheckbox"]')]
      .find((button) => button.textContent === t('development.certhub.apply.dns_manual'))
    expect(dns!.disabled).toBe(false)
  })
})

describe('viewForPath', () => {
  it('sends /apply into the request wizard, not the overview', () => {
    expect(viewForPath('/development/certhub/apply')).toEqual({ view: 'apply', id: '' })
    expect(viewForPath('/development/certhub/new')).toEqual({ view: 'apply', id: '' })
    expect(viewForPath('/development/certhub')).toEqual({ view: 'overview', id: '' })
    expect(viewForPath('/development/certhub/certificates/order-1')).toEqual({ view: 'detail', id: 'order-1' })
  })
})
