// @vitest-environment jsdom
/**
 * The rows a "remind me again" menu offers.
 *
 * The four presets are a shortcut and the fifth row is the same question with the reader's own answer,
 * so what matters is that the typed length reaches the same callback the presets use — and that a
 * cancel or a number outside the route's range writes nothing. The dialog itself is the shared prompt,
 * mocked here: this file is about what the menu does with an answer, not about the dialog's markup.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { MAX_SNOOZE_MINUTES, MIN_SNOOZE_MINUTES, SNOOZE_MINUTES } from '@shared/todos/model'
import { useUi } from '../../store/ui'

const dialog = vi.hoisted(() => ({ answer: null as string | null }))

vi.mock('../../components/overlay', () => ({
  prompt: async () => dialog.answer,
  confirm: async () => false,
  MenuSubmenuList: () => null,
}))

import { buildSnoozeMenuItems } from './task-menu'

beforeEach(async () => {
  await initI18n()
  dialog.answer = null
  useUi.setState({ toasts: [] })
})

describe('the snooze rows', () => {
  it('offers the four presets and one typed length', () => {
    const rows = buildSnoozeMenuItems(() => {})
    expect(rows.map((row) => row.id)).toEqual([...SNOOZE_MINUTES.map((minutes) => `snooze-${minutes}`), 'snooze-custom'])
  })

  it('answers a preset with its own duration', () => {
    const picked: number[] = []
    const rows = buildSnoozeMenuItems((minutes) => { picked.push(minutes) })
    rows[0]!.onSelect!()
    expect(picked).toEqual([SNOOZE_MINUTES[0]])
  })

  it('sends the length the reader typed', async () => {
    dialog.answer = '45'
    const picked: number[] = []
    const rows = buildSnoozeMenuItems((minutes) => { picked.push(minutes) })
    rows.at(-1)!.onSelect!()
    await vi.waitFor(() => expect(picked).toEqual([45]))
    expect(useUi.getState().toasts).toHaveLength(0)
  })

  it('writes nothing when the dialog is cancelled', async () => {
    dialog.answer = null
    const picked: number[] = []
    const rows = buildSnoozeMenuItems((minutes) => { picked.push(minutes) })
    rows.at(-1)!.onSelect!()
    await vi.waitFor(() => expect(useUi.getState().toasts).toHaveLength(0))
    expect(picked).toEqual([])
  })

  it('refuses a length outside the route’s range, and says why', async () => {
    dialog.answer = '0'
    const picked: number[] = []
    const rows = buildSnoozeMenuItems((minutes) => { picked.push(minutes) })
    rows.at(-1)!.onSelect!()
    await vi.waitFor(() => expect(useUi.getState().toasts).toHaveLength(1))
    expect(useUi.getState().toasts[0]!.title)
      .toBe(t('todo.snooze.custom_invalid', { min: MIN_SNOOZE_MINUTES, max: MAX_SNOOZE_MINUTES }))
    expect(picked).toEqual([])
  })
})
