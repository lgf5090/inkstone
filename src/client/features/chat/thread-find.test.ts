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
import { clearFindMarks, focusFindHit, markFindHits } from './thread-find'

let host: HTMLElement

function thread(html: string): HTMLElement {
  host.innerHTML = html
  return host
}

const hits = () => [...host.querySelectorAll('[data-find-hit]')].map((mark) => mark.textContent)

beforeEach(() => {
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)
})

describe('marking what the reader searched for', () => {
  it('finds every occurrence, whatever the case, and leaves the words intact', () => {
    const root = thread('<p>The plan, the PLAN and the plan again.</p>')
    expect(markFindHits(root, 'plan')).toHaveLength(3)
    expect(root.textContent).toBe('The plan, the PLAN and the plan again.')
    expect(hits()).toEqual(['plan', 'PLAN', 'plan'])
  })

  it('finds text inside a code block, which is what a reader hunts for most', () => {
    const root = thread('<pre><code>const answer = 42</code></pre><p>answer is 42</p>')
    expect(markFindHits(root, 'answer')).toHaveLength(2)
    expect(markFindHits(root, '42')).toHaveLength(2)
  })

  it('matches each word only once when the same search runs twice', () => {
    const root = thread('<p>plan and plan</p>')
    markFindHits(root, 'plan')
    expect(markFindHits(root, 'plan')).toHaveLength(2)
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
    expect(markFindHits(root, '   ')).toEqual([])
    expect(hits()).toEqual([])
  })
})

describe('stepping through the hits', () => {
  it('marks the one the count points at', () => {
    const root = thread('<p>plan</p><p>plan</p><p>plan</p>')
    const marks = markFindHits(root, 'plan')
    focusFindHit(marks, 1, null)
    expect(marks.map((mark) => mark.classList.contains('is-current'))).toEqual([false, true, false])
    focusFindHit(marks, 2, null)
    expect(marks.map((mark) => mark.classList.contains('is-current'))).toEqual([false, false, true])
  })

  it('survives an index that is past the end', () => {
    const marks = markFindHits(thread('<p>plan</p>'), 'plan')
    expect(() => focusFindHit(marks, 5, null)).not.toThrow()
  })
})
