// @vitest-environment jsdom
/**
 * The rows a postpone button opens.
 *
 * Two things are worth pinning here: that every row states the day it will write, and that choosing one
 * writes that exact day and no other field. The overlay itself is the shared `Menu`'s business.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestGlobals } from '../../lib/test-render'
import { initI18n, t } from '../../lib/i18n'
import { EmojiTaskSerializer } from '../../lib/tasks/serializer/emoji'
import { defaultStatusRegistry } from '../../lib/tasks/line'
import { parseTaskLine, type Task } from '../../lib/tasks/model/task'
import { unknownPosition } from '../../lib/tasks/model/task-location'
import { editTaskInNote } from '../../lib/tasks/service'
import { openPostponeMenu } from './postpone-menu'
import { usePostponeMenu } from './postpone-store'

const cp = (...codes: number[]): string => String.fromCodePoint(...codes)
const DUE = cp(0x1F4C5)
const SCHEDULED = cp(0x23F3)
const NOW = new Date(2026, 9, 19, 12)

vi.mock('../../lib/tasks/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/tasks/service')>()
  return { ...actual, editTaskInNote: vi.fn(async () => 'written') }
})

function task(line: string): Task {
  const parsed = parseTaskLine(line, unknownPosition('n1', 'Inbox/Notes.md'), {
    registry: defaultStatusRegistry,
    serializer: new EmojiTaskSerializer(),
    now: NOW,
  })
  if (parsed === null) throw new Error(`test fixture is not a task line: ${line}`)
  return parsed
}

function rows(): Array<{ id: string; label: string; disabled?: boolean; checked?: boolean; onSelect?: () => void }> {
  const request = usePostponeMenu.getState().request
  if (request === null) throw new Error('no menu was asked for')
  return request.items
}

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.mocked(editTaskInNote).mockClear()
})

afterEach(() => {
  usePostponeMenu.getState().close()
  vi.useRealTimers()
})

describe('the rows a postpone button opens', () => {
  it('names the field it is about to move', () => {
    openPostponeMenu(task(`- [ ] pay rent ${DUE} 2026-10-22`), { x: 10, y: 20 })
    expect(rows()[0]).toMatchObject({
      label: t('tasks.postpone_for_field', { value0: t('tasks.field_due') }),
      disabled: true,
    })
  })

  it('states the day behind every phrase', () => {
    openPostponeMenu(task(`- [ ] pay rent ${DUE} 2026-10-22`), { x: 10, y: 20 })
    const labels = rows().map((row) => row.label)
    expect(labels).toContain(`${t('tasks.postpone_today')} · 2026-10-19`)
    expect(labels).toContain(`${t('tasks.postpone_tomorrow')} · 2026-10-20`)
    expect(labels).toContain(`${t('tasks.postpone_days', { value0: 2 })} · 2026-10-24`)
    expect(labels).toContain(`${t('tasks.postpone_week')} · 2026-10-29`)
    expect(labels).toContain(`${t('tasks.postpone_month')} · 2026-11-22`)
  })

  it('ticks the row that would change nothing', () => {
    openPostponeMenu(task(`- [ ] pay rent ${DUE} 2026-10-19`), { x: 10, y: 20 })
    const ticks = rows().filter((row) => row.checked).map((row) => row.label)
    expect(ticks).toEqual([`${t('tasks.postpone_today')} · 2026-10-19`])
  })

  it('writes the day the row showed, into that one field', () => {
    openPostponeMenu(task(`- [ ] pay rent ${DUE} 2026-10-22`), { x: 10, y: 20 })
    rows().find((row) => row.id === 'day2')?.onSelect?.()
    const call = vi.mocked(editTaskInNote).mock.calls[0]
    expect(call?.[0]).toBe('n1')
    expect(call?.[3].draft.dates.dueDate).toBe('2026-10-24')
    expect(call?.[3].draft.dates.scheduledDate).toBe('')
    expect(call?.[3].statusSymbol).toBe(' ')
  })

  it('takes the date out when the row says so', () => {
    openPostponeMenu(task(`- [ ] pay rent ${DUE} 2026-10-22`), { x: 10, y: 20 })
    rows().find((row) => row.id === 'remove')?.onSelect?.()
    expect(vi.mocked(editTaskInNote).mock.calls[0]?.[3].draft.dates.dueDate).toBe('')
  })

  it('refuses to offer removal of a date the note name supplied', () => {
    const inferred = parseTaskLine('- [ ] water the plants', { ...unknownPosition('n1', 'Notes.md'), lineNumber: 4 }, {
      registry: defaultStatusRegistry,
      serializer: new EmojiTaskSerializer(),
      now: NOW,
      fallbackDate: new Date(2026, 9, 10),
    })!
    openPostponeMenu(inferred, { x: 10, y: 20 })
    expect(rows().find((row) => row.id === 'remove')).toMatchObject({
      label: t('tasks.postpone_remove_blocked'),
      disabled: true,
    })
    // The inferred day is already past, so the offsets count from today — and the write moves the
    // scheduled field, which is the one the note name had been supplying.
    rows().find((row) => row.id === 'day2')?.onSelect?.()
    expect(vi.mocked(editTaskInNote).mock.calls[0]?.[3].draft.dates.scheduledDate).toBe('2026-10-21')
  })

  it('counts from today for a date that is already past', () => {
    openPostponeMenu(task(`- [ ] pay rent ${SCHEDULED} 2026-09-30`), { x: 10, y: 20 })
    expect(rows().map((row) => row.label)).toContain(`${t('tasks.postpone_days', { value0: 2 })} · 2026-10-21`)
  })
})
