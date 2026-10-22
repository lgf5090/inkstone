/**
 * The week axis's arithmetic, and what the editor opens with after a selection.
 *
 * The slot mapping is pinned here rather than in a browser because a slot one position off is
 * exactly the kind of error a screenshot forgives — the axis still looks like a day, it just files
 * the task half an hour from where the reader pressed. The seeding cases pin the other half of the
 * same gesture: the selection the drag produced has to arrive in the editor as clock times, not as
 * an instant the reader never typed. The file runs in the suite's jsdom project because the editor
 * module reads the locale off the document when it loads; the arithmetic itself touches no DOM.
 */
import { expect, it } from 'vitest'
import {
  HOUR_H,
  minuteForSlot,
  minuteFromPointer,
  selectionFromDrag,
  slotCountFor,
  slotHeightFor,
  snapMinute,
  timeBlocksForDay,
} from '../src/client/features/todos/calendar-layout'
import { seedStartText } from '../src/client/features/todos/TaskEditor'
import type { TodoTask } from '../src/shared/todos/model'

it('divides the same day into 24 hourly or 48 half-hourly slots', () => {
  expect(slotCountFor('hour')).toBe(24)
  expect(slotCountFor('half')).toBe(48)
})

it('names each slot by the minute of midnight it stands for', () => {
  expect(minuteForSlot('hour', 0)).toBe(0)
  expect(minuteForSlot('hour', 1)).toBe(60)
  expect(minuteForSlot('hour', 23)).toBe(1380)
  expect(minuteForSlot('half', 0)).toBe(0)
  expect(minuteForSlot('half', 1)).toBe(30)
  expect(minuteForSlot('half', 47)).toBe(1410)
})

it('keeps the column a fixed 24 hours tall whatever the granularity', () => {
  expect(slotHeightFor('hour')).toBe(HOUR_H)
  expect(slotHeightFor('half')).toBe(HOUR_H / 2)
  expect(24 * slotHeightFor('hour')).toBe(24 * HOUR_H)
  expect(48 * slotHeightFor('half')).toBe(24 * HOUR_H)
})

it('snaps a minute down to the granularity, midnight included', () => {
  expect([0, 29, 30, 31, 59, 60].map((minute) => snapMinute(minute, 'hour'))).toEqual([0, 0, 0, 0, 0, 60])
  expect([0, 29, 30, 31, 59, 60].map((minute) => snapMinute(minute, 'half'))).toEqual([0, 0, 30, 30, 30, 60])
})

it('reads a pointer position as the minute of the day it falls on, clamped to the day', () => {
  const height = 24 * HOUR_H
  expect(minuteFromPointer(0, height)).toBe(0)
  expect(minuteFromPointer(height / 2, height)).toBe(720)
  expect(minuteFromPointer(height, height)).toBe(1439)
  expect(minuteFromPointer(-20, height)).toBe(0)
  expect(minuteFromPointer(height * 2, height)).toBe(1439)
  expect(minuteFromPointer(100, 0)).toBe(0)
})

it('makes the earlier end the start, and floors a thin drag at half an hour', () => {
  expect(selectionFromDrag({ zoom: 'hour', fromMinute: 600, toMinute: 540 })).toEqual({ startMinute: 540, endMinute: 600 })
  expect(selectionFromDrag({ zoom: 'hour', fromMinute: 555, toMinute: 558 })).toEqual({ startMinute: 540, endMinute: 570 })
  expect(selectionFromDrag({ zoom: 'half', fromMinute: 540, toMinute: 541 })).toEqual({ startMinute: 540, endMinute: 570 })
  expect(selectionFromDrag({ zoom: 'half', fromMinute: 545, toMinute: 632 })).toEqual({ startMinute: 540, endMinute: 630 })
})

it('refuses a drag that leaves the day rather than creating past midnight', () => {
  expect(selectionFromDrag({ zoom: 'half', fromMinute: 1410, toMinute: 1415 })).toBeNull()
  expect(selectionFromDrag({ zoom: 'hour', fromMinute: -1, toMinute: 60 })).toBeNull()
  expect(selectionFromDrag({ zoom: 'hour', fromMinute: 1380, toMinute: 1439 })).toEqual({ startMinute: 1380, endMinute: 1410 })
})

it('places a timed block by minutes, a formula the granularity never enters', () => {
  // 09:00–10:30 UTC on the day the block belongs to: where it draws is decided by the task's own
  // clock, so dividing the axis more finely moves no block.
  const task = {
    id: 'task1',
    status: 'todo',
    dueAt: Date.parse('2026-10-20T10:30:00Z'),
    startAt: Date.parse('2026-10-20T09:00:00Z'),
  } as unknown as TodoTask
  const blocks = timeBlocksForDay([task], '2026-10-20', 'UTC')
  expect(blocks).toHaveLength(1)
  expect(blocks[0]!.startMin).toBe(540)
  expect(blocks[0]!.endMin).toBe(630)
})

it('seeds the start field from a draft clock string as written', () => {
  expect(seedStartText({ startAt: '2026-10-20T09:00' }, null, 'Asia/Shanghai')).toBe('2026-10-20T09:00')
})

it('seeds the start field from a draft instant as the account zone reads it', () => {
  expect(seedStartText({ startAt: Date.parse('2026-10-20T09:00:00Z') }, null, 'UTC')).toBe('2026-10-20T09:00')
})

it('seeds the start field empty when neither the task nor the draft names a start', () => {
  expect(seedStartText({}, null, 'UTC')).toBe('')
  expect(seedStartText({ startAt: null }, null, 'UTC')).toBe('')
})

it('seeds the start field from an existing task over any draft', () => {
  const task = { startAt: Date.parse('2026-10-20T09:00:00Z') }
  expect(seedStartText({ startAt: '2026-10-20T08:00' }, task, 'UTC')).toBe('2026-10-20T09:00')
})
