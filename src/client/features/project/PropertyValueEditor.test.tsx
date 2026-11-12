/**
 * The date cell has to agree with the module's own conversion (§6.6) in the reader's own zone: the day
 * the picker files is the day the table cell, the date filter and the timeline read back. The editor
 * once did its own UTC arithmetic, which filed local midnight and read back a day early east of UTC.
 *
 * The zone is switched per case rather than assumed, because the defect is invisible in UTC — the
 * machine's own zone is not a fixture.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProjectCard, ProjectProperty } from '@shared/project/model'
import { parseProjectDateValue, projectDayToStamp, projectStampToInput } from '@shared/project/date'
import { projectPropertyDisplayText } from '@shared/project/view-eval'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { PropertyValueEditor } from './PropertyValueEditor'

let session: { user: { id: string, name: string, avatarUrl: string } | null } = { user: null }
vi.mock('../../store/session', () => ({
  useSession: (selector: (state: typeof session) => unknown) => selector(session),
}))

const property: ProjectProperty = { id: 'pd', name: 'Due', type: 'date', options: [] }
const ZONES = ['UTC', 'Asia/Shanghai', 'Pacific/Auckland', 'America/New_York'] as const
const originalTZ = process.env.TZ

let view: RenderedElement
beforeAll(async () => { installTestGlobals(); await initI18n() })
afterEach(() => {
  view?.unmount()
  session.user = null
  if (originalTZ === undefined) delete process.env.TZ
  else process.env.TZ = originalTZ
})

async function pickDay(value: string, day: string): Promise<string | null> {
  const onChange = vi.fn()
  await act(async () => { view = renderElement(createElement(PropertyValueEditor, { property, value, members: [], disabled: false, onChange })) })
  await act(async () => { view.container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.click() })
  const panel = view.container.querySelector('[role="dialog"]')
  expect(panel, 'the picker never opened').not.toBeNull()
  const cell = [...panel!.querySelectorAll<HTMLButtonElement>('div.grid button')].find((button) => button.textContent === day)
  expect(cell, `no day cell reading ${day}`).toBeDefined()
  await act(async () => { cell!.click() })
  expect(onChange, 'pressing a day filed nothing').toHaveBeenCalledTimes(1)
  return onChange.mock.calls[0]![0] as string | null
}

function readBack(raw: string): string {
  const parsed = parseProjectDateValue(raw)!
  return projectStampToInput(parsed.from!, parsed.includeTime === true)
}

describe.each(ZONES)('the date cell in %s', (zone) => {
  it('files the pressed day so every other reader reads the same day back', async () => {
    process.env.TZ = zone
    const start = JSON.stringify({ from: projectDayToStamp(new Date(2026, 10, 10)) })
    const filed = await pickDay(start, '15')
    expect(filed).not.toBeNull()
    expect(readBack(filed!)).toBe('2026-11-15')
  })

  it('shows the day the shared writer filed, not a UTC-shifted one', async () => {
    process.env.TZ = zone
    const value = JSON.stringify({ from: projectDayToStamp(new Date(2026, 10, 10)) })
    await act(async () => { view = renderElement(createElement(PropertyValueEditor, { property, value, members: [], disabled: false, onChange: vi.fn() })) })
    const trigger = view.container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!
    expect(trigger.textContent).toContain('2026-11-10')
    expect(readBack(value)).toBe('2026-11-10')
  })

  it('shows the local day of an includeTime instant, not its UTC day', async () => {
    process.env.TZ = zone
    // 01:00 local on the 10th. East of UTC this instant is still the 9th in UTC, which is the day a
    // UTC-based reader would wrongly show; west of UTC both readings agree, so the zone matrix matters.
    const value = JSON.stringify({ from: new Date(2026, 10, 10, 1, 0, 0, 0).getTime(), includeTime: true })
    await act(async () => { view = renderElement(createElement(PropertyValueEditor, { property, value, members: [], disabled: false, onChange: vi.fn() })) })
    const trigger = view.container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!
    expect(trigger.textContent).toContain('2026-11-10')
  })
})
describe('moving a start day keeps the rest of the value', () => {
  it('carries `to` the same distance instead of collapsing the range', async () => {
    process.env.TZ = 'Asia/Shanghai'
    const from = projectDayToStamp(new Date(2026, 10, 10))
    const to = projectDayToStamp(new Date(2026, 10, 13))
    const filed = await pickDay(JSON.stringify({ from, to }), '15')
    const parsed = parseProjectDateValue(filed!)!
    expect(projectStampToInput(parsed.from!)).toBe('2026-11-15')
    expect(projectStampToInput(parsed.to!)).toBe('2026-11-18')
    expect(parsed.to! - parsed.from!).toBe(to - from)
  })

  it('keeps includeTime and timeZone, which decide how every reader converts', async () => {
    process.env.TZ = 'Asia/Shanghai'
    const from = projectDayToStamp(new Date(2026, 10, 10), true)
    const filed = await pickDay(JSON.stringify({ from, includeTime: true, timeZone: 'Asia/Shanghai' }), '15')
    const parsed = parseProjectDateValue(filed!)!
    expect(parsed.includeTime).toBe(true)
    expect(parsed.timeZone).toBe('Asia/Shanghai')
    expect(projectStampToInput(parsed.from!, true)).toBe('2026-11-15')
  })

  it('clears the value when the picker is cleared', async () => {
    process.env.TZ = 'UTC'
    const value = JSON.stringify({ from: projectDayToStamp(new Date(2026, 10, 10)) })
    const onChange = vi.fn()
    await act(async () => { view = renderElement(createElement(PropertyValueEditor, { property, value, members: [], disabled: false, onChange })) })
    const clear = view.container.querySelector<HTMLButtonElement>(`[aria-label="${t('preview.kanban_clear_date')}"]`)
    expect(clear, 'no clear affordance').not.toBeNull()
    await act(async () => { clear!.click() })
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('offers no clear affordance and files nothing when the value is empty', async () => {
    process.env.TZ = 'UTC'
    const onChange = vi.fn()
    await act(async () => { view = renderElement(createElement(PropertyValueEditor, { property, value: '', members: [], disabled: false, onChange })) })
    expect(view.container.querySelector(`[aria-label="${t('preview.kanban_clear_date')}"]`)).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
})

/** The table cell's own display path — the consumer that disagreed with the editor. */
function tableText(raw: string): string {
  const card: ProjectCard = { id: 'c1', boardId: 'b1', parentId: '', title: 'Task', icon: '', isTemplate: false, contentOrder: [], values: { pd: raw }, createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
  return projectPropertyDisplayText(card, property)
}

describe('the editor and the table cell agree', () => {
  it('displays the filed day exactly as the canonical writer would', async () => {
    for (const zone of ZONES) {
      process.env.TZ = zone
      const start = JSON.stringify({ from: projectDayToStamp(new Date(2026, 10, 10)) })
      const filed = await pickDay(start, '15')
      const canonical = JSON.stringify({ from: projectDayToStamp(new Date(2026, 10, 15)) })
      expect(tableText(filed!), `editor and table disagree in ${zone}`).toBe(tableText(canonical))
      view.unmount()
    }
  })
})

describe('the property kinds that had no editor (R3-10)', () => {
  const members = [{ boardId: 'b1', userId: 'alice', role: 'admin' as const, createdAt: 1, updatedAt: 1 }, { boardId: 'b1', userId: 'bob', role: 'editor' as const, createdAt: 1, updatedAt: 1 }]

  it('offers a checkbox per member for multiPerson and files the picked ids as an array', async () => {
    const onChange = vi.fn()
    const many: ProjectProperty = { id: 'pm', name: 'Owners', type: 'multiPerson', options: [] }
    await act(async () => { view = renderElement(createElement(PropertyValueEditor, { property: many, value: '["alice"]', members, disabled: false, onChange })) })
    const boxes = [...view.container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
    expect(boxes).toHaveLength(2)
    expect(boxes[0]!.getAttribute('aria-checked')).toBe('true')
    expect(boxes[1]!.getAttribute('aria-checked')).toBe('false')
    expect(view.container.querySelector('input[type="text"]')).toBeNull()
    await act(async () => { boxes[1]!.click() })
    expect(onChange).toHaveBeenCalledWith('["alice","bob"]')
  })

  it('clears a multiPerson value when the last member is unchecked', async () => {
    const onChange = vi.fn()
    const many: ProjectProperty = { id: 'pm', name: 'Owners', type: 'multiPerson', options: [] }
    await act(async () => { view = renderElement(createElement(PropertyValueEditor, { property: many, value: '["alice"]', members, disabled: false, onChange })) })
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click() })
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('reads the four server-stamped kinds off the card instead of always showing a dash', async () => {
    const card: ProjectCard = { id: 'c1', boardId: 'b1', parentId: '', title: 'T', icon: '', isTemplate: false, contentOrder: [], values: {}, createdBy: 'alice', modifiedBy: 'bob', createAt: Date.UTC(2026, 10, 10, 12), updateAt: Date.UTC(2026, 10, 11, 12), deleteAt: 0 }
    for (const [type, expected] of [['createdBy', 'alice'], ['updatedBy', 'bob']] as const) {
      const stamped: ProjectProperty = { id: `p_${type}`, name: type, type, options: [] }
      await act(async () => { view = renderElement(createElement(PropertyValueEditor, { property: stamped, value: '', members: [], disabled: true, onChange: vi.fn(), card })) })
      expect(view.container.textContent).toBe(expected)
      view.unmount()
    }
    const created: ProjectProperty = { id: 'pct', name: 'Created', type: 'createdTime', options: [] }
    await act(async () => { view = renderElement(createElement(PropertyValueEditor, { property: created, value: '', members: [], disabled: true, onChange: vi.fn(), card })) })
    expect(view.container.textContent).toBe(new Date(card.createAt).toLocaleDateString())
    expect(view.container.textContent).not.toBe('—')
  })
})

describe('naming people instead of printing their ids', () => {
  const members = [{ boardId: 'b1', userId: '01alice', role: 'admin' as const, createdAt: 1, updatedAt: 1 }]
  const people = { '01alice': { id: '01alice', name: 'Ada', avatarUrl: '' } }
  const person: ProjectProperty = { id: 'pp', name: 'Assignee', type: 'person', options: [] }

  async function openPicker(props: Record<string, unknown>): Promise<void> {
    await act(async () => { view = renderElement(createElement(PropertyValueEditor, { property: person, value: '', members, people, disabled: false, onChange: vi.fn(), ...props })) })
    await act(async () => { view.container.querySelector<HTMLButtonElement>('button[aria-label="Assignee"]')!.click() })
  }

  function rowNamed(name: string): HTMLElement | undefined {
    return [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"], [role="menuitem"]')].find((node) => node.textContent?.includes(name))
  }

  it('offers the account name and files the id behind it', async () => {
    const onChange = vi.fn()
    await openPicker({ onChange })
    const row = rowNamed('Ada')
    expect(row, 'the picker still lists raw user ids').toBeDefined()
    expect(row!.textContent).not.toContain('01alice')
    await act(async () => { row!.click() })
    expect(onChange).toHaveBeenCalledWith('01alice')
  })

  it('offers the reader even when the roster does not list them', async () => {
    session.user = { id: '01me', name: 'Me', avatarUrl: '' }
    await openPicker({})
    expect(rowNamed('Me'), 'an editor on an open board cannot assign themselves').toBeDefined()
    expect(rowNamed('Ada')).toBeDefined()
  })

  it('names the author on a server-stamped column', async () => {
    const card: ProjectCard = { id: 'c1', boardId: 'b1', parentId: '', title: 'T', icon: '', isTemplate: false, contentOrder: [], values: {}, createdBy: '01alice', modifiedBy: '01alice', createAt: 1, updateAt: 1, deleteAt: 0 }
    const stamped: ProjectProperty = { id: 'pcb', name: 'Created by', type: 'createdBy', options: [] }
    await act(async () => { view = renderElement(createElement(PropertyValueEditor, { property: stamped, value: '', members: [], people, disabled: true, onChange: vi.fn(), card })) })
    expect(view.container.textContent).toBe('Ada')
  })
})
