// @vitest-environment node
/**
 * The week axis's arithmetic: which slots exist at each granularity, and what a drag across one
 * column selects.
 *
 * The slot mapping is pinned here rather than in a browser because a slot one position off is
 * exactly the kind of error a screenshot forgives — the axis still looks like a day, it just files
 * the task half an hour from where the reader pressed.
 */
import { expect, it } from 'vitest'
import {
  HOUR_H,
  minuteForSlot,
  slotCountFor,
  slotHeightFor,
} from '../src/client/features/todos/calendar-layout'

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
