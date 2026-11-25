// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { Inspector } from './Inspector'

const shares = vi.hoisted(() => vi.fn())

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    clouddriveApi: { ...actual.clouddriveApi, shares },
  }
})

const entry: CloudDriveEntry = {
  id: 'file-1',
  kind: 'file',
  name: 'report.txt',
  path: '/report.txt',
  mountId: 'primary',
  mountName: 'Drive',
  category: 'txt',
  mime: 'text/plain',
  size: 12,
  uploadedAt: 1,
  modifiedAt: 2,
  starredAt: null,
  readOnly: true,
  hasThumbnail: false,
  storage: 'r2',
  storageKind: 'r2',
  color: null,
  tags: [],
}

let view: RenderedElement | null = null
const originalWidth = window.innerWidth

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  })
}

function Harness() {
  const [open, setOpen] = useState(false)
  return createElement('div', null,
    createElement('button', { type: 'button', onClick: () => setOpen(true) }, 'Open inspector'),
    createElement(Inspector, {
      open,
      entries: [entry],
      readOnly: false,
      busy: false,
      onClose: () => setOpen(false),
      onOpen: () => undefined,
      onShare: () => undefined,
      onColor: () => undefined,
      onAddTag: () => undefined,
      onRemoveTag: () => undefined,
      onSaveMeta: () => undefined,
    }),
  )
}

beforeEach(async () => {
  await initI18n()
  shares.mockReset().mockResolvedValue({ shares: [] })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
})

describe('the mobile Inspector drawer', () => {
  it('is a named dialog, traps Tab and returns focus after Escape', async () => {
    view = renderElement(createElement(Harness))
    const trigger = view.container.querySelector<HTMLButtonElement>('button')!
    act(() => { trigger.focus(); trigger.click() })
    await settle()

    const panel = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(panel).not.toBeNull()
    expect(panel?.getAttribute('aria-modal')).toBe('true')
    expect(panel?.getAttribute('aria-labelledby')).toBeTruthy()
    expect(document.getElementById(panel!.getAttribute('aria-labelledby')!)?.textContent).toBe(t('clouddrive.inspector.title'))

    const controls = [...panel!.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
    expect(controls.length).toBeGreaterThan(1)
    expect(document.activeElement).toBe(controls[0])
    act(() => {
      controls[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    })
    expect(document.activeElement).toBe(controls.at(-1))

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
