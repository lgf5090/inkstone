/**
 * The reference panel as a surface: what it lists, what a search leaves, and what a profile takes away.
 *
 * The table itself is proved in `lib/templater/reference/registry.test.ts` — every entry has a signature, a
 * description and an example, and the flags match what the engine actually does. What could only be proved
 * here is the reading of it: that a row opens, that the opened row says the same words the completion popup
 * says, and that switching to "a template from the gallery" is visible rather than implied.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { preloadPinyin } from '../../lib/pinyin'
import { findReferenceEntry } from '../../lib/templater/reference/registry'
import { TemplateReference } from './reference-panel'

let root: Root
let container: HTMLDivElement

async function render() {
  await act(async () => {
    root.render(createElement(TemplateReference, { open: true, onClose: () => {} }))
    await Promise.resolve()
  })
}

function row(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
    .find((node) => node.textContent?.includes(name))
  if (!match) throw new Error(`no reference row for ${name}`)
  return match
}

async function typeFilter(value: string) {
  const box = document.querySelector<HTMLInputElement>('div[role="dialog"] input')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(box, value)
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

async function chooseProfile(label: string) {
  const radio = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((node) => node.textContent?.includes(label))
  if (!radio) throw new Error(`no profile choice labelled ${label}`)
  await act(async () => {
    radio.click()
    await Promise.resolve()
  })
}

beforeAll(async () => {
  await initI18n()
  await preloadPinyin()
})

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('the list', () => {
  it('shows the documented functions grouped under their module', async () => {
    await render()
    const sections = [...document.querySelectorAll('section')]
    expect(sections.length).toBeGreaterThan(3)
    expect(sections.map((node) => node.getAttribute('aria-label'))).toContain('tp.file')
    expect(row('tp.file.rename')).toBeTruthy()
    expect(row('tp.date.now')).toBeTruthy()
  })

  it('narrows to what the reader typed and says how much is left', async () => {
    await render()
    await typeFilter('rename')
    expect(document.body.textContent).toContain(t('templater.ref.matches', { value0: '1' }))
    expect([...document.querySelectorAll('button[aria-expanded]')]).toHaveLength(1)
    await typeFilter('nothingresemblesthis')
    expect(document.body.textContent).toContain(t('templater.ref.none'))
  })
})

describe('one function, opened', () => {
  it('says the call, the parameters, the return and the example', async () => {
    await render()
    const entry = findReferenceEntry('date', 'now')!
    const trigger = row('tp.date.now')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      trigger.click()
      await Promise.resolve()
    })
    // `getElementById`, not a selector: the id carries the dotted function name, which a CSS selector would
    // read as a class.
    const region = document.getElementById(trigger.getAttribute('aria-controls')!)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(region!.textContent).toContain(entry.signature)
    expect(region!.textContent).toContain(t(entry.descriptionKey))
    for (const arg of entry.args) expect(region!.textContent, arg.name).toContain(t(arg.descriptionKey))
    expect(region!.textContent).toContain(t(entry.returnsKey!))
    expect(region!.querySelector('pre')).not.toBeNull()
  })

  it('tells the reader when a module’s list is not a closed one', async () => {
    await render()
    await act(async () => {
      row('tp.obsidian').click()
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain(t('templater.ref.open_ended'))
  })
})

describe('which run the reader is looking at', () => {
  it('marks the functions a gallery template may not reach, and names the reason', async () => {
    await render()
    expect(row('tp.file.rename').textContent).not.toContain(t('templater.ref.blocked'))
    await chooseProfile(t('templater.ref.profile_community'))
    const blocked = row('tp.file.rename')
    expect(blocked.textContent).toContain(t('templater.ref.blocked'))
    await act(async () => {
      blocked.click()
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain(t('templater.ref.blocked_reason', { value0: t('templater.error.capability_blocked') }))
  })

  it('keeps the reader’s own scripts out of the gallery list and in the reader’s own', async () => {
    await render()
    await chooseProfile(t('templater.ref.profile_community'))
    expect(row('tp.web.request').textContent).toContain(t('templater.ref.blocked'))
    await chooseProfile(t('templater.ref.profile_local'))
    expect(row('tp.web.request').textContent).not.toContain(t('templater.ref.blocked'))
  })
})
