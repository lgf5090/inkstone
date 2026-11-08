// @vitest-environment jsdom
/**
 * The token list and the activity feed: the two places the deployed walkthrough saw raw values.
 *
 * A revoked token kept its "Revoke" button and showed no scopes; the activity feed printed
 * `token.revoked` twice and never said what happened in Chinese.
 */
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { EventList, TokenRow } from '../src/client/features/development/certhub/CerthubApp'
import { CERTHUB_EVENT_KINDS, eventKindKey } from '../src/shared/development/certhub/events'
import { ZH_CN_DEVELOPMENT_CERTHUB } from '../src/shared/locales/zh-CN-development-certhub'
import { EN_US_DEVELOPMENT_CERTHUB } from '../src/shared/locales/en-US-development-certhub'
import type { CerthubEventView, CerthubTokenView } from '../src/shared/development/certhub/types'

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

function token(overrides: Partial<CerthubTokenView> = {}): CerthubTokenView {
  return {
    id: 'token-1',
    name: 'deployed-walkthrough',
    prefix: 'cert_abc',
    scopes: ['read', 'issue'],
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

function event(overrides: Partial<CerthubEventView> = {}): CerthubEventView {
  return {
    id: 'event-1',
    orderId: 'order-1',
    domainId: '',
    actor: 'user',
    kind: 'cert.issued',
    level: 'info',
    messageCode: 'cert.issued',
    detail: {},
    createdAt: Date.now() - 60_000,
    ...overrides,
  }
}

describe('TokenRow', () => {
  it('lists the token scopes by name', () => {
    rendered = renderElement(createElement(TokenRow, { token: token(), onRevoke: () => undefined }))
    expect(rendered.container.textContent).toContain(t('development.certhub.scope.read'))
    expect(rendered.container.textContent).toContain(t('development.certhub.scope.issue'))
    expect(rendered.container.textContent).not.toContain('development.certhub.scope.')
  })

  it('offers revoke on a live token', () => {
    rendered = renderElement(createElement(TokenRow, { token: token(), onRevoke: () => undefined }))
    const revoke = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === t('development.certhub.settings.token_revoke'))
    expect(revoke).toBeTruthy()
  })

  it('offers rotate only when a handler is supplied', () => {
    rendered = renderElement(createElement(TokenRow, { token: token(), onRevoke: () => undefined, onRotate: () => undefined }))
    const rotate = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === t('development.certhub.settings.token_rotate'))
    expect(rotate).toBeTruthy()
    rendered.unmount()
    rendered = renderElement(createElement(TokenRow, { token: token(), onRevoke: () => undefined }))
    const missing = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === t('development.certhub.settings.token_rotate'))
    expect(missing).toBeUndefined()
  })

  it('greys out a revoked token, hides revoke and prints when it was revoked', () => {
    const revokedAt = Date.UTC(2026, 10, 8, 4, 30)
    rendered = renderElement(createElement(TokenRow, { token: token({ revokedAt }), onRevoke: () => undefined }))
    const revoke = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === t('development.certhub.settings.token_revoke'))
    expect(revoke).toBeUndefined()
    expect(rendered.container.textContent).toContain(t('development.certhub.settings.token_revoked_at', { time: new Date(revokedAt).toLocaleString() }))
    expect(rendered.container.firstElementChild?.className).toContain('opacity-60')
  })
})

describe('EventList', () => {
  it('names the action in the reader language and never prints the raw kind', () => {
    rendered = renderElement(createElement(EventList, {
      events: [
        event({ id: 'e1', kind: 'cert.issued' }),
        event({ id: 'e2', kind: 'token.revoked' }),
        event({ id: 'e3', kind: 'future.unknown' }),
      ],
    }))
    const text = rendered.container.textContent ?? ''
    expect(text).toContain(t('development.certhub.event.cert.issued'))
    expect(text).toContain(t('development.certhub.event.token.revoked'))
    expect(text).not.toContain('cert.issued')
    expect(text).not.toContain('token.revoked')
    expect(text).not.toContain('future.unknown')
    expect(text).toContain(t('development.certhub.event.other'))
  })

  it('shows a relative time and keeps the absolute one in the title', () => {
    const createdAt = Date.now() - 90 * 60_000
    rendered = renderElement(createElement(EventList, { events: [event({ createdAt })] }))
    const time = rendered.container.querySelector('time')
    expect(time?.getAttribute('datetime')).toBe(new Date(createdAt).toISOString())
    expect(time?.getAttribute('title')).toBe(new Date(createdAt).toLocaleString())
  })

  it('shows the object a challenge event is about', () => {
    rendered = renderElement(createElement(EventList, {
      events: [event({ kind: 'challenge.pending_dns', messageCode: 'challenge.pending_dns', detail: { name: '_acme-challenge.example.com', type: 'TXT' } })],
    }))
    expect(rendered.container.textContent).toContain('_acme-challenge.example.com')
  })
})

describe('event catalog', () => {
  it('has a label in both languages for every kind the worker writes', () => {
    for (const kind of CERTHUB_EVENT_KINDS) {
      const key = eventKindKey(kind) as keyof typeof EN_US_DEVELOPMENT_CERTHUB
      expect(EN_US_DEVELOPMENT_CERTHUB[key], key).toBeTruthy()
      expect(ZH_CN_DEVELOPMENT_CERTHUB[key], key).toBeTruthy()
    }
  })
})
