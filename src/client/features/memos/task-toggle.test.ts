import { describe, expect, it } from 'vitest'
import { findMemoTasks, toggleMemoTask } from './task-toggle'

const SAMPLE = [
  '# Tasks',
  '',
  '- [ ] first',
  '- [x] second',
  '',
  '```md',
  '- [ ] fenced',
  '```',
  '',
  '1. [/] third',
].join('\n')

describe('the memo task parser', () => {
  it('finds the task markers outside code fences', () => {
    const tasks = findMemoTasks(SAMPLE)
    expect(tasks.map((task) => task.index)).toEqual([0, 1, 2])
    expect(tasks.map((task) => task.line)).toEqual([2, 3, 9])
    expect(tasks.map((task) => task.checked)).toEqual([false, true, true])
    expect(SAMPLE[tasks[0]!.offset]).toBe(' ')
    expect(SAMPLE[tasks[1]!.offset]).toBe('x')
    expect(SAMPLE[tasks[2]!.offset]).toBe('/')
  })

  it('ignores task-like lines inside blockquote fences', () => {
    const content = [
      '> ```',
      '> - [ ] quoted code',
      '> ```',
      '- [ ] real',
    ].join('\n')
    const tasks = findMemoTasks(content)
    expect(tasks).toHaveLength(1)
    expect(content.slice(tasks[0]!.offset - 1, tasks[0]!.offset + 2)).toBe('[ ]')
  })

  it('toggles an unchecked task by its index', () => {
    expect(toggleMemoTask(SAMPLE, 0)).toBe(SAMPLE.replace('- [ ] first', '- [x] first'))
  })

  it('unchecks checked and alternate statuses', () => {
    expect(toggleMemoTask(SAMPLE, 1)).toBe(SAMPLE.replace('- [x] second', '- [ ] second'))
    expect(toggleMemoTask(SAMPLE, 2)).toBe(SAMPLE.replace('1. [/] third', '1. [ ] third'))
  })

  it('keeps the line endings of the source', () => {
    const content = '- [ ] one\r\n- [x] two'
    expect(toggleMemoTask(content, 0)).toBe('- [x] one\r\n- [x] two')
  })

  it('returns null for an index that is not a task', () => {
    expect(toggleMemoTask(SAMPLE, 99)).toBeNull()
    expect(toggleMemoTask('no tasks here', 0)).toBeNull()
  })
})
