/**
 * `useFilterInput` is the keyboard contract behind every filter box in the app, so the cases here are
 * about the contract rather than about a box's chrome: what Escape costs, what the box swallows, and —
 * the reason these cases exist — what an input method gets answered. A reader typing Chinese builds a
 * word one syllable at a time and presses Escape to throw the unfinished syllable away; a box that read
 * the same Escape as "clear the search" took the whole query with it, and nothing on the screen said so.
 */
import { act, createElement, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderElement } from '../lib/test-render'
import { compileQuery } from '../lib/query-match'
import { FilterInput } from './FilterInput'

function field(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')
  if (!input) throw new Error('FilterInput drew no search field')
  return input
}

/**
 * A keydown as the browser writes it. `composing` marks the event as arriving inside an input-method
 * composition, which is what a pinyin reader's Escape, arrows and Enter all are; jsdom is asked for it
 * through `init` and, where a jsdom build drops the member, pressed onto the event directly.
 */
function press(input: HTMLInputElement, key: string, composing = false): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true })
  if (composing && event.isComposing !== true) Object.defineProperty(event, 'isComposing', { value: true })
  act(() => {
    input.dispatchEvent(event)
  })
}

function render(props: {
  value: string
  onChange?: (next: string) => void
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  escapeWhenEmpty?: 'blur' | 'release'
} = { value: '' }) {
  const onChange = props.onChange ?? vi.fn()
  const rendered = renderElement(createElement(FilterInput, {
    value: props.value,
    onChange,
    query: compileQuery(props.value),
    label: 'Filter',
    escapeWhenEmpty: props.escapeWhenEmpty,
    onKeyDown: props.onKeyDown,
  }))
  return { ...rendered, input: field(rendered.container), onChange }
}

describe('FilterInput Escape', () => {
  it('takes the text back out and keeps the box', () => {
    const { input, onChange } = render({ value: 'pi' })
    press(input, 'Escape')
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('hands a second, empty Escape to nothing but the box, which loses focus', () => {
    const { input, onChange } = render({ value: '' })
    input.focus()
    press(input, 'Escape')
    expect(onChange).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(input)
  })

  it('leaves an empty Escape to the panel behind it when told to release', () => {
    const { input } = render({ value: '', escapeWhenEmpty: 'release' })
    input.focus()
    press(input, 'Escape')
    expect(document.activeElement).toBe(input)
  })
})

describe('FilterInput during an input-method composition', () => {
  it('does not clear the query when Escape cancels the syllable', () => {
    // The regression: a pinyin syllable was on the way into the box, Escape was thrown to drop the
    // candidate strip, and the whole search box went with the syllable.
    const { input, onChange } = render({ value: 'ceshi' })
    press(input, 'Escape', true)
    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe('ceshi')
  })

  it('does not blur the box on an Escape that only ends the composition', () => {
    const { input, onChange } = render({ value: '' })
    input.focus()
    press(input, 'Escape', true)
    expect(onChange).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
  })

  it('leaves the listing’s own arrows and Enter to the candidate strip', () => {
    const onKeyDown = vi.fn()
    const { input } = render({ value: 'ceshi', onKeyDown })
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) press(input, key, true)
    expect(onKeyDown).not.toHaveBeenCalled()
  })

  it('still answers the listing’s keys once the composition is off', () => {
    const onKeyDown = vi.fn()
    const { input } = render({ value: 'ceshi', onKeyDown })
    press(input, 'ArrowDown', true)
    press(input, 'ArrowDown')
    expect(onKeyDown).toHaveBeenCalledTimes(1)
  })
})
