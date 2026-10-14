import { act, createElement, useState, type ChangeEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedDraft } from './hooks'
import { installTestGlobals } from './test-render'

const DELAY = 200

afterEach(() => {
  vi.useRealTimers()
})

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * The box on its own, with a caller that answers only when the test tells it to.
 *
 * `echoArrives` is the reason these cases exist: a real commit does not come back on the tick it
 * leaves. `ChatView` writes its query into a store that then loads conversations from the server, and
 * the kanban box writes into a board whose view state is applied by its parent, so in both the
 * committed text returns as a fresh external value some renders later — and a draft overwritten by that
 * return is a box that eats whatever the reader typed in the meantime.
 */
function mountDraftProbe(initial = '') {
  installTestGlobals()
  const commits: string[] = []
  let held: string | null = null
  let publish = (value: string) => { void value }

  function Probe() {
    const [external, setExternal] = useState(initial)
    publish = setExternal
    const { draft, setDraft } = useDebouncedDraft(external, (next) => {
      commits.push(next)
      held = next
    }, DELAY)
    return createElement('input', {
      value: draft,
      onChange: (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    })
  }

  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(Probe)) })

  return {
    input: container.querySelector('input')!,
    commits,
    echoArrives: () => {
      const value = held
      held = null
      act(() => { publish(value!) })
    },
    setExternal: (value: string) => { act(() => { publish(value) }) },
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

describe('useDebouncedDraft', () => {
  it('keeps what was typed while its own commit was on the way back', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { input, commits, echoArrives, unmount } = mountDraftProbe('')

    act(() => { typeInto(input, 'a') })
    expect(commits).toEqual([])
    act(() => { vi.advanceTimersByTime(DELAY) })
    expect(commits).toEqual(['a'])

    act(() => { typeInto(input, 'ab') })
    echoArrives()
    expect(input.value, 'the echo of the commit replaced the character typed after it').toBe('ab')

    act(() => { vi.advanceTimersByTime(DELAY) })
    expect(commits, 'the settled draft never reached the caller').toEqual(['a', 'ab'])
    echoArrives()
    expect(input.value).toBe('ab')
    unmount()
  })

  it('adopts a query the box never committed, from a view switch or another panel', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { input, commits, setExternal, unmount } = mountDraftProbe('')
    act(() => { typeInto(input, 'typed') })
    act(() => { vi.advanceTimersByTime(DELAY) })
    expect(commits).toEqual(['typed'])

    setExternal('elsewhere')
    expect(input.value, 'a query set elsewhere lost to the draft').toBe('elsewhere')
    unmount()
  })

  it('hands one settled value over once, while the caller has not answered at all', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { input, commits, unmount } = mountDraftProbe('')
    act(() => { typeInto(input, 'ab') })
    act(() => { vi.advanceTimersByTime(DELAY * 3) })
    expect(commits, 'the same text was committed once per render').toEqual(['ab'])
    unmount()
  })

  it('commits the query back to empty when the reader clears the box', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { input, commits, echoArrives, unmount } = mountDraftProbe('')
    act(() => { typeInto(input, 'a') })
    act(() => { vi.advanceTimersByTime(DELAY) })
    echoArrives()
    act(() => { typeInto(input, '') })
    act(() => { vi.advanceTimersByTime(DELAY) })
    expect(commits, 'a box taken back to empty never said so').toEqual(['a', ''])
    echoArrives()
    expect(input.value).toBe('')
    unmount()
  })
})
