// @vitest-environment jsdom
import { act, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { Input } from '../src/client/components/form'
import { IconButton } from '../src/client/components/primitives'

installTestGlobals()

afterEach(() => {
  document.body.innerHTML = ''
})

function SearchHarness() {
  const [value, setValue] = useState('')
  return (
    <Input
      type="search"
      aria-label="搜索"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      trailing={value
        ? <IconButton label="清空" size="sm" onClick={() => setValue('')}>x</IconButton>
        : undefined}
    />
  )
}

describe('Input keeps one search field across value changes', () => {
  it('does not remount the field when the trailing control appears', async () => {
    const view = renderElement(<SearchHarness />)
    const field = view.container.querySelector('input')!
    field.focus()
    await act(async () => {
      field.value = 'a'
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const after = view.container.querySelector('input')!
    expect(after).toBe(field)
    expect(document.activeElement).toBe(after)
    expect(view.container.querySelectorAll('input')).toHaveLength(1)
    view.unmount()
  })

  it('hides the native search clear control when it draws its own', () => {
    const view = renderElement(
      <Input type="search" aria-label="搜索" value="a" onChange={() => undefined} trailing={<span>x</span>} />,
    )
    const field = view.container.querySelector('input')!
    expect(field.type).toBe('search')
    expect(field.className).toContain('::-webkit-search-cancel-button')
    expect(field.className).toContain('::-webkit-search-results-button')
    view.unmount()
  })
})
