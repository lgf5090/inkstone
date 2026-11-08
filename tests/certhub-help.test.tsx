// @vitest-environment jsdom
/**
 * The per-page guide: every topic has to speak both languages, and the drawer has to move between
 * topics and close again. A missing key would otherwise print `development.certhub.help.…` at a
 * reader, which is the failure this module exists to prevent.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, initI18nForReading, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { HELP_TOPIC_ORDER, HelpButton, buildTopic } from '../src/client/features/development/certhub/help'

let rendered: RenderedElement | null = null

beforeEach(async () => {
  installTestGlobals()
  localStorage.clear()
  await initI18n()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.querySelectorAll('[role="dialog"]').forEach((node) => node.remove())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('help content', () => {
  it('resolves every section in both languages, never printing a raw key', async () => {
    const english = HELP_TOPIC_ORDER.map((topic) => buildTopic(topic))
    for (const content of english) {
      expect(content.intro).not.toContain('development.certhub.')
      expect(content.intro.length).toBeGreaterThan(0)
      for (const section of content.sections) {
        expect(section.title).not.toContain('development.certhub.')
        if (section.body) expect(section.body).not.toContain('development.certhub.')
        for (const step of section.steps ?? []) expect(step).not.toContain('development.certhub.')
        for (const link of section.links ?? []) {
          expect(link.label).not.toContain('development.certhub.')
          expect(link.href.startsWith('https://')).toBe(true)
        }
      }
    }

    await initI18nForReading('zh-CN')
    const chinese = HELP_TOPIC_ORDER.map((topic) => buildTopic(topic))
    chinese.forEach((content, index) => {
      expect(content.intro).not.toBe(english[index]!.intro)
      content.sections.forEach((section) => {
        expect(section.title.length).toBeGreaterThan(0)
        expect(section.title).not.toContain('development.certhub.')
      })
    })
    await initI18nForReading('en-US')
  })

  it('explains the request flow with the full sequence and official links', () => {
    const apply = buildTopic('apply')
    const flow = apply.sections.find((section) => section.steps?.length === 7)
    expect(flow).toBeTruthy()
    const links = apply.sections.flatMap((section) => section.links ?? [])
    expect(links.map((link) => link.href)).toEqual(expect.arrayContaining([
      'https://letsencrypt.org/docs/rate-limits/',
      'https://letsencrypt.org/docs/staging-environment/',
      'https://zerossl.com/documentation/acme/',
      'https://pki.goog/faq/',
    ]))
  })
})

describe('HelpButton', () => {
  it('opens the drawer for the current page and walks to the next topic', () => {
    rendered = renderElement(createElement(HelpButton, { topic: 'apply' }))
    const trigger = rendered.container.querySelector<HTMLButtonElement>('button')
    expect(trigger?.getAttribute('aria-label')).toBe(t('development.certhub.help.open'))
    act(() => { trigger?.click() })
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain(t('development.certhub.help.apply.flow_title'))

    const next = [...dialog!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === t('development.certhub.help.next'))
    act(() => { next?.click() })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(t('development.certhub.help.accounts.create_title'))
  })

  it('closes on Escape', () => {
    rendered = renderElement(createElement(HelpButton, { topic: 'overview' }))
    act(() => { rendered!.container.querySelector<HTMLButtonElement>('button')?.click() })
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
