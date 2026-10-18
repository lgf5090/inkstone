// @vitest-environment jsdom
/**
 * Finding a phrase in the thread.
 *
 * The marks are the whole feature, and they are also the only thing here that can damage a page: a pass
 * that misses a node leaves the reader scrolling a transcript that no longer holds their words, and a
 * pass that nests its own marks makes the second press match the first press's leftovers. Both are
 * pinned here, along with the code block a reader most often searches for.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_FIND_HITS, clearFindMarks, focusFindHit, markFindHits } from './thread-find'

let host: HTMLElement

function thread(html: string): HTMLElement {
  host.innerHTML = html
  return host
}

/** The marks one pass left behind; the ceiling is pinned separately, where it is the subject. */
const found = (root: HTMLElement, query: string): HTMLElement[] => markFindHits(root, query).marks

const hits = () => [...host.querySelectorAll('[data-find-hit]')].map((mark) => mark.textContent)

beforeEach(() => {
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)
})

describe('marking what the reader searched for', () => {
  it('finds every occurrence, whatever the case, and leaves the words intact', () => {
    const root = thread('<p>The plan, the PLAN and the plan again.</p>')
    expect(found(root, 'plan')).toHaveLength(3)
    expect(root.textContent).toBe('The plan, the PLAN and the plan again.')
    expect(hits()).toEqual(['plan', 'PLAN', 'plan'])
  })

  it('finds text inside a code block, which is what a reader hunts for most', () => {
    const root = thread('<pre><code>const answer = 42</code></pre><p>answer is 42</p>')
    expect(found(root, 'answer')).toHaveLength(2)
    expect(found(root, '42')).toHaveLength(2)
  })

  it('matches each word only once when the same search runs twice', () => {
    const root = thread('<p>plan and plan</p>')
    markFindHits(root, 'plan')
    expect(found(root, 'plan')).toHaveLength(2)
    expect(hits()).toEqual(['plan', 'plan'])
  })

  it('takes every mark back out, merging the text it split', () => {
    const root = thread('<p>a plan here</p>')
    markFindHits(root, 'plan')
    clearFindMarks(root)
    expect(host.querySelectorAll('[data-find-hit]')).toHaveLength(0)
    expect(root.textContent).toBe('a plan here')
    expect(root.querySelector('p')?.childNodes).toHaveLength(1)
  })

  it('keeps the markup the answer was written with', () => {
    const root = thread('<p><strong>plan</strong> and <a href="#">plan</a></p>')
    markFindHits(root, 'plan')
    expect(root.querySelectorAll('strong mark')).toHaveLength(1)
    expect(root.querySelectorAll('a mark')).toHaveLength(1)
  })

  it('finds nothing for a query that is only spaces', () => {
    const root = thread('<p>plan</p>')
    expect(markFindHits(root, '   ')).toEqual({ marks: [], truncated: false })
    expect(hits()).toEqual([])
  })

  it('reads the phrase as literal text, the way the server reads a LIKE it escaped', () => {
    // `%`, `_` and `.` are characters in the reader's phrase, not operators: the conversation search the
    // store runs escapes the wildcards, and the app has no regex path for a body.
    const root = thread('<p>abc a% a_b 演示模式</p>')
    expect(found(root, 'a.c')).toHaveLength(0)
    expect(found(root, 'a%')).toHaveLength(1)
    expect(found(root, 'a_b')).toHaveLength(1)
    expect(found(root, 'ysms')).toHaveLength(0)
    expect(found(root, '演示模式')).toHaveLength(1)
  })

  it('marks up to its ceiling and then says it stopped', () => {
    const root = thread(`<p>${'plan '.repeat(MAX_FIND_HITS + 20)}</p>`)
    const result = markFindHits(root, 'plan')
    expect(result.marks).toHaveLength(MAX_FIND_HITS)
    expect(result.truncated, 'a count that stopped is reported as the total').toBe(true)
    // Under the ceiling the same answer has to say nothing: a ceiling mentioned for 3 hits is noise.
    expect(markFindHits(thread('<p>plan and plan</p>'), 'plan')).toEqual({ marks: expect.any(Array), truncated: false })
  })

  it('calls a page that holds exactly the ceiling a whole search', () => {
    const root = thread(`<p>${'plan '.repeat(MAX_FIND_HITS)}</p>`)
    const result = markFindHits(root, 'plan')
    expect(result.marks).toHaveLength(MAX_FIND_HITS)
    expect(result.truncated, 'nothing was left behind, so the count is the total').toBe(false)
  })
})

describe('stepping through the hits', () => {
  it('marks the one the count points at', () => {
    const root = thread('<p>plan</p><p>plan</p><p>plan</p>')
    const marks = found(root, 'plan')
    focusFindHit(marks, 1, null)
    expect(marks.map((mark) => mark.classList.contains('is-current'))).toEqual([false, true, false])
    focusFindHit(marks, 2, null)
    expect(marks.map((mark) => mark.classList.contains('is-current'))).toEqual([false, false, true])
  })

  it('survives an index that is past the end', () => {
    const marks = found(thread('<p>plan</p>'), 'plan')
    expect(() => focusFindHit(marks, 5, null)).not.toThrow()
  })
})
