// @vitest-environment jsdom
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { renderElement } from '../src/client/lib/test-render'
import { useWindowedRows } from '../src/client/features/development/github/lib/use-windowed-rows'

function Probe({ items }: { items: number[] }) {
  const { visibleItems, remaining, showMore, onScroll } = useWindowedRows(items, 3, 2)
  return (
    <div>
      <span data-testid="count">{visibleItems.length}</span>
      <span data-testid="remaining">{remaining}</span>
      <span data-testid="last">{visibleItems[visibleItems.length - 1]}</span>
      <button type="button" onClick={showMore}>more</button>
      <div data-testid="scroller" onScroll={onScroll} />
    </div>
  )
}

function scrollToEnd(container: HTMLElement): void {
  const node = container.querySelector<HTMLElement>('[data-testid="scroller"]')!
  Object.defineProperties(node, {
    scrollTop: { value: 450, configurable: true },
    clientHeight: { value: 100, configurable: true },
    scrollHeight: { value: 900, configurable: true },
  })
  act(() => { node.dispatchEvent(new Event('scroll')) })
}

describe('GitHub windowed rows', () => {
  it('mounts only the first window and grows on demand', () => {
    const rendered = renderElement(<Probe items={[1, 2, 3, 4, 5, 6, 7]} />)
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('3')
    expect(rendered.container.querySelector('[data-testid="remaining"]')?.textContent).toBe('4')
    act(() => { rendered.container.querySelector('button')!.click() })
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('5')
    expect(rendered.container.querySelector('[data-testid="last"]')?.textContent).toBe('5')
    rendered.unmount()
  })

  it('grows when the reader reaches the end of the scroller', () => {
    const rendered = renderElement(<Probe items={[1, 2, 3, 4, 5, 6]} />)
    scrollToEnd(rendered.container)
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('5')
    rendered.unmount()
  })

  it('never exceeds the item count and resets when the list changes', () => {
    const rendered = renderElement(<Probe items={[1, 2, 3, 4]} />)
    for (let index = 0; index < 5; index += 1) {
      act(() => { rendered.container.querySelector('button')!.click() })
    }
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('4')
    expect(rendered.container.querySelector('[data-testid="remaining"]')?.textContent).toBe('0')
    rendered.unmount()
  })
})
