import { describe, expect, it } from 'vitest'
import { TaskRegularExpressions as RE } from './task-regular-expressions'
import { OnCompletion, parseOnCompletionValue } from './on-completion'
import { PRIORITY_NAMES, Priority, priorityFromName } from './priority'

function parts(line: string): { indent: string, marker: string, status: string, body: string } | null {
  const matched = RE.taskRegex.exec(line)
  if (!matched) return null
  return { indent: matched[1]!, marker: matched[2]!, status: matched[3]!, body: matched[4]! }
}

describe('task line shapes', () => {
  it('reads indentation, marker, status and body apart', () => {
    expect(parts('- [ ] write the plan')).toEqual({ indent: '', marker: '-', status: ' ', body: 'write the plan' })
    expect(parts('  * [x] done one')).toEqual({ indent: '  ', marker: '*', status: 'x', body: 'done one' })
    expect(parts('> - [/] in flight')).toEqual({ indent: '> ', marker: '-', status: '/', body: 'in flight' })
    expect(parts('12. [h] on hold')).toEqual({ indent: '', marker: '12.', status: 'h', body: 'on hold' })
  })

  it('refuses a line with no checkbox or no marker', () => {
    expect(RE.taskRegex.test('- [] no status character')).toBe(false)
    expect(RE.taskRegex.test('just a sentence')).toBe(false)
    expect(RE.taskRegex.test('  - not a task')).toBe(false)
  })

  it('accepts a bare list item only through the lenient regex', () => {
    expect(RE.taskRegex.test('- plain item')).toBe(false)
    const matched = RE.nonTaskRegex.exec('- plain item')
    expect(matched?.[2]).toBe('-')
    expect(matched?.[4]).toBeUndefined()
    expect(matched?.[matched.length - 1]).toBe('plain item')
  })

  it('keeps a block id out of the body it matches but recognises it separately', () => {
    const body = parts('- [ ] anchored ^my-precious')!.body
    expect(body).toBe('anchored ^my-precious')
    expect(RE.blockLinkRegex.test(body)).toBe(true)
    expect(RE.blockLinkRegex.test('anchored ^not this one')).toBe(false)
  })
})

describe('hashtags', () => {
  it('takes only space-preceded hashes, so URLs survive', () => {
    const found = '#dog #car http://www/ddd#ere #house'.match(RE.hashTags)
    expect(found).toEqual(['#dog', ' #car', ' #house'])
  })

  it('stops a tag at punctuation that ends a sentence or closes a link', () => {
    expect('fix #tag, then #other.'.match(RE.hashTags)?.map((tag) => tag.trim())).toEqual(['#tag', '#other'])
    expect('see [#link](x) not #tag'.match(RE.hashTags)?.map((tag) => tag.trim())).toEqual(['#tag'])
  })

  it('is stateful as a global pattern, so callers must match rather than test', () => {
    const line = '#a #b'
    expect(line.match(RE.hashTags)).toHaveLength(2)
    expect(line.match(RE.hashTags)).toHaveLength(2)
  })
})

describe('priority', () => {
  it('orders low after none so unmarked tasks lead', () => {
    expect(Number(Priority.Low)).toBeGreaterThan(Number(Priority.None))
    expect(PRIORITY_NAMES[Priority.Highest]).toBe('highest')
  })

  it('reads a name back case-insensitively and rejects an unknown one', () => {
    expect(priorityFromName('  HIGH ')).toBe(Priority.High)
    expect(priorityFromName('urgent')).toBeNull()
  })
})

describe('on completion', () => {
  it('keeps the unwritten default invisible', () => {
    expect(OnCompletion.Ignore).toBe('')
    expect(parseOnCompletionValue('DELETE')).toBe(OnCompletion.Delete)
    expect(parseOnCompletionValue(' keep ')).toBe(OnCompletion.Keep)
    expect(parseOnCompletionValue('whatever')).toBe(OnCompletion.Ignore)
  })
})
