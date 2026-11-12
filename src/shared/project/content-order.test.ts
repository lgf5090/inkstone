import { describe, expect, it } from 'vitest'
import { appendContentOrder, moveContentOrder, removeContentOrder } from './content-order'

describe('appending to the reading order', () => {
  it('adds a new id at the end and never duplicates one already present', () => {
    expect(appendContentOrder(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
    expect(appendContentOrder(['a', 'b'], 'a')).toEqual(['a', 'b'])
  })
})

describe('removing from the reading order', () => {
  it('scrubs a top-level id and an id inside a thread, dropping emptied threads', () => {
    expect(removeContentOrder(['a', ['t1', 't2'], 'b'], 'a')).toEqual([['t1', 't2'], 'b'])
    expect(removeContentOrder(['a', ['t1', 't2'], 'b'], 't1')).toEqual(['a', ['t2'], 'b'])
    expect(removeContentOrder(['a', ['t1'], 'b'], 't1')).toEqual(['a', 'b'])
    expect(removeContentOrder(['a', 'b'], 'absent')).toEqual(['a', 'b'])
  })
})

describe('moving a block', () => {
  it('splices before or after the target without duplicating the moved id', () => {
    expect(moveContentOrder(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    expect(moveContentOrder(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a'])
    expect(moveContentOrder(['a', 'b', 'c'], 'b', 'a', 'after')).toEqual(['a', 'b', 'c'])
  })

  it('leaves the block at the end when the target is not a top-level entry', () => {
    expect(moveContentOrder(['a', ['t1'], 'b'], 'a', 't1', 'before')).toEqual([['t1'], 'b', 'a'])
  })
})