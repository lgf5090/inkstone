import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NEW_NOTE_TEMPLATE, DEFAULT_SETTINGS } from '@shared/constants'
import { initI18n, t } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { NotesSettings } from './NotesSettings'

const confirmMock = vi.hoisted(() => vi.fn(async () => true))

vi.mock('../../components/overlay', async (original) => ({
  ...(await original<typeof import('../../components/overlay')>()),
  confirm: confirmMock,
}))

let root: Root
let container: HTMLDivElement
const initial = useSession.getState()
let updates: Array<Record<string, unknown>> = []

function templateOf(patch: Record<string, unknown>): string {
  return (patch.notes as { newNoteTemplate: string }).newNoteTemplate
}

async function render() {
  await act(async () => {
    root.render(createElement(NotesSettings))
    await Promise.resolve()
  })
}

beforeEach(async () => {
  localStorage.clear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  updates = []
  confirmMock.mockReset()
  confirmMock.mockResolvedValue(true)
  Element.prototype.scrollIntoView = vi.fn()
  await initI18n()
  useSession.setState({
    settings: { ...DEFAULT_SETTINGS, notes: { ...DEFAULT_SETTINGS.notes, newNoteTemplate: 'Hello {{title}}' } },
    updateSettings: (patch: Record<string, unknown>) => {
      updates.push(patch)
      return Promise.resolve()
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await render()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  useSession.setState(initial)
})

function field(): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>('textarea')!
}

function chip(token: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === token)
  if (!match) throw new Error(`no chip for ${token}`)
  return match
}

describe('the new-note template editor', () => {
  it('inserts a placeholder at the caret and moves the caret past it', () => {
    const area = field()
    area.focus()
    area.setSelectionRange(6, 6)
    act(() => {
      chip('{{date}}').click()
    })
    expect(updates).toHaveLength(1)
    expect(templateOf(updates[0]!)).toBe('Hello {{date}}{{title}}')
  })

  it('replaces the selected range with the placeholder', () => {
    const area = field()
    area.focus()
    area.setSelectionRange(6, 15)
    act(() => {
      chip('{{title}}').click()
    })
    expect(templateOf(updates[0]!)).toBe('Hello {{title}}')
  })

  it('refuses to grow the template past the ceiling the field already has', () => {
    const huge = 'x'.repeat(4096)
    useSession.setState({
      settings: { ...DEFAULT_SETTINGS, notes: { ...DEFAULT_SETTINGS.notes, newNoteTemplate: huge } },
      updateSettings: (patch: Record<string, unknown>) => {
        updates.push(patch)
        return Promise.resolve()
      },
    })
    updates = []
    container.remove()
    document.body.append(container)
    root = createRoot(container)
    return render().then(() => {
      const area = field()
      area.focus()
      area.setSelectionRange(0, 0)
      act(() => {
        chip('{{date}}').click()
      })
      expect(updates).toHaveLength(0)
    })
  })

  it('asks before overwriting the template with the shipped default', async () => {
    confirmMock.mockResolvedValueOnce(false)
    const restore = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === t('settings.restore_default_template'))!
    await act(async () => {
      restore.click()
      await Promise.resolve()
    })
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(updates).toHaveLength(0)
  })

  it('restores the default only once the user says yes', async () => {
    const restore = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === t('settings.restore_default_template'))!
    await act(async () => {
      restore.click()
      await Promise.resolve()
    })
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(updates).toHaveLength(1)
    expect(templateOf(updates[0]!)).toBe(DEFAULT_NEW_NOTE_TEMPLATE)
  })
})
